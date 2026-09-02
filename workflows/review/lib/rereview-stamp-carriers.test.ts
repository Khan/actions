import {describe, it, expect} from "vitest";

import {
    computeHunkSignature,
    parseRereviewStamp,
    renderRereviewStamp,
    renderRereviewStampLine,
    STAMP_SCHEMA_VERSION,
} from "./rereview-mode";
import type {ReReviewStamp} from "./rereview-mode";

/**
 * The stamp's two accepted carriers. Since KORE-2632 the review body carries
 * the fingerprint as a bare `<sub>` line inside the single collapsed
 * `review details` fold; every body posted before that carries the legacy
 * standalone `<details>` block. The planner reads the LATEST prior review of
 * an in-flight PR, so both must parse or the next re-review silently
 * degrades to `no-prior-fingerprint` on every PR open at the upgrade.
 */

const TWO_HUNK_DIFF = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " a",
    "+first hunk line",
    " b",
].join("\n");

const stampOf = (over: Partial<ReReviewStamp> = {}): ReReviewStamp => ({
    schemaVersion: STAMP_SCHEMA_VERSION,
    depth: "full",
    verdict: "COMMENT",
    anchorDraft: false,
    anchorHunks: computeHunkSignature(TWO_HUNK_DIFF),
    ...over,
});

describe("stamp carriers", () => {
    it("round-trips the line form the body's review-details fold carries", () => {
        const stamp = stampOf();
        const body = [
            "Approved — no blocking issues found.",
            "",
            "<details><summary><sub>review details</sub></summary>",
            "",
            "<sub>review-v1.24.0 | schema 2 | depth full</sub>",
            "",
            renderRereviewStampLine(stamp),
            "",
            "</details>",
        ].join("\n");
        expect(parseRereviewStamp(body)).toEqual(stamp);
    });

    it("still parses a legacy block-form body (every in-flight PR has one)", () => {
        const stamp = stampOf({depth: "scoped", verdict: "APPROVE"});
        const body = `Approved.\n${renderRereviewStamp(stamp)}`;
        expect(body).toContain("<summary><sub>review fingerprint</sub>");
        expect(parseRereviewStamp(body)).toEqual(stamp);
    });
});
