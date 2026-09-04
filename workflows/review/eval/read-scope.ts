/**
 * Decide whether a reviewer's read tool call stays inside the staged case.
 *
 * The live eval stages each case under a temp dir on a machine that also
 * holds this repo, and this repo holds the corpus (every case's must-catch
 * spec) and the scorer. A reviewer that reads across is scoring itself: on
 * the Pi harness branch (actions#406) gemini's correctness-reviewer found
 * the repo with `find /`, read its own case.json, another case's, and
 * live-match.ts, 37 of its 42 calls on one case. Nothing in the SDK arm
 * prevented the same thing (its tool list pre-approved reads, it did not
 * scope them), and no transcript existed to show whether it happened.
 *
 * This module is the pure predicate the runner's PreToolUse hook applies:
 * given a tool call and the staged case root, name the path it would read
 * outside the root, or `undefined` when the call is in scope. Kept
 * SDK-free so it is unit-testable without a model runtime.
 */

import {realpathSync} from "node:fs";
import {dirname, isAbsolute, resolve, sep} from "node:path";

/** The read-only investigation tools the eval hands a reviewer. */
export const READ_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Bump when {@link outOfScopeRead}'s semantics change (what counts as
 * inside the root, how patterns are judged, which tools it covers). The
 * toolset is in the stamp by name; this is the part of the ruler that a
 * rule change would otherwise leave looking identical.
 */
export const SCOPE_RULE_VERSION = 1;

/**
 * The runner's tool policy as a ruler stamp (see ReportProvenance). Reports
 * before the scope carry no such field and read as `unscoped` in the
 * aggregate, so a drift pool spanning the boundary warns the way a matcher
 * change does. The stamp moves when the toolset changes or when
 * {@link SCOPE_RULE_VERSION} is bumped.
 */
export const READ_TOOL_POLICY = `read-scoped:v${SCOPE_RULE_VERSION}:${READ_TOOLS.join(
    ",",
)}`;

export type ReadScopeOptions = {
    /**
     * Canonicalize a path that exists (symlink-aware). Defaults to
     * `realpathSync.native`; injectable so tests can pin behavior without
     * touching the disk.
     */
    realpath?: (path: string) => string;
};

const defaultRealpath = (path: string): string => realpathSync.native(path);

/**
 * Canonicalize `path`: the realpath when it exists, otherwise the realpath of
 * its nearest existing ancestor joined with the rest. A path that does not
 * exist yet is still checked lexically, so `../../etc/passwd` is denied even
 * when nothing is there to read.
 */
const canonical = (path: string, realpath: (p: string) => string): string => {
    const missing: string[] = [];
    let probe = path;
    for (;;) {
        try {
            const real = realpath(probe);
            return missing.length === 0
                ? real
                : resolve(real, ...missing.reverse());
        } catch {
            const parent = dirname(probe);
            if (parent === probe) {
                return path;
            }
            missing.push(probe.slice(parent.length).replace(/^[\\/]/, ""));
            probe = parent;
        }
    }
};

const isWithin = (candidate: string, root: string): boolean =>
    candidate === root || candidate.startsWith(root + sep);

/**
 * Expand brace alternation (`a{b,c}d` to `abd`, `acd`), nesting included,
 * capped so a hostile pattern cannot blow up; past the cap the pattern is
 * treated as escaping, since it cannot be checked.
 */
const EXPANSION_CAP = 256;
const expandBraces = (pattern: string): string[] | undefined => {
    const open = pattern.indexOf("{");
    if (open === -1) {
        return [pattern];
    }
    let depth = 0;
    let close = -1;
    const cuts: number[] = [];
    for (let i = open; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "{") {
            depth += 1;
        } else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                close = i;
                break;
            }
        } else if (ch === "," && depth === 1) {
            cuts.push(i);
        }
    }
    if (close === -1) {
        // Unbalanced: a literal brace, nothing to expand.
        return [pattern];
    }
    const head = pattern.slice(0, open);
    const tail = pattern.slice(close + 1);
    const inner = pattern.slice(open + 1, close);
    const alternatives: string[] = [];
    let from = 0;
    for (const cut of [...cuts.map((c) => c - open - 1), inner.length]) {
        alternatives.push(inner.slice(from, cut));
        from = cut + 1;
    }
    const out: string[] = [];
    for (const alt of alternatives) {
        const rest = expandBraces(`${head}${alt}${tail}`);
        if (rest === undefined) {
            return undefined;
        }
        out.push(...rest);
        if (out.length > EXPANSION_CAP) {
            return undefined;
        }
    }
    return out;
};

/**
 * Does any path the pattern can expand to leave the search root? A glob
 * pattern is not a path the resolver can canonicalize, so this is a lexical
 * test over every brace expansion: one that is absolute, or has a `..`
 * segment, escapes. `{/**,x}/case.json` and `{..,x}/live-match.ts` are the
 * shapes that slip a check on the raw string.
 */
const escapesRoot = (pattern: string): boolean => {
    const expansions = expandBraces(pattern);
    if (expansions === undefined) {
        return true;
    }
    return expansions.some(
        (piece) => isAbsolute(piece) || piece.split(/[\\/]/).includes(".."),
    );
};

/**
 * The path a read-tool call would touch outside `root`, or `undefined` when
 * the call is in scope. Unknown tools and inputs without a path field are in
 * scope (the tool list, not this predicate, decides which tools exist).
 *
 * - `Read` reads `file_path`.
 * - `Grep` searches `path` (a file or directory; default cwd).
 * - `Glob` matches `pattern` under `path` (default cwd). A pattern with any
 *   absolute or `..`-climbing piece (brace alternatives included) is denied
 *   outright: a pattern is not a path the resolver can canonicalize, and
 *   `/**\/case.json` is exactly the query a reviewer hunting for the corpus
 *   would make.
 */
export const outOfScopeRead = (
    toolName: string,
    toolInput: unknown,
    root: string,
    cwd: string,
    options: ReadScopeOptions = {},
): string | undefined => {
    const realpath = options.realpath ?? defaultRealpath;
    const input =
        typeof toolInput === "object" && toolInput !== null
            ? (toolInput as Record<string, unknown>)
            : {};
    const canonicalRoot = canonical(resolve(root), realpath);
    const check = (raw: unknown): string | undefined => {
        if (typeof raw !== "string" || raw === "") {
            return undefined;
        }
        const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
        const target = canonical(absolute, realpath);
        return isWithin(target, canonicalRoot) ? undefined : target;
    };
    switch (toolName) {
        case "Read":
            return check(input["file_path"]);
        case "Grep":
            return check(input["path"]);
        case "Glob": {
            const pattern = input["pattern"];
            if (typeof pattern === "string" && escapesRoot(pattern)) {
                return pattern;
            }
            return check(input["path"]);
        }
        default:
            return undefined;
    }
};

/** The denial text the model sees. It says what is in scope, not just "no". */
export const readScopeReason = (root: string, target: string): string =>
    `Out of scope for this review: ${target}. Reads are limited to the ` +
    `staged case under ${root} (the checkout and its context files). The ` +
    `review tooling and anything else on this machine are not part of the ` +
    `change under review.`;
