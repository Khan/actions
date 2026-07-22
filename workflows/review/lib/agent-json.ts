/**
 * Lenient JSON extraction from a sub-agent's final text.
 *
 * Sub-agent output contracts say "return ONLY the JSON object", but models
 * routinely prefix prose or wrap the payload in a code fence (measured in
 * production: run 29893634730's `out/correctness-reviewer.json` and
 * `out/claim-validator.json` both carried prose before a valid payload).
 * Every consumer of a sub-agent's raw text — the dispatcher parsing a
 * contract, the conformance gate checking that an output exists and parses —
 * must apply the SAME leniency, or the two disagree about the same file:
 * the dispatcher accepts what the gate calls unparseable, and a conforming
 * run fails the gate. This module is that single shared rule.
 *
 * Extraction order:
 *   1. The whole text, strictly.
 *   2. Fenced code blocks (``` with or without a language tag), last first:
 *      an agent's real payload is its final fence; earlier fences are
 *      usually quoted examples.
 *   3. Balanced `{...}` / `[...]` spans (string- and escape-aware), longest
 *      parseable span first: prose braces produce tiny false candidates
 *      (`{}` in a sentence), and the contract payload is with overwhelming
 *      likelihood the longest valid span.
 *
 * Determinism boundary: pure function of the text; no model call, no
 * filesystem.
 */

/** One fenced code block's inner text, in document order. */
const fencedBlocks = (text: string): string[] => {
    const blocks: string[] = [];
    const fence = /```[^\n]*\n([\s\S]*?)```/g;
    for (let m = fence.exec(text); m !== null; m = fence.exec(text)) {
        blocks.push(m[1]);
    }
    return blocks;
};

/**
 * Every balanced top-level `{...}` or `[...]` span in the text, found by a
 * string-aware depth scan. Spans nested inside a larger balanced span are
 * not re-reported (the outer span is the candidate; if it fails to parse,
 * the scan continues after its opening character, so inner spans still get
 * their turn).
 */
const balancedSpans = (text: string, cap = 200): string[] => {
    const spans: string[] = [];
    let i = 0;
    while (i < text.length && spans.length < cap) {
        const ch = text[i];
        if (ch !== "{" && ch !== "[") {
            i++;
            continue;
        }
        const close = ch === "{" ? "}" : "]";
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            const c = text[j];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c === "\\") {
                    escaped = true;
                } else if (c === '"') {
                    inString = false;
                }
                continue;
            }
            if (c === '"') {
                inString = true;
            } else if (c === "{" || c === "[") {
                depth++;
            } else if (c === "}" || c === "]") {
                depth--;
                if (depth === 0) {
                    end = c === close ? j : -1;
                    break;
                }
            }
        }
        if (end === -1) {
            i++;
            continue;
        }
        spans.push(text.slice(i, end + 1));
        // Continue INSIDE the span too: if the outer candidate fails to
        // parse, an inner one may be the real payload.
        i++;
    }
    return spans;
};

const tryParse = (candidate: string): unknown => {
    try {
        return JSON.parse(candidate) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * Extract the JSON value (object or array) from an agent's final text, per
 * the module rule. Returns undefined when no candidate parses. A bare
 * primitive (`"ok"`, `42`) is deliberately NOT extracted: no sub-agent
 * contract is a primitive, and prose fragments parse as primitives far too
 * easily.
 */
export const extractJsonValue = (text: string): unknown => {
    const whole = tryParse(text.trim());
    if (whole !== undefined && typeof whole === "object" && whole !== null) {
        return whole;
    }
    const fences = fencedBlocks(text);
    for (let i = fences.length - 1; i >= 0; i--) {
        const parsed = tryParse(fences[i].trim());
        if (
            parsed !== undefined &&
            typeof parsed === "object" &&
            parsed !== null
        ) {
            return parsed;
        }
    }
    const spans = balancedSpans(text).sort((a, b) => b.length - a.length);
    for (const span of spans) {
        const parsed = tryParse(span);
        if (
            parsed !== undefined &&
            typeof parsed === "object" &&
            parsed !== null
        ) {
            return parsed;
        }
    }
    return undefined;
};

/**
 * {@link extractJsonValue} narrowed to a plain object, the shape every
 * sub-agent contract uses at the top level. Arrays and null return
 * undefined.
 */
export const extractJsonObject = (
    text: string,
): Record<string, unknown> | undefined => {
    const value = extractJsonValue(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
};
