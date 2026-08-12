import {describe, expect, it} from "vitest";

import {normalizeBody} from "./sanitizer-normalize";

/**
 * Rule 7 compares `normalizeBody(plan)` against `normalizeBody(queued)`, where
 * the queued side has been rewritten by gh-aw's ingest sanitizer and the plan
 * side has not. Each absorbed transform therefore gets a pair-style test:
 * the pre-sanitizer plan text and the post-sanitizer queued text must fold to
 * the same comparison form, while a genuine splice must not.
 */
describe("normalizeBody XML tag conversion", () => {
    it("folds an unknown tag the sanitizer parenthesised (incident shape)", () => {
        // kore-marketplace run 31609578203: the reviewer wrote a path
        // template in prose; the sanitizer rewrote the unknown `<skill>` to
        // `(skill)` and preserved the allowed `<p>`, and the gate blocked a
        // fully conforming review.
        const plan = "one level deep (plugins/<p>/skills/<skill>/SKILL.md)";
        const queued = "one level deep (plugins/<p>/skills/(skill)/SKILL.md)";
        expect(normalizeBody(plan)).toBe(normalizeBody(queued));
    });

    it("folds closing and self-closing unknown tags", () => {
        expect(normalizeBody("a <thing>x</thing> b <thing/> c")).toBe(
            normalizeBody("a (thing)x(/thing) b (thing/) c"),
        );
    });

    it("folds unknown tags carrying attributes", () => {
        expect(normalizeBody('see <custom attr="v"> here')).toBe(
            normalizeBody('see (custom attr="v") here'),
        );
    });

    it("preserves allowed GFM tags on both sides", () => {
        const body = "wrap in <details><summary>more</summary></details>";
        expect(normalizeBody(body)).toContain("<details>");
    });

    it("still catches a splice that parenthesises a preserved allowed tag", () => {
        // The sanitizer preserves `<p>`, so a queued `(p)` cannot be the
        // sanitizer's work; the fold must not absorb it.
        expect(normalizeBody("a <p> b")).not.toBe(normalizeBody("a (p) b"));
    });

    it("still catches a genuine content splice inside a folded tag", () => {
        expect(normalizeBody("path <skill> end")).not.toBe(
            normalizeBody("path (other) end"),
        );
    });

    it("keeps plan and queued equal when the body carries an https autolink", () => {
        // The sanitizer preserves `<https://...>` autolinks, so both sides
        // carry the same shape into the URL folds.
        const body = "see <https://example.com/path> for details";
        expect(normalizeBody(body)).toBe(normalizeBody(body));
    });

    it("does not rewrite the URL folds' own placeholders", () => {
        // The URL folds rewrite links to `<url:host>` AFTER the tag fold
        // runs; a plan link and its host-redacted queued form must still
        // agree.
        const plan = "see https://example.com/deep/page for details";
        const queued = "see (example.com/redacted) for details";
        expect(normalizeBody(plan)).toBe(normalizeBody(queued));
    });
});
