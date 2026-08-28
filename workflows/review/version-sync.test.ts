/**
 * CI backstop for the review.md version surface.
 *
 * review.md checks out Khan/actions at a pinned `ref: review-v<version>` tag
 * to fetch the lib code the prompt invokes at runtime; that ref must name the
 * release the file ships in, or consumers get a prompt from one version
 * running code from another (review-v1.3.0 through v1.4.0 shipped this way,
 * still pointing at v1.2.2). The release flow keeps the ref true by running
 * utils/sync-workflow-versions.ts alongside `changeset version`; this test fails
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
    it("pins every Khan/actions checkout ref to this release's version", () => {
        const refs = [...reviewMd.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map(
            (m) => m[1],
        );
        // Two checkouts of the same ref: the pre-agent lib checkout and the
        // post-agent one the dismissal executor runs from.
        expect(refs).toEqual([
            `review-v${pkg.version}`,
            `review-v${pkg.version}`,
        ]);
    });

    it("matches every review-v<semver> literal to the package version", () => {
        const literals = reviewMd.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([`review-v${pkg.version}`]));
    });
});

describe("the credentialed dismissal step", () => {
    // The security property the post-agent checkout buys: the step holding
    // KHAN_ACTIONS_BOT_TOKEN executes from the checkout made after the
    // agent's turn, never from the agent-writable workspace copy. The
    // step's warning wrapper makes a broken path green at runtime, so this
    // is the only backstop.
    it("runs from the post-agent checkout, not the workspace copy", () => {
        const checkoutPath = reviewMd.match(
            /^\s*path:\s*(gh-aw-review-lib-\S+)\s*$/m,
        )?.[1];
        expect(checkoutPath).toBeDefined();
        const dismissalCwd = reviewMd.match(
            /cd (\S+) && npx -y tsx workflows\/review\/lib\/dismiss-review\.ts/,
        )?.[1];
        expect(dismissalCwd).toBe(checkoutPath);
        expect(dismissalCwd).not.toBe("gh-aw-review-lib");
    });

    it("clears the checkout path before fetching (checkout reuses a pre-existing dir)", () => {
        expect(reviewMd).toMatch(
            /rm -rf "\$\{GITHUB_WORKSPACE\}\/gh-aw-review-lib-postagent"/,
        );
    });
});
