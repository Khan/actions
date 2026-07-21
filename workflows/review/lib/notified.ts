/**
 * Gerald `.github/NOTIFIED` handling for the review pipeline.
 *
 * `.github/NOTIFIED` is the Khan/Gerald file that names people and teams who
 * want to be pinged when a PR touches files (or introduces diff content) they
 * care about — distinct from `.github/REVIEWERS`, which the router already
 * parses to assign *reviewer* ownership. This module ports the NOTIFIED half:
 * it parses the file, matches its rules against the PR under review, and
 * renders the matched notifications as a Markdown block the orchestrator drops
 * into the Review Guidance comment (review.md Step 7). No GitHub calls happen
 * here; it is a pure function of the NOTIFIED text plus the staged diff, so the
 * notification set is deterministic and unit-testable.
 *
 * ## The file format (Gerald, faithful subset)
 *
 * Everything up to and including the `----Everything above this line will be
 * ignored!----` marker is documentation and is discarded. Below it the file is
 * split into sections by `[SECTION]` header lines; only the
 * `[ON PULL REQUEST]` section applies to a PR review (the
 * `[ON PUSH WITHOUT PULL REQUEST]` section is for direct-to-branch pushes and
 * is ignored). Within that section, blank lines and `#` comments are skipped
 * and every other line is a rule:
 *
 *     [label:] <pattern>  @user1 @Org/team2   [# trailing comment]
 *
 * - An optional `label:` prefix names the rule; Gerald surfaces it in the PR
 *   info, and this port carries it into the comment so a notified person can
 *   see *why* they were pinged. A rule with no label falls back to displaying
 *   its pattern.
 * - `<pattern>` is either a **path glob** (matched against each changed file's
 *   path) or a **quoted diff regex** `"/body/flags"` (matched against each
 *   changed file's unified-diff text — this is how a rule fires on *added*
 *   content, e.g. `"/^\+(?!\+).*\bMergedGetAll\b/m"`). A file is reported for a
 *   regex rule when that file's diff matches.
 * - The remaining `@`-prefixed tokens are the people/teams to notify, verbatim
 *   (a trailing `!`, the REVIEWERS "required" marker, is dropped defensively).
 *
 * The glob dialect is a practical subset of the micromatch dialect Gerald uses,
 * not a faithful reimplementation of it: `**` (crosses `/`), `*` and `?`
 * (within a segment), `{a,b,c}` brace alternation, `[…]` character classes
 * (ranges and POSIX classes), `(a|b)` groups, and the `?(…) *(…) +(…) @(…)`
 * extglobs. Patterns are anchored at the repo root, so a leading
 * globstar-plus-slash is written explicitly to match at any depth (matching
 * Gerald, not the router's basename-anywhere gitattributes convention). Two
 * deliberate divergences from real micromatch: wildcards here match dotfiles
 * (micromatch defaults `dot:false`), and `!(…)` negation is unsupported. A rule
 * that leans on either — or on any other unsupported construct — may match a
 * slightly different set than Gerald would, but it degrades toward matching and
 * never crashes the review. A malformed rule (bad regex body, unterminated
 * quote) is dropped with a warning that Step 7 surfaces as a `Note:` on the PR.
 *
 * ## Delivery note (why the mentions are raw `@` tokens)
 *
 * The rendered block emits real `@mention` tokens so GitHub notifies the
 * matched people. gh-aw's safe-output sanitizer neutralizes mentions that are
 * not allow-listed (`@user` → `` `@user` ``); repository collaborators are
 * allow-listed by default (`mentions.allow-team-members`), and the workflow can
 * widen that with `mentions.allowed` / `mentions.allowed-teams`. Re-posting the
 * guidance comment re-pings, so review.md only re-posts when the notification
 * {@link NotifiedResult.signature} changes (Step 7 idempotency).
 */

import {splitUnifiedDiff} from "./diff";

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** One parsed NOTIFIED rule from the `[ON PULL REQUEST]` section. */
export type NotifyRule = {
    /** The `label:` prefix, when the rule has one. */
    label?: string;
    /** The pattern as written (used for diagnostics and labelless display). */
    patternSource: string;
    /** Whether the pattern matches file paths (`glob`) or diff text (`regex`). */
    kind: "glob" | "regex";
    /** People/teams to notify, verbatim (`@user`, `@Org/team`). */
    mentions: string[];
};

