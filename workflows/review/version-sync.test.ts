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
    // KHAN_ACTIONS_BOT_TOKEN executes from a checkout fetched AFTER the
    // agent's turn (inside post-steps), into a path cleared first (checkout
    // reuses a pre-existing directory, and clean/reset never touch .git
    // config or hooks), never from the agent-writable workspace copy. The
    // step's warning wrapper makes a broken path green at runtime, so this
    // ordering test is the only backstop. Position-sensitive on purpose:
    // indexOf/search bind to the FIRST occurrence, so any earlier copy of
    // these lines (say, one drifting into pre-agent-steps) breaks the
    // ordering chain rather than passing on a name match.
    it("clears, fetches, and executes in order, inside post-steps", () => {
        const preAt = reviewMd.indexOf("\npre-agent-steps:");
        const postAt = reviewMd.indexOf("\npost-steps:");
        expect(preAt).toBeGreaterThan(-1);
        expect(postAt).toBeGreaterThan(preAt);
        // No step before post-steps fetches or enters the post-agent path
        // (the pre-agent orientation comment may name it in prose).
        expect(reviewMd.slice(0, postAt)).not.toMatch(
            /^\s*path:\s*gh-aw-review-lib-postagent\s*$/m,
        );

        const rmAt = reviewMd.indexOf(
            'rm -rf "${GITHUB_WORKSPACE}/gh-aw-review-lib-postagent"',
        );
        const checkoutAt = reviewMd.search(
            /^\s*path:\s*gh-aw-review-lib-postagent\s*$/m,
        );
        const dismissalAt = reviewMd.indexOf(
            "cd gh-aw-review-lib-postagent && npx -y tsx workflows/review/lib/dismiss-review.ts",
        );
        expect(rmAt).toBeGreaterThan(postAt);
        expect(checkoutAt).toBeGreaterThan(rmAt);
        expect(dismissalAt).toBeGreaterThan(checkoutAt);
    });
});
