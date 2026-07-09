/**
 * CI backstop for the review.md version surface.
 *
 * review.md checks out Khan/actions at a pinned `ref: review-v<version>` tag
 * to fetch the lib code the prompt invokes at runtime; that ref must name the
 * release the file ships in, or consumers get a prompt from one version
 * running code from another (review-v1.3.0 through v1.4.0 shipped this way,
 * still pointing at v1.2.2). The release flow keeps the ref true by running
 * utils/sync-review-version.ts alongside `changeset version`; this test fails
 * any PR (the Version Packages PR included) where the literals in review.md
 * do not match the "review" package version.
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

const reviewMd = fs.readFileSync(
    new URL("./review.md", import.meta.url),
    "utf-8",
);
const pkg = JSON.parse(
    fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

describe("review.md version surface", () => {
    it("pins the Khan/actions checkout ref to this release's version", () => {
        const refs = [...reviewMd.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map(
            (m) => m[1],
        );
        expect(refs).toEqual([`review-v${pkg.version}`]);
    });

    it("matches every review-v<semver> literal to the package version", () => {
        const literals = reviewMd.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([`review-v${pkg.version}`]));
    });
});
