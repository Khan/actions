/**
 * Robust extraction of one JSON object from a model's final text.
 *
 * Every live seam used to share the same fragile rule: slice
 * `/\{[\s\S]*\}/` (the FIRST `{` through the LAST `}`) and strict
 * `JSON.parse` it. Two recurring live failures follow from that rule:
 *
 * - Prose braces poison the slice. When an agent quotes a template literal
 *   from the diff under review (`` `user-profile:${tenantId}` ``) before its
 *   JSON, the slice starts at `{tenantId...` and parsing dies with
 *   "Expected property name or '}'" (the standing incident-cache-missing-key
 *   agent failures; the retry repeats the quote, so it never recovers).
 * - One invalid string escape from the model (`\'`) kills the whole parse
 *   ("Bad escaped character in JSON", the recurring judge-scoring failure).
 *
 * `extractJsonObject` instead walks the `{` positions left to right, takes
 * each candidate's balanced string-aware extent, and parses that slice; a
 * slice that fails to parse is retried once with invalid string escapes
 * repaired. Of the top-level slices that parse, the LAST one wins: every
 * caller instructs its agent to end with the JSON object, so a trailing
 * object outranks any parseable snippet quoted in earlier prose.
 */

/** The balanced `{...}` slice opening at `start`, or null when unclosed. */
const balancedSlice = (text: string, start: number): string | null => {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") {
                i += 1;
            } else if (ch === '"') {
                inString = false;
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === "{") {
            depth += 1;
        } else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
};

/**
 * Drop the backslash from every invalid string escape (`\'` becomes `'`),
 * the rule lenient parsers apply; valid escapes pass through untouched. The
 * alternation consumes escapes pairwise left to right, so the second half of
 * a valid `\\` is never re-read as the start of an invalid escape.
 */
const repairInvalidEscapes = (slice: string): string =>
    slice.replace(
        /\\(?:(["\\/bfnrt]|u[0-9a-fA-F]{4})|([\s\S]))/g,
        (whole, valid: string | undefined, invalid: string) =>
            valid === undefined ? invalid : whole,
    );

/**
 * Parse one candidate slice, or null. A slice always opens with `{`, so a
 * successful parse is always a plain object.
 */
const parseCandidate = (slice: string): Record<string, unknown> | null => {
    for (const attempt of [slice, repairInvalidEscapes(slice)]) {
        try {
            return JSON.parse(attempt) as Record<string, unknown>;
        } catch {
            // Fall through to the repaired attempt or the next candidate.
        }
    }
    return null;
};

/** Extract the JSON object from a model's final text; throws when none. */
export const extractJsonObject = (text: string): Record<string, unknown> => {
    let found: Record<string, unknown> | null = null;
    let start = text.indexOf("{");
    while (start !== -1) {
        const slice = balancedSlice(text, start);
        const parsed = slice === null ? null : parseCandidate(slice);
        if (parsed !== null && slice !== null) {
            found = parsed;
            // Jump past this object so its nested objects are never offered
            // as candidates; only a LATER top-level object may replace it.
            start = text.indexOf("{", start + slice.length);
        } else {
            start = text.indexOf("{", start + 1);
        }
    }
    if (found === null) {
        throw new Error("output carries no parseable JSON object");
    }
    return found;
};
