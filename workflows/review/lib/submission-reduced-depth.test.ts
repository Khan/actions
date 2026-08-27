import {describe, it, expect} from "vitest";

import {DISMISSAL_MESSAGE} from "./submission-clearance";
import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The full-roster approval rule and the reduced-depth clearance:
 * APPROVE only at depths that dispatch the whole roster (`full`, `scoped`).
 * At flip-gated/fast a would-be APPROVE demotes to COMMENT, and a prior
 * REQUEST_CHANGES whose blocking objections are all resolved is cleared by
 * a staged dismissal decision (`out/dismiss-decision.json`, executed by the
 * deterministic post-step) instead of an approval no full roster stands
 * behind. Split from submission.test.ts for the same reason every sibling
 * split happened: the shared eslint config caps a file at 1000 lines.
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (
    files: Record<string, string> = {},
): SubmissionFs & {
    files: Record<string, string>;
    rmSync: (p: string, opts: {force: boolean}) => void;
} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) =>
            p in state || Object.keys(state).some((f) => f.startsWith(`${p}/`)),
        mkdirSync: () => {},
        rmSync: (p: string) => {
            delete state[p];
        },
    };
};

/**
 * Stage a reduced-depth run over a prior REQUEST_CHANGES: the stamp rides
 * the cache-memory carrier (posted bodies never keep theirs), and
 * prior-reviews.json carries the standing review's id and state (the
 * dismissal target stage-pr.ts now stages).
 */
const stagedReduced = (
    depth: string,
    overrides: {
        priorReviews?: unknown[];
        priorVerdict?: string;
        keep?: unknown[];
        resolve?: string[];
        noteLines?: string[];
    } = {},
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
        depth,
        claims: [],
        noteLines: overrides.noteLines ?? [],
        reconciliation: {
            resolve: overrides.resolve ?? ["t1"],
            keep: overrides.keep ?? [],
        },
    }),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth,
        mode: "fast",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
    [`${REVIEW}/prior-reviews.json`]: JSON.stringify(
        overrides.priorReviews ?? [
            {
                body: "Changes requested — see inline comments.",
                submittedAt: "2026-08-25T00:00:00Z",
                id: 3001,
                state: "CHANGES_REQUESTED",
            },
        ],
    ),
    [`${REVIEW}/threads.json`]: JSON.stringify([
        {
            thread_id: "t1",
            path: "a.ts",
            line: 2,
            comments: [
                {
                    author: "github-actions[bot]",
                    body: "**issue (blocking):** broken",
                },
            ],
        },
    ]),
    [`${REVIEW}/out/thread-reconciler.json`]: JSON.stringify({
        resolve: overrides.resolve ?? ["t1"],
        keep: overrides.keep ?? [],
    }),
    [`${REVIEW}/pr-context.json`]: JSON.stringify({
        number: 41007,
        repo: "Khan/webapp",
    }),
    "/tmp/gh-aw/cache-memory/pr-41007.json": JSON.stringify({
        verdict: overrides.priorVerdict ?? "REQUEST_CHANGES",
        stampHunks: {"a.ts": ["deadbeef00000000"]},
        wasDraft: false,
    }),
});