/** The result of parsing a NOTIFIED file's `[ON PULL REQUEST]` section. */
export type ParseResult = {
    rules: NotifyRule[];
    /** Fixed-format problems (a malformed rule, a bad regex); never prose. */
    warnings: string[];
};

/** The marker below which the file is real rules, not documentation. */
const IGNORE_MARKER = "Everything above this line will be ignored";

/** The section whose rules apply to a pull-request review. */
const PR_SECTION = "[ON PULL REQUEST]";

/**
 * A genuine `[SECTION]` header line (`[ON PULL REQUEST]`, `[ON PUSH WITHOUT PULL
 * REQUEST]`, …), matched by its all-caps `[WORDS]` shape. This is deliberately
 * narrower than "starts with `[`": an unlabeled rule whose glob leads with a
 * character class (`[Dd]ockerfile`, `[1-5]`, `[[:digit:]]`) is a rule, not a
 * header, and must not end the section or be skipped.
 */
const SECTION_HEADER_RE = /^\[[A-Z][A-Z ]*\]/;
const isSectionHeader = (line: string): boolean =>
    SECTION_HEADER_RE.test(line.trim());

/**
 * Extract the lines of the `[ON PULL REQUEST]` section: everything after that
 * header (after the ignore marker, if present) up to the next `[SECTION]`
 * header or end of file. Returns an empty array when the section is absent.
 */
const prSectionLines = (content: string): string[] => {
    const allLines = content.split(/\r?\n/);

    // Drop documentation above the ignore marker, if the file has one.
    const markerIndex = allLines.findIndex((line) =>
        line.includes(IGNORE_MARKER),
    );
    const lines =
        markerIndex === -1 ? allLines : allLines.slice(markerIndex + 1);

    const start = lines.findIndex((line) =>
        line.trim().toUpperCase().startsWith(PR_SECTION),
    );
    if (start === -1) {
        return [];
    }
    const section: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (isSectionHeader(line)) {
            break; // next section header ends this one
        }
        section.push(line);
    }
    return section;
};

/** Match a `label:` prefix, e.g. `graphql-id:` (never a quoted/`@` pattern). */
const LABEL_RE = /^([A-Za-z0-9._-]+):\s+(.*)$/;

/**
 * Parse one non-blank, non-comment rule line into a {@link NotifyRule}, or
 * `null` when it carries no `@mention` (a rule that notifies nobody). A
 * malformed quoted pattern returns a warning instead.
 */
export const parseRuleLine = (
    raw: string,
): NotifyRule | {warning: string} | null => {
    let rest = raw.trim();
    if (rest === "") {
        return null;
    }

    // Optional `label:` prefix. The charset excludes `"` and `@`, so a quoted
    // regex or a bare `@mention` line never looks like a label.
    let label: string | undefined;
    const labelMatch = LABEL_RE.exec(rest);
    if (labelMatch) {
        label = labelMatch[1];
        rest = labelMatch[2] ?? "";
    }

    // Pattern: a quoted `"/re/flags"` diff regex, or the first bare token.
    let patternSource: string;
    let kind: "glob" | "regex";
    let remainder: string;
    if (rest.startsWith('"')) {
        const close = rest.indexOf('"', 1);
        if (close === -1) {
            return {warning: `unterminated quoted pattern: ${raw.trim()}`};
        }
        patternSource = rest.slice(1, close);
        // Validate the regex here so an invalid body surfaces a warning (and a
        // `Note:` on the PR) rather than being dropped silently at match time.
        if (compileDiffRegex(patternSource) === null) {
            return {warning: `invalid regex in NOTIFIED rule: ${raw.trim()}`};
        }
        remainder = rest.slice(close + 1);
        kind = "regex";
    } else {
        const match = /^(\S+)(.*)$/.exec(rest);
        if (!match) {
            return null;
        }
        patternSource = match[1] ?? "";
        remainder = match[2] ?? "";
        kind = "glob";
    }

    // Mentions: `@`-prefixed tokens up to an inline `#` comment.
    const mentions: string[] = [];
    for (const token of remainder.trim().split(/\s+/)) {
        if (token === "") {
            continue;
        }
        if (token.startsWith("#")) {
            break; // trailing comment
        }
        if (token.startsWith("@")) {
            // Drop a trailing `!` (the REVIEWERS "required" marker).
            mentions.push(token.endsWith("!") ? token.slice(0, -1) : token);
        }
    }
    if (mentions.length === 0) {
        return null;
    }

    return {
        ...(label !== undefined ? {label} : {}),
        patternSource,
        kind,
        mentions,
    };
};

