/**
 * Lifecycle replay for the re-review mode dial: the adversarial cases the
 * dial must survive, as data (`eval/lifecycle/*.json`), replayed
 * deterministically through the same lib functions the production CLI runs.
 *
 * These cases do not fit the corpus format (a corpus case is one PR state;
 * these are push *sequences*), so they live in their own dataset. Each case
 * lists the modes it must hold under, a sequence of pushes (each a unified
 * diff and the verdict that run submits), and per-push expectations. The
 * harness threads the review-body stamp from push to push exactly as
 * production does: compute the signature, decide the depth, then stamp the
 * simulated review the next push reads.
 *
 * The two adversarial cases are scored as "the tripwire re-armed and the
 * payload got a full review"; the economy control is scored as "the reduced
 * path actually ran"; a dial that trips on every fix push is a no-op cost
 * lever, so both directions are load-bearing. A live-PR trial
 * (`.claude/skills/review-trial/SKILL.md`) exercises the same sequences
 * against the real workflow when a lifecycle change ships.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {
    computeHunkSignature,
    decideReReviewDepth,
    findLatestStamp,
    renderRereviewStamp,
    STAMP_SCHEMA_VERSION,
} from "../lib/rereview-mode";
import type {PriorReview, ReReviewPlan} from "../lib/rereview-mode";
import type {ReReviewMode} from "../lib/routing-config";

/* -------------------------------------------------------------------------- */
/* Dataset shape and loading                                                  */
/* -------------------------------------------------------------------------- */

type LifecyclePush = {
    name: string;
    isDraft: boolean;
    /** The verdict this run submits (rides into the stamp the next push reads). */
    verdict: string;
    /** The push's full unified diff, one line per array entry. */
    diff: string[];
    expected: {
        /** A depth, or `same-as-mode`: the configured mode's own cheap path. */
        depth: string;
        tripwireRearmed: boolean;
    };
};

type LifecycleCase = {
    id: string;
    tags: string[];
    description: string;
    /** The reduced modes the expectations must hold under, each replayed. */
    modes: ReReviewMode[];
    scoring: "payload-full-review" | "reduced-path-taken";
    pushes: LifecyclePush[];
};

const LIFECYCLE_DIR = join(__dirname, "lifecycle");

const loadLifecycleCases = (): LifecycleCase[] =>
    readdirSync(LIFECYCLE_DIR)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(
            (name) =>
                JSON.parse(
                    readFileSync(join(LIFECYCLE_DIR, name), "utf8"),
                ) as LifecycleCase,
        );

/* -------------------------------------------------------------------------- */
/* Replay                                                                     */
/* -------------------------------------------------------------------------- */

/** Replay one case under one mode; returns the per-push plans in order. */
const replay = (
    lifecycleCase: LifecycleCase,
    mode: ReReviewMode,
): ReReviewPlan[] => {
    const priorReviews: PriorReview[] = [];
    const plans: ReReviewPlan[] = [];
    for (const [index, push] of lifecycleCase.pushes.entries()) {
        const plan = decideReReviewDepth({
            mode,
            isDraft: push.isDraft,
            priorStamp: findLatestStamp(priorReviews),
            currentSignature: computeHunkSignature(push.diff.join("\n")),
        });
        plans.push(plan);
        priorReviews.push({
            body: renderRereviewStamp({
                schemaVersion: STAMP_SCHEMA_VERSION,
                depth: plan.depth,
                verdict: push.verdict,
                anchorDraft: plan.stampAnchorDraft,
                anchorHunks: plan.stampHunks,
            }),
            submittedAt: `2026-07-0${index + 1}T00:00:00Z`,
        });
    }
    return plans;
};

/* -------------------------------------------------------------------------- */
/* The suite                                                                  */
/* -------------------------------------------------------------------------- */

const CASES = loadLifecycleCases();

describe("re-review lifecycle dataset", () => {
    it("loads the adversarial pair and at least one economy control", () => {
        const ids = CASES.map((c) => c.id);
        expect(ids).toContain("rereview-rewrite-after-approval");
        expect(ids).toContain("rereview-sparse-pr-then-payload");
        expect(CASES.some((c) => c.scoring === "reduced-path-taken")).toBe(
            true,
        );
    });
});

describe.each(CASES)("$id", (lifecycleCase) => {
    describe.each(lifecycleCase.modes)("under mode %s", (mode) => {
        const plans = replay(lifecycleCase, mode);

        it.each(
            lifecycleCase.pushes.map((push, index) => ({
                push,
                plan: plans[index],
            })),
        )("push $push.name meets its expected depth", ({push, plan}) => {
            const expectedDepth =
                push.expected.depth === "same-as-mode"
                    ? mode
                    : push.expected.depth;
            expect(plan.depth).toBe(expectedDepth);
            expect(plan.tripwireRearmed).toBe(push.expected.tripwireRearmed);
        });

        if (lifecycleCase.scoring === "payload-full-review") {
            it("scores: the tripwire re-armed and the payload got a full review", () => {
                const payload = plans[plans.length - 1];
                expect(payload.tripwireRearmed).toBe(true);
                expect(payload.depth).toBe("full");
                expect(payload.dispatch).toBe("all");
                expect(payload.staging).toBe("whole-diff");
            });
        } else {
            it("scores: the reduced path actually ran on the follow-up push", () => {
                const followUp = plans[plans.length - 1];
                expect(followUp.depth).toBe(mode);
                expect(followUp.tripwireRearmed).toBe(false);
            });
        }
    });
});
