/**
 * CI backstop for review.md's post-agent execution rule.
 *
 * Nothing the agent can write may execute on the host after its turn: the
 * dispatch-conformance gate and the credentialed dismissal run from a copy
 * of the pinned checkout under $RUNNER_TEMP (which the agent container
 * cannot write), staged by a pre-agent step whose failure reds the job
 * before any AI spend. The dismissal step's warning wrapper makes a broken
 * path green at runtime, so these structural assertions are the only
 * backstop. They are position-sensitive on purpose: indexOf binds to the
 * FIRST occurrence, so a copy of any of these lines drifting into the wrong
 * section breaks the ordering chain rather than passing on a name match.
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

const reviewMd = fs.readFileSync(
    new URL("./review.md", import.meta.url),
    "utf-8",
);

const POSTAGENT = '"${RUNNER_TEMP}/gh-aw-review-lib-postagent"';
const preAt = reviewMd.indexOf("\npre-agent-steps:");
const postAt = reviewMd.indexOf("\npost-steps:");
// The post-steps sequence ends at the next column-0 line (a top-level key
// or full-line comment), not at a named heading that could move or be
// reworded.
const afterKey = postAt + "\npost-steps:".length;
const postEndRel = reviewMd.slice(afterKey).search(/\n\S/);
const postSteps = reviewMd.slice(
    postAt,
    postEndRel === -1 ? undefined : afterKey + postEndRel,
);

describe("the post-agent execution rule", () => {
    it("stages the copy before the agent's turn, cleared first", () => {
        expect(preAt).toBeGreaterThan(-1);
        expect(postAt).toBeGreaterThan(preAt);
        const rmAt = reviewMd.indexOf(`rm -rf ${POSTAGENT}`);
        const copyAt = reviewMd.indexOf(
            'cp -a "${GITHUB_WORKSPACE}/gh-aw-review-lib" ' + POSTAGENT,
        );
        expect(rmAt).toBeGreaterThan(preAt);
        expect(copyAt).toBeGreaterThan(rmAt);
        expect(copyAt).toBeLessThan(postAt);
    });

    it("keeps the pre-agent copy fatal (no continue-on-error, no if:, no wrapper)", () => {
        // A copy failure must red the job before the agent runs; that
        // fatality is what guarantees the copy exists post-agent.
        const preSteps = reviewMd.slice(preAt, postAt);
        const copyStepAt = preSteps.indexOf(
            "- name: Copy the review lib for post-agent execution",
        );
        expect(copyStepAt).toBeGreaterThan(-1);
        const nextAt = preSteps.indexOf("\n  - name:", copyStepAt + 1);
        const step = preSteps.slice(
            copyStepAt,
            nextAt === -1 ? undefined : nextAt,
        );
        expect(step).not.toMatch(/^\s*continue-on-error:/m);
        expect(step).not.toMatch(/^\s*if:/m);
        // ...and no shell-level softening either (a `|| true` or `exit 0`
        // would pass the YAML-key checks while defeating the fatality).
        expect(step).not.toMatch(/\|\||exit 0/);
    });

    it("executes every post-steps lib invocation from the clone", () => {
        const invocations = [
            ...postSteps.matchAll(/cd ("[^"]+"|\S+) && npx -y tsx ([^\s);]+)/g),
        ];
        expect(invocations.map((m) => m[2]).sort()).toEqual([
            "workflows/review/lib/dismiss-review.ts",
            "workflows/review/lib/dispatch-gate.ts",
        ]);
        for (const invocation of invocations) {
            expect(invocation[1]).toBe(POSTAGENT);
        }
        // A bare `npx -y tsx gh-aw-review-lib/...` (no `cd`) would be
        // invisible to the regex above, so also assert the workspace copy
        // is never named anywhere under post-steps.
        expect(postSteps).not.toMatch(/gh-aw-review-lib(?!-postagent)/);
    });

    it("keeps the failure posture: always-run gate, default-if dismissal, no continue-on-error", () => {
        expect(postSteps).not.toMatch(/^\s*continue-on-error:/m);
        const gateAt = postSteps.indexOf("- name: Dispatch-conformance gate");
        const dismissAt = postSteps.indexOf(
            "- name: Clear the standing blocking review",
        );
        expect(gateAt).toBeGreaterThan(-1);
        expect(dismissAt).toBeGreaterThan(gateAt);
        // The gate runs even when the agent job failed partway (the
        // safe_outputs job executes the queue regardless)...
        expect(postSteps.slice(gateAt, dismissAt)).toMatch(
            /^\s*if: always\(\)\s*$/m,
        );
        // ...while the dismissal keeps its default `if:` (success()), so a
        // gate-blocked run (exit 1) never dismisses.
        expect(postSteps.slice(dismissAt)).not.toMatch(/^\s*if:/m);
    });
});
