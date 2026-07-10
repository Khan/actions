/**
 * CI backstop for the pins in this repo's installed reviewer (review.md here,
 * distinct from the shared source at workflows/review/review.md).
 *
 * The install carries two coupled pins that no release automation touches:
 * `source:`, recording which Khan/actions release the prompt was copied from,
 * and the `ref:` of the gh-aw-review-lib checkout that fetches the
 * deterministic lib the prompt invokes at runtime. If a future `gh aw update`
 * or a hand edit moves one without the other, the prompt from one release
 * runs the lib of another; this test fails that PR. (The shared source's own
 * ref is kept true by utils/sync-workflow-versions.ts and its backstop in
 * workflows/review/version-sync.test.ts; neither covers this file.)
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

const reviewMd = fs.readFileSync(
    new URL("./review.md", import.meta.url),
    "utf-8",
);

const sourceRef = reviewMd.match(
    /^source:\s*Khan\/actions\/workflows\/review\/review\.md@(\S+)\s*$/m,
)?.[1];
const checkoutRefs = [...reviewMd.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map(
    (m) => m[1],
);

describe("installed review.md pins", () => {
    it("records the review release the prompt was copied from", () => {
        expect(sourceRef).toMatch(/^review-v\d+\.\d+\.\d+$/);
    });

    it("checks out the lib at exactly the source: release", () => {
        expect(checkoutRefs).toEqual([sourceRef]);
    });
});