/** Parse a NOTIFIED file's `[ON PULL REQUEST]` rules. Pure. */
export const parseNotified = (content: string): ParseResult => {
    const rules: NotifyRule[] = [];
    const warnings: string[] = [];
    for (const rawLine of prSectionLines(content)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#") || isSectionHeader(line)) {
            continue;
        }
        const parsed = parseRuleLine(line);
        if (parsed === null) {
            continue;
        }
        if ("warning" in parsed) {
            warnings.push(parsed.warning);
            continue;
        }
        rules.push(parsed);
    }
    return {rules, warnings};
};

/* -------------------------------------------------------------------------- */
/* Glob matching (self-contained micromatch subset; anchored at repo root)    */
/* -------------------------------------------------------------------------- */

/** POSIX bracket classes → their JS character-class range equivalents. */
const POSIX_CLASSES: Record<string, string> = {
    alnum: "0-9A-Za-z",
    alpha: "A-Za-z",
    digit: "0-9",
    lower: "a-z",
    upper: "A-Z",
    space: "\\s",
    blank: " \\t",
    punct: "!-/:-@\\[-`{-~",
    word: "\\w",
};

/** Escape a single literal character for use outside a regex char class. */
const escapeLiteral = (ch: string): string =>
    /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;

/**
 * Read a `[…]` character class starting at `start` (where `glob[start] === "["`).
 * Returns the regex class and the index just past the closing `]`, or `null`
 * when the class is unterminated (the caller then treats `[` as a literal).
 * Translates POSIX `[:name:]` tokens and a leading `!`/`^` negation.
 */
const readCharClass = (
    glob: string,
    start: number,
): {regex: string; next: number} | null => {
    let j = start + 1;
    let negate = false;
    if (glob[j] === "!" || glob[j] === "^") {
        negate = true;
        j++;
    }
    let body = "";
    // A `]` immediately after the (optional negation of the) opener is literal.
    if (glob[j] === "]") {
        body += "\\]";
        j++;
    }
    while (j < glob.length && glob[j] !== "]") {
        if (glob[j] === "[" && glob[j + 1] === ":") {
            const end = glob.indexOf(":]", j + 2);
            if (end !== -1) {
                const name = glob.slice(j + 2, end);
                body += POSIX_CLASSES[name] ?? "";
                j = end + 2;
                continue;
            }
        }
        const ch = glob[j] ?? "";
        body += ch === "\\" ? "\\\\" : ch;
        j++;
    }
    if (j >= glob.length) {
        return null; // no closing `]`
    }
    return {regex: `[${negate ? "^" : ""}${body}]`, next: j + 1};
};

/** A pending `{`/`(`/extglob group, and how it closes in the regex. */
type GroupFrame = {type: "brace" | "group"; close: string};

/**
 * Translate a Gerald/micromatch-style glob into an anchored RegExp source (the
 * body between `^` and `$`). See the module doc for the supported dialect.
 * Malformed grouping degrades to a literal rather than throwing.
 */
