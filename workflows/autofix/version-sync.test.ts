/**
 * CI backstop for the autofix.md version surface.
 *
 * autofix.md checks out Khan/actions at a pinned `ref: autofix-v<version>` tag
 * to fetch the lib the prompt invokes at runtime, and names the same tag in its
 * `source:`. Both must name the release the file ships in, or a consumer gets a
 * prompt from one version running code from another. The release flow keeps
 * them true by running utils/sync-workflow-versions.ts alongside `changeset
 * version`; this test fails any PR (the Version Packages PR included) where the
 * literals and the `autofix` package version diverge.
 *
 * Mirrors workflows/review/version-sync.test.ts; see its header for the failure
 * this class of test was written in response to.
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

const autofixMd = fs.readFileSync(
    new URL("./autofix.md", import.meta.url),
    "utf-8",
);
const pkg = JSON.parse(
    fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

describe("autofix.md version surface", () => {
    it("pins the Khan/actions checkout ref to this release's version", () => {
        const refs = [...autofixMd.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map(
            (m) => m[1],
        );
        expect(refs).toEqual([`autofix-v${pkg.version}`]);
    });

    it("matches every autofix-v<semver> literal to the package version", () => {
        const literals = autofixMd.match(/autofix-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([`autofix-v${pkg.version}`]));
    });

    it("names the pinned tag in `source:` too", () => {
        expect(autofixMd).toContain(
            `source: Khan/actions/workflows/autofix/autofix.md@autofix-v${pkg.version}`,
        );
    });
});
