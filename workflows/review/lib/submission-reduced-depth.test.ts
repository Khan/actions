import {describe, it, expect} from "vitest";

import {renderRereviewStamp} from "./rereview-mode";
import {
    decideEventAndClearance,
    decideSkipSubmission,
    DISMISSAL_MESSAGE,
} from "./submission-clearance";
import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * A review body carrying this workflow's stamp: identity for the standing
 * predicate (a foreign workflow's review shares the bot login but never
 * the stamp) AND the prior-verdict anchor (findLatestStamp reads the
 * latest body stamp before falling back to cache-memory).
 */
const stampedBody = (verdict: string, head = "review body"): string =>
    `${head}\n${renderRereviewStamp({
        schemaVersion: 1,
        depth: "full",
        verdict,
        anchorDraft: false,
        anchorHunks: {"a.ts": ["deadbeef00000000"]},
    })}`;

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
                body: stampedBody(
                    overrides.priorVerdict ?? "REQUEST_CHANGES",
                    "Changes requested — see inline comments.",
                ),
                submittedAt: "2026-08-25T00:00:00Z",
                id: 3001,
                state:
                    (overrides.priorVerdict ?? "REQUEST_CHANGES") ===
                    "REQUEST_CHANGES"
                        ? "CHANGES_REQUESTED"
                        : "DISMISSED",
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
        {
            thread_id: "t2",
            path: "a.ts",
            line: 9,
            comments: [
                {
                    author: "github-actions[bot]",
                    body: "**suggestion (non-blocking):** style",
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
            "Note: every blocking objection is resolved; the standing request-changes review is being dismissed rather than approved (approval requires a full-roster review round; if the dismissal did not take effect, the block stands).",
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
                    {
                        body: stampedBody("REQUEST_CHANGES", "r1"),
                        id: 3001,
                        state: "CHANGES_REQUESTED",
                    },
                    {body: "r2", id: 3002, state: "COMMENTED"},
                    {
                        body: stampedBody("REQUEST_CHANGES", "r3"),
                        id: 3003,
                        state: "CHANGES_REQUESTED",
                    },
                ],
            }),
        );
        runSubmissionCli(fs);
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/dismiss-decision.json`])
                .reviewIds,
        ).toEqual([3001, 3003]);
    });

    it("keeps the block standing when the stamp says COMMENT and a blocking thread is kept", () => {
        // Recovery shape: the stamp is COMMENT (a prior demoted round), so
        // the flip floor does not apply; the live CHANGES_REQUESTED still
        // stands, and keptBlockingCount is the only thing between this
        // round and dismissing a review whose blocking objection the
        // reconciler kept.
        const fs = makeFakeFs(
            stagedReduced("fast", {
                resolve: [],
                keep: ["t1"],
                priorReviews: [
                    {
                        body: stampedBody("REQUEST_CHANGES", "r1"),
                        id: 3001,
                        state: "CHANGES_REQUESTED",
                    },
                    {
                        body: stampedBody("COMMENT", "r2"),
                        id: 3002,
                        state: "COMMENTED",
                    },
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
        expect(plan.body).not.toContain("dismissed rather than approved");
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
            // The default staging derives the live state from the stamp
            // verdict: a prior APPROVE means nothing stands.
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

    it("posts (never skips) when a kept thread renders the accountability section", () => {
        // A kept NON-blocking thread does not floor the verdict, but the
        // accountability section it renders rides the head: skipping would
        // withhold that record (the third body carrier, beside the
        // collapsed section and the disclosure notes).
        const fs = makeFakeFs(
            stagedReduced("fast", {
                priorVerdict: "APPROVE",
                resolve: [],
                keep: ["t2"],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(false);
    });

    it("re-stages the dismissal when the stamp says COMMENT but the block still stands", () => {
        // The failed-executor shape: a prior reduced round demoted and
        // stamped COMMENT, but its best-effort dismissal never executed,
        // so GitHub still shows the CHANGES_REQUESTED review. The live
        // state (prior-reviews.json) keeps priorRcStands true, so this
        // round retries the clearance instead of skipping past it.
        const fs = makeFakeFs(
            stagedReduced("fast", {
                resolve: [],
                priorReviews: [
                    {
                        body: stampedBody("REQUEST_CHANGES", "r1"),
                        id: 3001,
                        state: "CHANGES_REQUESTED",
                    },
                    {
                        body: stampedBody("COMMENT", "r2"),
                        id: 3002,
                        state: "COMMENTED",
                    },
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(false);
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/dismiss-decision.json`])
                .reviewIds,
        ).toEqual([3001]);
    });

    it("clears a stale dismissal decision on the hold path (the early return)", () => {
        // A skipped core dimension resolves to HOLD_FOR_HUMAN, which
        // returns before the clearance decision: the stale decision from
        // an earlier invocation must still be cleared.
        const fs = makeFakeFs({
            ...stagedReduced("full"),
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [],
                skippedDimensions: [{dimension: "correctness-reviewer"}],
                reconciliation: {resolve: [], keep: []},
            }),
            [`${REVIEW}/out/dismiss-decision.json`]: JSON.stringify({
                reviewIds: [3001],
                message: DISMISSAL_MESSAGE,
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("HOLD_FOR_HUMAN");
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
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

    it("posts (never skips) when a pr-level claim folds into the body", () => {
        // The third-and-a-half carrier: a validated pr-level claim (no
        // path/line anchor) folds into prLevelLines, and skipping would
        // withhold it.
        const staged = stagedReduced("fast", {
            priorVerdict: "APPROVE",
            resolve: [],
        });
        staged[`${REVIEW}/dispatch-result.json`] = JSON.stringify({
            depth: "fast",
            claims: [
                {
                    id: "c1",
                    source: "correctness-reviewer",
                    label: "note (non-blocking)",
                    subject: "The guard never fires.",
                    discussion: "d",
                    failure_scenario: "f",
                    confidence: 0.9,
                },
            ],
            reconciliation: {resolve: [], keep: []},
        });
        const fs = makeFakeFs(staged);
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(false);
    });

    it("a CHANGES_REQUESTED superseded by a later APPROVED is not standing", () => {
        // GitHub derives the effective state from the latest decisive
        // review: the [blocked, then cleared] history every approved PR
        // carries must not read as a standing block (it would re-stage
        // dismissals and upgrade full-round COMMENTs on stale evidence).
        // The latest body stamp (APPROVE) also anchors the prior verdict.
        const fs = makeFakeFs(
            stagedReduced("fast", {
                resolve: [],
                priorReviews: [
                    {
                        body: stampedBody("REQUEST_CHANGES", "r1"),
                        id: 3001,
                        state: "CHANGES_REQUESTED",
                    },
                    {
                        body: stampedBody("APPROVE", "r2"),
                        id: 3005,
                        state: "APPROVED",
                    },
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("COMMENT");
        expect(plan.skipSubmission).toBe(true);
        expect(fs.files[`${REVIEW}/out/dismiss-decision.json`]).toBe(undefined);
    });

    // The scoped-depth COMMENT-to-APPROVE upgrade (the full-roster path
    // the rule deliberately keeps) is pinned in
    // submission-blocking-medium.test.ts ("the COMMENT verdict's
    // prior-state guard").
});

describe("decideEventAndClearance (the pure decision)", () => {
    const base = {
        verdictEvent: "COMMENT" as const,
        depth: "full",
        priorStamp: null,
        keptBlockingCount: 0,
        suppressedBlocking: 0,
        canary: false,
    };

    it("canary: every verdict submits as COMMENT with the would-be verdict in the body Note", () => {
        for (const verdictEvent of ["REQUEST_CHANGES", "APPROVE"] as const) {
            const result = decideEventAndClearance({
                ...base,
                verdictEvent,
                canary: true,
            });
            expect(result.event).toBe("COMMENT");
            expect(result.approveDemoted).toBe(false);
            expect(result.dismissal).toBeNull();
            expect(result.bodyNote).toContain(
                `The verdict would have been ${verdictEvent}`,
            );
            expect(result.notes.join(" ")).toContain("canary run");
        }
        // A genuine COMMENT verdict needs no note: nothing was demoted.
        const comment = decideEventAndClearance({...base, canary: true});
        expect(comment.event).toBe("COMMENT");
        expect(comment.bodyNote).toBeNull();
    });

    it("canary: never takes the COMMENT-to-APPROVE upgrade over a standing block", () => {
        // Degenerate by construction (canary staging writes priors empty),
        // but the pure function must not upgrade to APPROVE on any input.
        const result = decideEventAndClearance({
            ...base,
            canary: true,
            priorReviewsRaw: [
                {
                    id: 7,
                    state: "CHANGES_REQUESTED",
                    body: stampedBody("REQUEST_CHANGES"),
                },
            ],
        });
        expect(result.event).toBe("COMMENT");
    });

    it("upgrades a full-round COMMENT over a live standing block (failed-dismissal recovery)", () => {
        const result = decideEventAndClearance({
            ...base,
            priorReviewsRaw: [
                {
                    body: stampedBody("REQUEST_CHANGES"),
                    id: 3001,
                    state: "CHANGES_REQUESTED",
                },
            ],
        });
        expect(result.event).toBe("APPROVE");
        expect(result.priorRcStands).toBe(true);
        expect(result.dismissal).toBe(null);
    });

    it("keeps a full-round COMMENT when a later APPROVED superseded the block", () => {
        const result = decideEventAndClearance({
            ...base,
            priorReviewsRaw: [
                {
                    body: stampedBody("REQUEST_CHANGES"),
                    id: 3001,
                    state: "CHANGES_REQUESTED",
                },
                {body: stampedBody("APPROVE"), id: 3005, state: "APPROVED"},
            ],
        });
        expect(result.event).toBe("COMMENT");
        expect(result.priorRcStands).toBe(false);
        expect(result.dismissal).toBe(null);
    });

    it("stands a CHANGES_REQUESTED posted after the last APPROVED", () => {
        const result = decideEventAndClearance({
            ...base,
            verdictEvent: "APPROVE",
            depth: "fast",
            priorReviewsRaw: [
                {body: stampedBody("APPROVE"), id: 3001, state: "APPROVED"},
                {
                    body: stampedBody("REQUEST_CHANGES"),
                    id: 3007,
                    state: "CHANGES_REQUESTED",
                },
            ],
        });
        expect(result.event).toBe("COMMENT");
        expect(result.dismissal).toEqual({
            reviewIds: [3007],
            message: DISMISSAL_MESSAGE,
        });
    });

    it("the redundant-approval skip never fires over a standing block", () => {
        // The dismissed-approval shape: the stamp says APPROVE, but that
        // approval's review is DISMISSED (dismiss-stale-approvals), so the
        // older CHANGES_REQUESTED stands again. Posting the APPROVE
        // supersedes it; skipping would leave the author blocked.
        const base = {
            event: "APPROVE",
            approveDemoted: false,
            inlineCount: 0,
            resolveCount: 0,
            bareApproveBody: true,
            priorApproveStands: true,
            bodyCarriesOnlyDepthNote: true,
        };
        expect(decideSkipSubmission({...base, priorRcStands: true})).toBe(
            false,
        );
        expect(decideSkipSubmission({...base, priorRcStands: false})).toBe(
            true,
        );
    });

    it("an unrecognized depth demotes but never stages a dismissal", () => {
        // The gate resolves an unrecognized depth to full and would block
        // the decision as unlicensed (rule 5c): two safe defaults must not
        // cancel into a red run.
        const result = decideEventAndClearance({
            ...base,
            verdictEvent: "APPROVE",
            depth: "warp",
            priorReviewsRaw: [
                {
                    body: stampedBody("REQUEST_CHANGES"),
                    id: 3001,
                    state: "CHANGES_REQUESTED",
                },
            ],
        });
        expect(result.event).toBe("COMMENT");
        expect(result.approveDemoted).toBe(true);
        expect(result.dismissal).toBe(null);
    });
});
