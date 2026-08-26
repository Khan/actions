import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The medium tier's submission-side mechanics (PRA-7), in their own file
 * per the submission-rereview-surface precedent (max-lines budget). The
 * blocking-medium posting modifier is retired (PRA-53: repeat reviews post
 * the full surface), so nothing here keys on routing flags anymore.
 *
 * What these pin: medium outranks minor for the budget; the changed-lines
 * veto strips the tier from claims not anchored on an added diff line; a
 * posted or collapsed medium demotes the approval to COMMENT while a
 * vetoed one does not; and every plan notes its post-veto medium count,
 * zero included (the day-one calibration instrument). The fixtures are
 * small local copies of submission-rereview-surface.test.ts's, plus a
 * staged `full.diff` whose added lines cover the medium claims' anchors.
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (
    files: Record<string, string> = {},
): SubmissionFs & {files: Record<string, string>} => {
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
    };
};

const claim = (overrides: Record<string, unknown> = {}) => ({
    id: "c1",
    source: "correctness-reviewer",
    path: "a.ts",
    line: 2,
    label: "note (non-blocking)",
    subject: "The guard never fires.",
    discussion: "The reply guard cannot see the staged login spelling.",
    failure_scenario: "f",
    confidence: 0.9,
    ...overrides,
});

/** a.ts lines 1-9 all added, so anchors 1-9 survive the veto. */
const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -0,0 +1,9 @@",
    ...Array.from({length: 9}, (_, i) => `+line ${i + 1}`),
    "",
].join("\n");

const staged = (
    dispatchResult: Record<string, unknown>,
    routing: Record<string, unknown> = {},
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify(dispatchResult),
    [`${REVIEW}/full.diff`]: DIFF,
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: dispatchResult["depth"] ?? "full",
        mode: "scoped",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
    [`${REVIEW}/routing.json`]: JSON.stringify(routing),
});

describe("runSubmissionCli: the medium tier at reduced depth", () => {
    it("posts medium and minor inline (full surface, PRA-53)", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({id: "medium", importance: "medium"}),
                    claim({
                        id: "minor",
                        line: 9,
                        label: "suggestion (non-blocking)",
                        subject: "Rename the helper.",
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        // A posted medium demotes the would-be approval to the middle
        // verdict (PRA-7): the run neither vouches nor demands a round.
        expect(plan.event).toBe("COMMENT");
        expect(plan.body).toContain(
            "Commented — medium-importance findings found; nothing blocks.",
        );
        // Both post inline: the retired blocking-medium modifier no longer
        // collapses the minor claim.
        expect(plan.comments).toHaveLength(2);
        expect(plan.comments.map((c) => c.line)).toEqual([2, 9]);
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (re-review mode scoped).",
        );
        expect(plan.notes).toContainEqual(
            "medium-importance claims this run: 1",
        );
    });

    it("notes a zero medium count (the under-use instrument)", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [claim({id: "minor"})],
            }),
        );
        expect(runSubmissionCli(fs).notes).toContainEqual(
            "medium-importance claims this run: 0",
        );
    });

    it("vetoes medium off a claim not anchored on an added line", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    // Line 40 is outside the diff's added lines: the tier is
                    // stripped and the claim posts as an ordinary minor one.
                    claim({id: "drifted", line: 40, importance: "medium"}),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(1);
        expect(plan.notes).toContainEqual(
            "medium-importance claims this run: 0",
        );
    });

    it("the nitpick ban wins over the tier", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({
                        id: "nit",
                        label: "nitpick (non-blocking)",
                        importance: "medium",
                    }),
                ],
            }),
        );
        expect(runSubmissionCli(fs).comments).toHaveLength(0);
    });

    it("medium spends the non-blocking budget like any other claim", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: Array.from({length: 5}, (_, i) =>
                    claim({
                        id: `m${i + 1}`,
                        line: i + 1,
                        importance: "medium",
                    }),
                ),
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(3);
        expect(plan.notes.join(" ")).toContain(
            "2 non-blocking claim(s) collapsed over the inline budget",
        );
    });

    it("a leftover blocking-only routing flag no longer collapses anything", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [claim({id: "medium", importance: "medium"})],
                },
                {reReviewBlockingOnly: true},
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(1);
    });

    it("ranks medium ahead of higher-confidence minor claims at full depth", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "full",
                    claims: [
                        claim({
                            id: "minor-1",
                            line: 1,
                            label: "suggestion (non-blocking)",
                            confidence: 0.95,
                        }),
                        claim({
                            id: "minor-2",
                            line: 3,
                            label: "suggestion (non-blocking)",
                            confidence: 0.9,
                        }),
                        claim({
                            id: "minor-3",
                            line: 4,
                            label: "suggestion (non-blocking)",
                            confidence: 0.85,
                        }),
                        claim({
                            id: "medium",
                            line: 9,
                            importance: "medium",
                            confidence: 0.6,
                        }),
                    ],
                },
                {nonBlockingInlineBudget: 1},
            ),
        );
        const plan = runSubmissionCli(fs);
        // Budget 1: the medium claim takes the slot despite the lowest
        // confidence in the set.
        expect(plan.comments).toHaveLength(1);
        expect(plan.comments[0].line).toBe(9);
    });
});