export const globToRegExpSource = (glob: string): string => {
    let pattern = glob.trim();
    if (pattern.startsWith("/")) {
        pattern = pattern.slice(1); // leading slash anchors; we always anchor
    }
    let dirPrefix = false;
    if (pattern.endsWith("/")) {
        dirPrefix = true; // trailing slash: match everything beneath the dir
        pattern = pattern.slice(0, -1);
    }

    let out = "";
    const stack: GroupFrame[] = [];
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i] ?? "";
        const next = pattern[i + 1];

        if (ch === "[") {
            const cls = readCharClass(pattern, i);
            if (cls) {
                out += cls.regex;
                i = cls.next;
                continue;
            }
            out += "\\[";
            i++;
            continue;
        }
        if (ch === "*") {
            if (next === "*") {
                // `**` crosses `/`. `**/x` also matches `x` at the root.
                i += 2;
                if (pattern[i] === "/") {
                    out += "(?:.*/)?";
                    i++;
                } else {
                    out += ".*";
                }
                continue;
            }
            if (next === "(") {
                stack.push({type: "group", close: ")*"}); // `*(…)` extglob
                out += "(?:";
                i += 2;
                continue;
            }
            out += "[^/]*";
            i++;
            continue;
        }
        if (ch === "?") {
            if (next === "(") {
                stack.push({type: "group", close: ")?"}); // `?(…)` extglob
                out += "(?:";
                i += 2;
                continue;
            }
            out += "[^/]";
            i++;
            continue;
        }
        if (ch === "+" && next === "(") {
            stack.push({type: "group", close: ")+"}); // `+(…)` extglob
            out += "(?:";
            i += 2;
            continue;
        }
        if (ch === "@" && next === "(") {
            stack.push({type: "group", close: ")"}); // `@(…)` extglob (exactly one)
            out += "(?:";
            i += 2;
            continue;
        }
        if (ch === "(") {
            stack.push({type: "group", close: ")"});
            out += "(?:";
            i++;
            continue;
        }
        if (ch === "{") {
            stack.push({type: "brace", close: ")"});
            out += "(?:";
            i++;
            continue;
        }
        if (ch === ")") {
            const frame = stack[stack.length - 1];
            if (frame && frame.type === "group") {
                out += frame.close;
                stack.pop();
            } else {
                out += "\\)";
            }
            i++;
            continue;
        }
        if (ch === "}") {
            const frame = stack[stack.length - 1];
            if (frame && frame.type === "brace") {
                out += frame.close;
                stack.pop();
            } else {
                out += "\\}";
            }
            i++;
            continue;
        }
        if (ch === ",") {
            // A comma alternates inside a brace group; elsewhere it is literal.
            out += stack[stack.length - 1]?.type === "brace" ? "|" : ",";
            i++;
            continue;
        }
        if (ch === "|") {
            // Alternation is only meaningful inside a group; anchor-safe otherwise.
            out += stack.length > 0 ? "|" : "\\|";
            i++;
            continue;
        }
        if (ch === "\\") {
            // Escape: the next character is a literal.
            i++;
            if (i < pattern.length) {
                out += escapeLiteral(pattern[i] ?? "");
                i++;
            }
            continue;
        }
        out += escapeLiteral(ch);
        i++;
    }
    // Close any unterminated groups so the regex still compiles (degrade).
    while (stack.length > 0) {
        out += stack.pop()?.close ?? ")";
    }
    if (dirPrefix) {
        out += "(?:/.*)?";
    }
    return out;
};

const globCache = new Map<string, RegExp>();

/** Whether `path` matches `glob` under the dialect in {@link globToRegExpSource}. */
export const matchGlob = (path: string, glob: string): boolean => {
    let re = globCache.get(glob);
    if (re === undefined) {
        try {
            re = new RegExp(`^${globToRegExpSource(glob)}$`);
        } catch {
            re = /$.^/; // never matches; a malformed glob simply notifies no one
        }
        globCache.set(glob, re);
    }
    return re.test(path);
};

/* -------------------------------------------------------------------------- */
/* Diff-regex matching                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Compile a quoted NOTIFIED regex (`"/body/flags"`) into a RegExp, or `null`
 * when it is malformed. The `g`/`y` flags are stripped so repeated
 * {@link RegExp.test} calls stay stateless. A bare (unslashed) body compiles
 * with no flags.
 */
export const compileDiffRegex = (source: string): RegExp | null => {
    let body = source;
    let flags = "";
    if (source.startsWith("/")) {
        const lastSlash = source.lastIndexOf("/");
        if (lastSlash > 0) {
            body = source.slice(1, lastSlash);
            flags = source.slice(lastSlash + 1);
        }
    }
    const safeFlags = flags.replace(/[gy]/g, "");
    try {
        return new RegExp(body, safeFlags);
    } catch {
        return null;
    }
};

/* -------------------------------------------------------------------------- */
/* Matching rules against a PR                                                */
/* -------------------------------------------------------------------------- */

/** One `(label, files)` group under a notified mention. */
export type NotifyEntry = {label: string; files: string[]};

/** Everything a single mention is being notified about. */
export type Notification = {
    /** The `@user` / `@Org/team` token, verbatim from the file. */
    mention: string;
    /** Per-rule groups (label → the files that matched that rule). */
    entries: NotifyEntry[];
    /** Union of every file across `entries`, sorted and deduplicated. */
    files: string[];
};

