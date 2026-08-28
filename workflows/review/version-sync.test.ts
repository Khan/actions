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
    it("pins the Khan/actions checkout ref to this release's version", () => {
        const refs = [...reviewMd.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map(
            (m) => m[1],
        );
        // One `ref:` line (the pre-agent checkout); the post-agent clone
        // pins the same release via its `--branch` literal, covered by the
        // every-literal test below and asserted structurally in the
        // post-agent describe block.
        expect(refs).toEqual([`review-v${pkg.version}`]);
    });

    it("matches every review-v<semver> literal to the package version", () => {
        const literals = reviewMd.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([`review-v${pkg.version}`]));
    });
});

describe("the post-agent steps", () => {
    // The security property: nothing the agent can write may execute on
    // the host after its turn, so the conformance gate and the credentialed
    // dismissal both run from a fresh clone under $RUNNER_TEMP (outside the
    // agent container's mounts) fetched after the turn ends. The dismissal
    // step's warning wrapper makes a broken path green at runtime, so these
    // position-sensitive assertions are the only backstop: indexOf binds to
    // the FIRST occurrence, so a copy of any of these lines drifting
    // earlier (say, into pre-agent-steps) breaks the ordering chain rather
    // than passing on a name match.
    const POSTAGENT = '"${RUNNER_TEMP}/gh-aw-review-lib-postagent"';
    const postAt = reviewMd.indexOf("\npost-steps:");
    const postSteps = reviewMd.slice(
        postAt,
        reviewMd.indexOf("\n# Anthropic pricing overlay"),
    );

    it("clears, clones, gates, and dismisses in order, inside post-steps", () => {
        const preAt = reviewMd.indexOf("\npre-agent-steps:");
        expect(preAt).toBeGreaterThan(-1);
        expect(postAt).toBeGreaterThan(preAt);

        const rmAt = reviewMd.indexOf(`rm -rf ${POSTAGENT}`);
        const cloneAt = reviewMd.indexOf(
            `git clone --quiet --depth 1 --branch review-v${pkg.version}`,
        );
        const gateAt = reviewMd.indexOf(
            `cd ${POSTAGENT} && npx -y tsx workflows/review/lib/dispatch-gate.ts`,
        );
        const dismissalAt = reviewMd.indexOf(
            `cd ${POSTAGENT} && npx -y tsx workflows/review/lib/dismiss-review.ts`,
        );
        expect(rmAt).toBeGreaterThan(postAt);
        expect(cloneAt).toBeGreaterThan(rmAt);
        expect(gateAt).toBeGreaterThan(cloneAt);
        expect(dismissalAt).toBeGreaterThan(gateAt);
    });

    it("never executes the agent-writable workspace copy after the agent's turn", () => {
        expect(postSteps).not.toContain("cd gh-aw-review-lib ");
        expect(postSteps).not.toContain("cd gh-aw-review-lib/");
    });

    it("keeps the failure posture: always-run fetch and gate, default-if dismissal, nothing continue-on-error", () => {
        expect(postSteps).not.toMatch(/^\s*continue-on-error:/m);

        const fetchAt = postSteps.indexOf("- name: Fetch the review lib");
        const gateAt = postSteps.indexOf("- name: Dispatch-conformance gate");
        const dismissAt = postSteps.indexOf(
            "- name: Clear the standing blocking review",
        );
        expect(fetchAt).toBeGreaterThan(-1);
        expect(gateAt).toBeGreaterThan(fetchAt);
        expect(dismissAt).toBeGreaterThan(gateAt);

        // The fetch and the gate run even when the agent job failed partway
        // (the safe_outputs job executes the queue regardless)...
        expect(postSteps.slice(fetchAt, gateAt)).toMatch(
            /^\s*if: always\(\)\s*$/m,
        );
        expect(postSteps.slice(gateAt, dismissAt)).toMatch(
            /^\s*if: always\(\)\s*$/m,
        );
        // ...while the dismissal keeps its default `if:` (success()), so a
        // gate-blocked run (exit 1) never dismisses.
        expect(postSteps.slice(dismissAt)).not.toMatch(/^\s*if:/m);
    });
});