describe("the veto's diff sources", () => {
    it("vetoes against scoped.diff when the scoped run staged one", () => {
        const files = staged({
            depth: "scoped",
            claims: [
                claim({id: "in-scoped", line: 2, importance: "medium"}),
                claim({id: "outside", line: 9, importance: "medium"}),
            ],
        });
        // The scoped diff carries only line 2: reviewers on this run saw
        // only that hunk, so only the claim anchored inside it keeps the
        // tier; line 9 is added in full.diff but not in this run's view.
        files[`${REVIEW}/scoped.diff`] = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,1 +1,2 @@",
            " line 1",
            "+line 2",
            "",
        ].join("\n");
        const plan = runSubmissionCli(makeFakeFs(files));
        // Both post inline (full surface); only the in-scoped one keeps
        // the tier.
        expect(plan.comments).toHaveLength(2);
        expect(plan.notes).toContainEqual(
            "medium-importance claims this run: 1",
        );
    });

    it("notes the demotion when no diff is staged at all", () => {
        const files = staged({
            depth: "scoped",
            claims: [claim({id: "medium", importance: "medium"})],
        });
        delete files[`${REVIEW}/full.diff`];
        const plan = runSubmissionCli(makeFakeFs(files));
        // The demoted claim posts as an ordinary minor one.
        expect(plan.comments).toHaveLength(1);
        expect(plan.notes).toContainEqual(
            "medium veto ran with no staged diff (all medium claims demoted)",
        );
        expect(plan.notes).toContainEqual(
            "medium-importance claims this run: 0",
        );
    });
});

describe("the COMMENT verdict", () => {
    it("a vetoed medium does not demote the approval", () => {
        // Line 40 is outside the diff: the tier is stripped, the medium
        // count is 0, and the verdict stays APPROVE.
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({id: "drifted", line: 40, importance: "medium"}),
                ],
            }),
        );
        expect(runSubmissionCli(fs).event).toBe("APPROVE");
    });

    it("a collapsed medium still demotes (the verdict follows what the run found)", () => {
        // The confidence floor collapses the medium's surface, but the
        // finding was verified and anchored: the verdict comments anyway,
        // same invariant that keeps a collapsed blocking claim blocking.
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({
                        id: "medium",
                        importance: "medium",
                        confidence: 0.4,
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(0);
        expect(plan.event).toBe("COMMENT");
    });

    it("blocking still outranks medium", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({id: "medium", importance: "medium"}),
                    claim({
                        id: "blocking",
                        line: 9,
                        label: "issue (blocking)",
                    }),
                ],
            }),
        );
        expect(runSubmissionCli(fs).event).toBe("REQUEST_CHANGES");
    });
});

describe("the COMMENT verdict's prior-state guard", () => {
    it("upgrades COMMENT to APPROVE over a prior REQUEST_CHANGES stamp", () => {
        // GitHub state only moves on APPROVE or REQUEST_CHANGES: a COMMENT
        // would leave the bot's own prior block standing after the author
        // fixed every blocking objection.
        const files = staged({
            depth: "scoped",
            claims: [claim({id: "medium", importance: "medium"})],
        });
        files[`${REVIEW}/pr-context.json`] = JSON.stringify({number: 7});
        files[`/tmp/gh-aw/cache-memory/pr-7.json`] = JSON.stringify({
            verdict: "REQUEST_CHANGES",
            wasDraft: false,
            reviewedHunks: {"a.ts": ["h1"]},
        });
        const plan = runSubmissionCli(makeFakeFs(files));
        expect(plan.event).toBe("APPROVE");
        expect(plan.notes).toContainEqual(
            "COMMENT verdict upgraded to APPROVE: a comment cannot clear the prior request-changes state, and every blocking objection is resolved",
        );
    });
});