/** Inputs describing the PR the rules are matched against. */
export type PrChanges = {
    /** Every changed file path (from files.json), including binaries. */
    changedPaths: string[];
    /** Per-file unified-diff text, keyed by path (from full.diff). */
    fileDiffs: Record<string, string>;
};

const sortStrings = (values: Iterable<string>): string[] =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b));

/**
 * Match parsed rules against a PR's changes. Pure: same inputs, same
 * notifications. Glob rules match changed *paths*; regex rules match a file's
 * *diff text*. Returns one {@link Notification} per matched mention, sorted, so
 * the output (and its signature) is stable across runs.
 */
export const computeNotifications = (
    rules: readonly NotifyRule[],
    changes: PrChanges,
): Notification[] => {
    // mention -> label -> set of files
    const byMention = new Map<string, Map<string, Set<string>>>();

    const record = (mention: string, label: string, file: string): void => {
        let labels = byMention.get(mention);
        if (labels === undefined) {
            labels = new Map();
            byMention.set(mention, labels);
        }
        let files = labels.get(label);
        if (files === undefined) {
            files = new Set();
            labels.set(label, files);
        }
        files.add(file);
    };

    for (const rule of rules) {
        const label = rule.label ?? rule.patternSource;
        let matchedFiles: string[];
        if (rule.kind === "glob") {
            matchedFiles = changes.changedPaths.filter((path) =>
                matchGlob(path, rule.patternSource),
            );
        } else {
            const regex = compileDiffRegex(rule.patternSource);
            if (regex === null) {
                continue;
            }
            matchedFiles = changes.changedPaths.filter((path) => {
                const diff = changes.fileDiffs[path];
                return diff !== undefined && regex.test(diff);
            });
        }
        for (const file of matchedFiles) {
            for (const mention of rule.mentions) {
                record(mention, label, file);
            }
        }
    }

    const notifications: Notification[] = [];
    for (const mention of sortStrings(byMention.keys())) {
        const labels = byMention.get(mention);
        if (labels === undefined) {
            continue;
        }
        const entries: NotifyEntry[] = sortStrings(labels.keys()).map(
            (label) => ({
                label,
                files: sortStrings(labels.get(label) ?? []),
            }),
        );
        const files = sortStrings(entries.flatMap((entry) => entry.files));
        notifications.push({mention, entries, files});
    }
    return notifications;
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** Max files shown per (mention, label) before collapsing to a count. */
export const MAX_FILES_PER_ENTRY = 10;

/** Format one entry's files as backticked paths, capped with an overflow tail. */
const renderFiles = (files: string[]): string => {
    const shown = files.slice(0, MAX_FILES_PER_ENTRY);
    const rest = files.length - shown.length;
    const list = shown.map((file) => `\`${file}\``).join(", ");
    return rest > 0 ? `${list} (+${rest} more)` : list;
};

/**
 * A canonical signature of the notification set, so review.md re-posts the
 * guidance comment (which re-pings) only when the set actually changes. Stable
 * because {@link computeNotifications} already sorts everything.
 */
export const notifiedSignature = (notifications: Notification[]): string =>
    notifications
        .map(
            (n) =>
                `${n.mention}=` +
                n.entries
                    .map((e) => `${e.label}:${e.files.join(",")}`)
                    .join(";"),
        )
        .join("|");

/**
 * Render the `### Notified` block for the Review Guidance comment, or `""`
 * when nothing matched (review.md then adds no section). The mentions are raw
 * `@` tokens so GitHub pings them (see the module doc's delivery note).
 */
export const renderNotifiedMarkdown = (
    notifications: Notification[],
): string => {
    if (notifications.length === 0) {
        return "";
    }
    const lines = [
        "### Notified",
        "",
        "These people and teams asked (via `.github/NOTIFIED`) to be notified" +
            " of the changes below:",
        "",
    ];
    for (const notification of notifications) {
        const parts = notification.entries.map(
            (entry) => `**${entry.label}**: ${renderFiles(entry.files)}`,
        );
        lines.push(`- ${notification.mention} — ${parts.join("; ")}`);
    }
    lines.push("");
    return lines.join("\n");
};

/* -------------------------------------------------------------------------- */
/* CLI entrypoint (review.md Step 7 invokes this before building the comment) */
/* -------------------------------------------------------------------------- */

/** The full computed result, serialized to `notified.json` for review.md. */
export type NotifiedResult = {
    /** Whether `.github/NOTIFIED` exists in the reviewed repo. */
    present: boolean;
    /** Whether at least one rule matched (there is something to post). */
    matched: boolean;
    /** Fixed-format parse/compile problems; never prose about the code. */
    warnings: string[];
    /** One entry per notified mention (empty when nothing matched). */
    notifications: Notification[];
    /** Canonical signature of the set, for the Step 7 idempotency key. */
    signature: string;
    /** Ready-to-insert `### Notified` Markdown, or `""` when nothing matched. */
    markdown: string;
};

/**
 * Compute the notification result from the NOTIFIED text and the PR changes.
 * Pure — the CLI below supplies the file I/O. An absent file (`present:false`)
 * and an empty-but-present file both yield no notifications.
 */
export const computeNotifiedResult = (
    notifiedContent: string | null,
    changes: PrChanges,
): NotifiedResult => {
    if (notifiedContent === null) {
        return {
            present: false,
            matched: false,
            warnings: [],
            notifications: [],
            signature: "",
            markdown: "",
        };
    }
    const {rules, warnings} = parseNotified(notifiedContent);
    const notifications = computeNotifications(rules, changes);
    return {
        present: true,
        matched: notifications.length > 0,
        warnings,
        notifications,
        signature: notifiedSignature(notifications),
        markdown: renderNotifiedMarkdown(notifications),
    };
};

const REVIEW_DIR = "/tmp/gh-aw/review";
const FILES_PATH = `${REVIEW_DIR}/files.json`;
const FULL_DIFF_PATH = `${REVIEW_DIR}/full.diff`;
const NOTIFIED_OUT = `${REVIEW_DIR}/notified.json`;
const NOTIFIED_PATH = ".github/NOTIFIED";

type NotifiedCliFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

/** Accept either a bare `[{path}]` array or a `{files:[…]}` wrapper. */
const extractPaths = (raw: unknown): string[] => {
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as {files?: unknown}).files)
        ? (raw as {files: unknown[]}).files
        : [];
    return list
        .map((entry) => String((entry as {path?: unknown}).path ?? ""))
        .filter((path) => path !== "");
};