describe("the full-roster approval rule", () => {
    it("demotes a would-be APPROVE to COMMENT at fast depth and stages the dismissal decision", () => {
        // Prior REQUEST_CHANGES, the reconciler resolved the blocking
        // thread: the old path minted an APPROVE here; the rule keeps the
        // COMMENT and clears the block by dismissal instead.
        const fs = makeFakeFs(stagedReduced("fast"));
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.notes).toContainEqual(
            "APPROVE demoted to COMMENT: approval requires a full-roster review, and this run dispatched fast depth",
        );
        const decision = JSON.parse(
            fs.files[`${REVIEW}/out/dismiss-decision.json`],
        );
        expect(decision).toEqual({
            reviewIds: [3001],
            message: DISMISSAL_MESSAGE,
        });
        // The explanatory note rides the posted body (the timeline's
        // dismissal message alone would leave the review unexplained).
        expect(plan.body).toContain(
            "Note: every blocking objection is resolved; the standing request-changes review is dismissed rather than approved (approval requires a full-roster review round).",
        );
        // Resolutions still queue; the round posts (skip is for the
        // nothing-to-say shape only).
        expect(plan.resolve).toEqual(["t1"]);
        expect(plan.skipSubmission).toBe(false);
    });

    it("stages the dismissal at flip-gated depth too", () => {
        const fs = makeFakeFs(stagedReduced("flip-gated"));
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/dismiss-decision.json`])
                .reviewIds,
        ).toEqual([3001]);
    });

    it("dismisses every standing CHANGES_REQUESTED review, not just the latest", () => {
        const fs = makeFakeFs(
            stagedReduced("fast", {
                priorReviews: [
                    {body: "r1", id: 3001, state: "CHANGES_REQUESTED"},
                    {body: "r2", id: 3002, state: "COMMENTED"},
                    {body: "r3", id: 3003, state: "CHANGES_REQUESTED"},
                ],
            }),
        );
        runSubmissionCli(fs);
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/dismiss-decision.json`])
                .reviewIds,
        ).toEqual([3001, 3003]);
    });

    it("keeps the block standing when a kept blocking thread remains (no dismissal)", () => {
        const fs = makeFakeFs(
            stagedReduced("fast", {resolve: [], keep: ["t1"]}),
        );
        const plan = runSubmissionCli(fs);
        // The flip floor forces REQUEST_CHANGES; nothing is dismissed.
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
    });

    it("skips the dismissal when prior-reviews.json carries no review id (older staging)", () => {
        const fs = makeFakeFs(
            stagedReduced("fast", {
                priorReviews: [
                    {body: "Changes requested — see inline comments."},
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
        expect(plan.notes).toContainEqual(
            "prior request-changes stands: prior-reviews.json carries no dismissable review id (older staging)",
        );
    });

    it("skips the submission entirely when a demoted round has nothing to say", () => {
        // Prior APPROVE, nothing resolved, nothing posted: the old path
        // would have re-approved (re-granting state after
        // dismiss-stale-approvals on commits nothing reviewed); the new
        // path demotes and queues nothing at all.
        const fs = makeFakeFs(
            stagedReduced("fast", {priorVerdict: "APPROVE", resolve: []}),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(true);
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
    });

    it("posts the demoted COMMENT when the round resolved threads (the accountability surface)", () => {
        const fs = makeFakeFs(stagedReduced("fast", {priorVerdict: "APPROVE"}));
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(false);
        expect(plan.resolve).toEqual(["t1"]);
    });

    it("posts (never skips) when a standing block is cleared, resolutions or none", () => {
        // Standing REQUEST_CHANGES, nothing resolved this round (the
        // objections were already resolved earlier): the dismissal still
        // stages, and the COMMENT carrying its explanatory note must post
        // (the !priorRcStands guard on the skip).
        const fs = makeFakeFs(stagedReduced("fast", {resolve: []}));
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(false);
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/dismiss-decision.json`])
                .reviewIds,
        ).toEqual([3001]);
        expect(plan.body).toContain("dismissed rather than approved");
    });

    it("posts (never skips) when a mandatory disclosure note rides the body", () => {
        // Same nothing-to-say shape as the skip case, except the dispatcher
        // rendered a shed/unavailable note: skipping would withhold the
        // disclosure on every later run (the drift that shipped once over
        // the collapsed section).
        const fs = makeFakeFs(
            stagedReduced("fast", {
                priorVerdict: "APPROVE",
                resolve: [],
                noteLines: [
                    "Note: claim validation not assessed this run (claim-validator output unavailable).",
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(false);
        expect(plan.body).toContain("not assessed this run");
    });

    it("clears a stale dismissal decision when the plan decides against one", () => {
        // A decision staged by an earlier plan-CLI invocation in the same
        // run must not survive a later invocation that kept the block: the
        // executor would otherwise act on a dismissal the final plan never
        // licensed.
        const fs = makeFakeFs({
            ...stagedReduced("fast", {resolve: [], keep: ["t1"]}),
            [`${REVIEW}/out/dismiss-decision.json`]: JSON.stringify({
                reviewIds: [3001],
                message: DISMISSAL_MESSAGE,
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
    });

    // The scoped-depth COMMENT-to-APPROVE upgrade (the full-roster path
    // the rule deliberately keeps) is pinned in
    // submission-blocking-medium.test.ts ("the COMMENT verdict's
    // prior-state guard").
});
