/**
 * Glob matching for the consumer-owned routing map, split out of `router.ts`
 * by concern and its max-lines budget (the same split `dispatch-contracts.ts`
 * took from `dispatch.ts`). Self-contained and pure: a practical subset of
 * gitignore/CODEOWNERS semantics plus the specificity ordering the last-rule
 * -wins tier resolution and the lens union rely on.
 *
 * Determinism boundary: pure functions of a path and a glob; no filesystem,
 * no model call.
 */

/**
 * Compile a glob to an anchored RegExp. Semantics (a practical subset of
 * gitignore / CODEOWNERS):
 *   - `**`       matches any run of characters, including `/` (zero or more segments)
 *   - `*`        matches any run of characters except `/`
 *   - `?`        matches a single character except `/`
 *   - a trailing `/` makes the pattern a directory prefix (everything beneath it)
 *   - a leading `/` (optional) anchors to the repo root and is stripped
 *   - a pattern with NO `/` matches the file's *basename* in any directory
 *     (e.g. `*.lock`, `Dockerfile`), mirroring gitattributes/gitignore.
 * All other regex metacharacters are escaped literally.
 */
const globToRegExp = (glob: string): RegExp => {
    let pattern = glob.trim();

    // A no-slash pattern matches the basename anywhere: reduce to matching the
    // last path segment by prefixing an optional "any directories" group.
    const matchesBasename = !pattern.includes("/");

    // Directory pattern: trailing slash means "everything under this dir".
    let dirPrefix = false;
    if (pattern.endsWith("/")) {
        dirPrefix = true;
        pattern = pattern.slice(0, -1);
    }

    // Leading slash anchors to root; we always anchor, so just strip it.
    if (pattern.startsWith("/")) {
        pattern = pattern.slice(1);
    }

    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // Consume the second star (and an optional following slash so
                // `**/x` matches `x` at the root as well as nested).
                i++;
                if (pattern[i + 1] === "/") {
                    i++;
                    out += "(?:.*/)?";
                } else {
                    out += ".*";
                }
            } else {
                out += "[^/]*";
            }
        } else if (ch === "?") {
            out += "[^/]";
        } else {
            // Escape any regex-special character.
            out += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }

    if (dirPrefix) {
        // Match the directory itself and anything beneath it.
        out += "(?:/.*)?";
    }

    const body = matchesBasename ? `(?:.*/)?${out}` : out;
    return new RegExp(`^${body}$`);
};

// Compiled-pattern cache: patterns come from static config, so caching keeps
// repeated `route` calls (and large file lists) from recompiling.
const regexpCache = new Map<string, RegExp>();

const compile = (glob: string): RegExp => {
    let re = regexpCache.get(glob);
    if (re === undefined) {
        re = globToRegExp(glob);
        regexpCache.set(glob, re);
    }
    return re;
};

/** Whether `path` matches `glob` under the semantics in {@link globToRegExp}. */
export const matchesGlob = (path: string, glob: string): boolean =>
    compile(glob).test(path);

/**
 * Specificity score for "most specific pattern wins" (CODEOWNERS-style). More
 * literal (non-wildcard) characters is more specific; ties break on total
 * length, then on having more path segments. Higher wins.
 */
export const patternSpecificity = (glob: string): number => {
    const literal = glob.replace(/[*?]/g, "").length;
    const segments = glob.split("/").length;
    return literal * 1000 + glob.length * 10 + segments;
};
