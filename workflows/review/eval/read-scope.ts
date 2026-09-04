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
    /** The read-tool list to fall closed against; defaults to READ_TOOLS. */
    readTools?: readonly string[];
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

const GLOB_CHARS = /[*?[]/;

/**
 * The literal directory prefix of one pattern expansion: every leading
 * segment up to the first one that contains a glob character. That prefix
 * is a real path and can be resolved and canonicalized like a Read target;
 * the glob tail cannot. A `..` in the tail is treated as escaping, since
 * what it climbs from is not known until match time.
 */
const literalPrefix = (
    expansion: string,
): {prefix: string; tailClimbs: boolean} => {
    const segments = expansion.split(/[\\/]/);
    const firstGlob = segments.findIndex((seg) => GLOB_CHARS.test(seg));
    const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
    const tail = firstGlob === -1 ? [] : segments.slice(firstGlob);
    // An absolute expansion splits to a leading "" segment, so the join
    // already starts with "/"; a pattern that is only "/**" has no literal
    // and resolves to the root of the filesystem.
    const prefix = literal.join("/");
    return {
        prefix: prefix === "" && isAbsolute(expansion) ? "/" : prefix,
        tailClimbs: tail.includes(".."),
    };
};

/**
 * The path a read-tool call would touch outside `root`, or `undefined` when
 * the call is in scope. Inputs without a path field are in scope. A tool
 * that is not in {@link READ_TOOLS} is in scope too (the hook denies those
 * by name before asking), but a tool that IS in READ_TOOLS and has no case
 * below is denied: adding a tool to the constant must not ship an unchecked
 * read path.
 *
 * - `Read` reads `file_path`.
 * - `Grep` searches `path` (a file or directory; default cwd).
 * - `Glob` matches `pattern` under `path` (default cwd). The base is checked
 *   like a Read target, then every brace expansion of the pattern: its
 *   literal prefix (the segments before the first glob character) resolves
 *   against the base and must land inside the root, so `../context/*.diff`
 *   from the checkout is in scope while `/**\/case.json` and
 *   `../../case-2/**` are not. A `..` inside the glob tail, or a pattern
 *   past the brace-expansion cap, is denied since it cannot be resolved.
 *   The glob tail itself is not canonicalized (a symlink matched by `*`
 *   would not be seen); the staged tree is a plain copy of the fixture with
 *   no symlinks in it, which is what keeps that acceptable.
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
            // The search base first (a file or directory, default cwd).
            const baseHit = check(input["path"]);
            if (baseHit !== undefined) {
                return baseHit;
            }
            const pattern = input["pattern"];
            if (typeof pattern !== "string") {
                return undefined;
            }
            const base =
                typeof input["path"] === "string" && input["path"] !== ""
                    ? isAbsolute(input["path"])
                        ? input["path"]
                        : resolve(cwd, input["path"])
                    : cwd;
            const expansions = expandBraces(pattern);
            if (expansions === undefined) {
                return pattern;
            }
            for (const expansion of expansions) {
                const {prefix, tailClimbs} = literalPrefix(expansion);
                if (tailClimbs) {
                    return pattern;
                }
                const target = canonical(
                    isAbsolute(prefix) ? prefix : resolve(base, prefix),
                    realpath,
                );
                if (!isWithin(target, canonicalRoot)) {
                    return pattern;
                }
            }
            return undefined;
        }
        default:
            return (options.readTools ?? READ_TOOLS).includes(toolName)
                ? `${toolName} (a read tool this predicate does not know)`
                : undefined;
    }
};

/**
 * The denial text the model sees. It says what is in scope, not just "no",
 * and names the two directories by absolute path: in the first forced run
 * every one of the 8 denials was a reviewer that had guessed
 * `<case>/src/...` for a changed file, missed, and widened its search to
 * the staging root. Naming `<case>/checkout` is what turns that into one
 * retry instead of a hunt.
 */
export const readScopeReason = (
    root: string,
    target: string,
    cwd?: string,
): string =>
    `Out of scope for this review: ${target}. Reads are limited to the ` +
    `staged case under ${root}: the changed files are in ` +
    `${cwd ?? `${root}/checkout`} (your working directory) and the review ` +
    `context files are in ${root}/context. The review tooling and anything ` +
    `else on this machine are not part of the change under review.`;
