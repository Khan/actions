import {describe, expect, it} from "vitest";
import {
    PREAMBLE_END,
    REVIEW_PROMPT_HEADER,
    deriveCanaryMarkdown,
    findGhAwBinary,
} from "./generate-canary-lib.ts";

describe("deriveCanaryMarkdown", () => {
    it("splices review.md's source line and prompt body onto canary's preamble", () => {
        const canaryPreamble = [
            "---",
            "source: Khan/actions/workflows/review/review.md@review-v1.0.0",
            "---",
            "",
            "# PR Reviewer Canary",
            "",
            "Canary instructions.",
            "",
            PREAMBLE_END,
            "old prompt body that should be replaced",
        ].join("\n");

        const reviewMd = [
            "---",
            "source: Khan/actions/workflows/review/review.md@review-v2.0.0",
            "---",
            "",
            REVIEW_PROMPT_HEADER,
            "new shared prompt body verbatim",
        ].join("\n");

        const result = deriveCanaryMarkdown(reviewMd, canaryPreamble);

        expect(result).toContain(
            "source: Khan/actions/workflows/review/review.md@review-v2.0.0",
        );
        expect(result).not.toContain("review-v1.0.0");
        expect(result).toContain("Canary instructions.");
        expect(result).toContain(PREAMBLE_END);
        expect(result).toContain("new shared prompt body verbatim");
        expect(result).not.toContain("old prompt body that should be replaced");
    });

    it("throws if the canary preamble end marker is missing", () => {
        const invalidCanary = "no preamble end marker here";
        const reviewMd = [
            "---",
            "source: Khan/actions/workflows/review/review.md@review-v2.0.0",
            "---",
            "",
            REVIEW_PROMPT_HEADER,
            "prompt",
        ].join("\n");

        expect(() => deriveCanaryMarkdown(reviewMd, invalidCanary)).toThrow(
            /Canary preamble terminator/,
        );
    });

    it("throws if review.md has no source line", () => {
        const canaryMd = ["---", "source: test", "---", PREAMBLE_END].join(
            "\n",
        );
        const reviewMd = [
            "---",
            "no-source-line: true",
            "---",
            "",
            REVIEW_PROMPT_HEADER,
            "prompt",
        ].join("\n");

        expect(() => deriveCanaryMarkdown(reviewMd, canaryMd)).toThrow(
            /No source: provenance line/,
        );
    });
});

describe("findGhAwBinary", () => {
    it("returns a path or null", () => {
        const bin = findGhAwBinary();
        expect(bin === null || typeof bin === "string").toBe(true);
    });
});