/**
 * Read the staged inputs, compute the result, and write `notified.json`.
 * Factored out (fs injected) so it is testable without touching the real
 * filesystem. `repoRoot` is the reviewed repo's root (`REVIEW_REPO_ROOT` in
 * production, since the script runs from the shared-lib checkout).
 */
export const runCli = (fs: NotifiedCliFs, repoRoot = "."): NotifiedResult => {
    const repoPath = (p: string): string =>
        repoRoot === "." ? p : `${repoRoot}/${p}`;

    const notifiedContent = fs.existsSync(repoPath(NOTIFIED_PATH))
        ? fs.readFileSync(repoPath(NOTIFIED_PATH), "utf8")
        : null;

    const changedPaths = fs.existsSync(FILES_PATH)
        ? extractPaths(JSON.parse(fs.readFileSync(FILES_PATH, "utf8")))
        : [];

    const fileDiffs: Record<string, string> = {};
    if (fs.existsSync(FULL_DIFF_PATH)) {
        for (const section of splitUnifiedDiff(
            fs.readFileSync(FULL_DIFF_PATH, "utf8"),
        )) {
            fileDiffs[section.path] = section.text;
        }
    }

    const result = computeNotifiedResult(notifiedContent, {
        changedPaths,
        fileDiffs,
    });

    fs.mkdirSync(REVIEW_DIR, {recursive: true});
    fs.writeFileSync(NOTIFIED_OUT, JSON.stringify(result, null, 2));
    return result;
};

// Run only when executed directly (review.md Step 7), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as NotifiedCliFs;
    const result = runCli(fs, process.env.REVIEW_REPO_ROOT ?? ".");
    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify({
            present: result.present,
            matched: result.matched,
            mentions: result.notifications.length,
            files: sortStrings(result.notifications.flatMap((n) => n.files))
                .length,
            warnings: result.warnings,
        }),
    );
}
