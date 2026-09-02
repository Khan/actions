import {describe, it, expect} from "vitest";

import {
    computeHunkSignature,
    countRereviewStampBlocks,
    renderRereviewStamp,
    renderRereviewStampLine,
    STAMP_SCHEMA_VERSION,
    stampHunksChain,
    stripRereviewStamp,
} from "./rereview-mode";
import type {ReReviewStamp} from "./rereview-mode";

/**
 * The rule 7 stamp fold: `stripRereviewStamp`, `countRereviewStampBlocks`,
 * and `stampHunksChain`. Split from rereview-mode.test.ts by the max-lines
 * budget; the fixtures below are small local copies of that file's helpers.
 */

const TWO_HUNK_DIFF = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " a",
    "+first hunk line",
    " b",
    "@@ -10,2 +11,3 @@",
    " c",
    "+second hunk line",
    " d",
].join("\n");

const stampOf = (over: Partial<ReReviewStamp> = {}): ReReviewStamp => ({
    schemaVersion: STAMP_SCHEMA_VERSION,
    depth: "full",
    verdict: "APPROVE",
    anchorDraft: false,
    anchorHunks: computeHunkSignature(TWO_HUNK_DIFF),
    ...over,
});

describe("stripRereviewStamp", () => {
    it("strips the block even when the payload is garbled", () => {
        // The gate's fold has to remove a stamp the orchestrator transcribed
        // imperfectly, so the match keys on the field skeleton, not the
        // payload token; spaces end the payload region, so the garble here
        // must stay space-free.
        const garbled = renderRereviewStamp(stampOf()).replace(
            /hunks=\S+/,
            "hunks=!!not-the-payload!!",
        );
        expect(stripRereviewStamp(`Approved.\n${garbled}`).trim()).toBe(
            "Approved.",
        );
    });

    it("strips a payload wrapped across lines (newline separators)", () => {
        const rendered = renderRereviewStamp(stampOf());
        const wrapped = rendered.replace(/hunks=(\S{4})/, "hunks=$1\n");
        expect(stripRereviewStamp(`Approved.\n${wrapped}`).trim()).toBe(
            "Approved.",
        );
    });

    it("leaves space-separated prose in the payload region", () => {
        // Spaces end the region on purpose: prose there must stay in the
        // body and trip rule 7's comparison rather than strip with the
        // block.
        const smuggled = renderRereviewStamp(stampOf()).replace(
            "</sub>",
            " SPLICED PROSE the plan never staged.</sub>",
        );
        expect(stripRereviewStamp(`Approved.\n${smuggled}`)).toContain(
            "SPLICED PROSE the plan never staged.",
        );
    });

    it("exposes the payload region for the gate's growth bound", () => {
        const rendered = renderRereviewStamp(stampOf());
        const chain = stampHunksChain(rendered);
        expect(chain).not.toBeNull();
        // Line-wrapping changes bytes but not the whitespace-stripped chain.
        const wrapped = rendered.replace(/hunks=(\S{4})/, "hunks=$1\n");
        expect(stampHunksChain(wrapped)).toBe(chain);
        expect(stampHunksChain("no stamp here")).toBeNull();
    });

    it("strips a bare payload that lost its wrapper", () => {
        const payload = /<sub>(pr-reviewer:rereview[^<]*)<\/sub>/.exec(
            renderRereviewStamp(stampOf()),
        )?.[1];
        expect(payload).toBeDefined();
        expect(stripRereviewStamp(`Approved.\n${payload}`).trim()).toBe(
            "Approved.",
        );
    });

    it("strips the block when the wrapper itself is garbled", () => {
        // The orchestrator transcribes the whole 3-line block, not just the
        // payload; a reflowed wrapper must not leave residue that rule 7
        // then reads as a body splice.
        const garbled = renderRereviewStamp(stampOf()).replace(
            "<summary><sub>review fingerprint</sub></summary>",
            "<summary>review fingerprint</summary>",
        );
        expect(stripRereviewStamp(`Approved.\n${garbled}`).trim()).toBe(
            "Approved.",
        );
    });

    it("leaves a fingerprint-labeled block whose interior is not the stamp", () => {
        // The interior must carry the stamp's field skeleton: a looser
        // match would let rule 7's fold delete spliced prose hidden inside
        // a fingerprint-labeled block before the body comparison.
        const fake =
            "<details><summary><sub>review fingerprint</sub></summary>\n" +
            "SPLICED PROSE the plan never staged.\n</details>";
        expect(stripRereviewStamp(`Approved.\n${fake}`)).toContain(
            "SPLICED PROSE the plan never staged.",
        );
    });

    it("leaves a marker-prefixed block that lacks the field skeleton", () => {
        // The marker alone must not be enough: `pr-reviewer:rereview` plus
        // free prose is the one-token-cheaper variant of the same splice.
        const fake =
            "<details><summary><sub>review fingerprint</sub></summary>\n" +
            "<sub>pr-reviewer:rereview SPLICED PROSE the plan never " +
            "staged.</sub>\n</details>";
        expect(stripRereviewStamp(`Approved.\n${fake}`)).toContain(
            "SPLICED PROSE the plan never staged.",
        );
    });

    it("strips the block when the closing tag is lost in transcription", () => {
        // The stamp is appended last, so a clipped transcription loses the
        // trailing `</details>` first; residue there would read as a splice
        // and withhold the review.
        const rendered = renderRereviewStamp(stampOf());
        const truncated = rendered.slice(0, rendered.lastIndexOf("</details>"));
        expect(stripRereviewStamp(`Approved.\n${truncated}`).trim()).toBe(
            "Approved.",
        );
    });

    it("counts skeleton-shaped blocks for the gate's extra-block check", () => {
        const one = `Approved.\n${renderRereviewStamp(stampOf())}`;
        expect(countRereviewStampBlocks(one)).toBe(1);
        expect(
            countRereviewStampBlocks(
                `${one}\n${renderRereviewStamp(stampOf())}`,
            ),
        ).toBe(2);
        expect(countRereviewStampBlocks("no stamp here")).toBe(0);
    });

    it("strips the line form without tearing open the enclosing fold", () => {
        // The `</details>` after the stamp line closes the body's shared
        // `review details` fold, not the stamp: swallowing it would leave
        // unbalanced HTML for rule 7 to read as a body splice.
        const body = [
            "Approved.",
            "",
            "<details><summary><sub>review details</sub></summary>",
            "",
            "<sub>review-v1.24.0 | schema 2</sub>",
            "",
            renderRereviewStampLine(stampOf()),
            "",
            "</details>",
        ].join("\n");
        const stripped = stripRereviewStamp(body);
        expect(stripped).toContain("</details>");
        expect(stripped).not.toContain("pr-reviewer:rereview");
        expect(countRereviewStampBlocks(body)).toBe(1);
        expect(stampHunksChain(body)).toBe(
            stampHunksChain(renderRereviewStamp(stampOf())),
        );
    });

    it("leaves other collapsed blocks (the version footer) alone", () => {
        const footer =
            "<details><summary><sub>review details</sub></summary>\n" +
            "<sub>review-v1.20.0 | schema 2</sub>\n</details>";
        const body = `Approved.\n${footer}\n${renderRereviewStamp(stampOf())}`;
        expect(stripRereviewStamp(body).trim()).toBe(`Approved.\n${footer}`);
    });
});
