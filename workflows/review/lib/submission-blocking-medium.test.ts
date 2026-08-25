import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The ROUTING `re-review <mode> blocking-medium` modifier's posting surface
 * and the medium tier's submission-side mechanics (PRA-7), in their own file
 * per the submission-blocking-only precedent (max-lines budget).
 *
 * What these pin: at a reduced executed depth with `routing.json`'s
 * `reReviewBlockingMedium` set, blocking and medium-importance findings post
 * inline (medium spends the non-blocking budget) while minor findings
 * collapse; medium outranks minor for the budget at full depth; the
 * changed-lines veto strips the tier from claims not anchored on an added
 * diff line; and every plan notes its post-veto medium count, zero
 * included (the day-one calibration instrument). The fixtures are small
 * local copies of submission-blocking-only.test.ts's, plus a staged
 * `full.diff` whose added lines cover the medium claims' anchors.
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
    routing: Record<string, unknown> = {reReviewBlockingMedium: true},
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

describe("runSubmissionCli: re-review blocking-medium", () => {
    it("posts medium inline and collapses minor at reduced depth", () => {
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
        expect(plan.event).toBe("APPROVE");
        expect(plan.comments).toHaveLength(1);
        expect(plan.comments[0].line).toBe(2);
        expect(plan.body).toContain(
            "Non-blocking observations (1; top: `a.ts:9` suggestion (non-blocking): Rename the helper.)",
        );
        expect(plan.notes.join(" ")).toContain(
            "1 non-blocking claim(s) collapsed into the body (re-review blocking-medium)",
        );
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (re-review mode scoped, blocking-medium).",
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
                    // stripped, so under blocking-medium the claim collapses.
                    claim({id: "drifted", line: 40, importance: "medium"}),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(0);
        expect(plan.body).toContain("Non-blocking observations (1");
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

    it("strict blocking-only still collapses a medium claim (the rollback dial)", () => {
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
        expect(plan.comments).toHaveLength(0);
        expect(plan.body).toContain("Non-blocking observations (1");
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
        expect(plan.comments).toHaveLength(1);
        expect(plan.comments[0].line).toBe(2);
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
        expect(plan.comments).toHaveLength(0);
        expect(plan.notes).toContainEqual(
            "medium veto ran with no staged diff (all medium claims demoted)",
        );
        expect(plan.notes).toContainEqual(
            "medium-importance claims this run: 0",
        );
    });
});
