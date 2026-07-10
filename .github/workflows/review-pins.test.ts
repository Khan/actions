/**
 * CI backstop for the pins in this repo's installed reviewer (review.md here,
 * distinct from the shared source at workflows/review/review.md).
 *
 * The install carries coupled pins that no release automation touches:
 * `source:`, recording which Khan/actions release the prompt was copied from,
 * the `ref:` of the gh-aw-review-lib checkout that fetches the deterministic
 * lib the prompt invokes at runtime, and the copies of both that `gh aw
 * compile` bakes into review.lock.yml (which is what actually executes, and
 * which .gitattributes marks merge=ours, so a merge can silently keep a stale
 * lock). If a future `gh aw update`, a hand edit, or a skipped recompile moves
 * one without the others, the prompt from one release runs the lib of another;
 * this test fails that PR. (The shared source's own ref is kept true by
 * utils/sync-workflow-versions.ts and its backstop in
 * workflows/review/version-sync.test.ts; neither covers these files.)
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

const reviewMd = fs.readFileSync(
    new URL("./review.md", import.meta.url),
    "utf-8",
);
const reviewLock = fs.readFileSync(
    new URL("./review.lock.yml", import.meta.url),
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

    it("names no other release anywhere in the file", () => {
        const literals = reviewMd.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([sourceRef]));
    });
});

describe("compiled review.lock.yml pins", () => {
    it("was recompiled from this review.md (every baked literal matches)", () => {
        const literals = reviewLock.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([sourceRef]));
    });
});
