import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * Submission-plan tests for the post-trial follow-ups: risks/patterns key
 * staging, the inline posting bar, and the open-thread suppression verdict
 * floor. Split from submission.test.ts by the max-lines budget; the fixtures
 * below are small local copies of that file's helpers.
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
    label: "issue (blocking)",
    subject: "s",
    discussion: "The guard was removed.",
    failure_scenario: "f",
    confidence: 0.9,
    ...overrides,
});

const staged = (
    dispatchResult: Record<string, unknown>,
    extra: Record<string, string> = {},
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify(dispatchResult),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: dispatchResult["depth"] ?? "full",
        mode: "full",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
    ...extra,
});

describe("risks/patterns key staging (trial suggestion b)", () => {
    const KEY_PATH = `${REVIEW}/risks-patterns-key.txt`;
    const triaged = {
        claims: [],
        riskFiles: [
            {path: "a.ts", risk: "High"},
            {path: "b.ts", risk: "Medium"},
            {path: "c.ts", risk: "Low"},
        ],
        patterns: ["bump-deps"],
        excludedFiles: ["gen.ts"],
    };

    it("stages the canonical signature at full depth, owners from routing.json", () => {
        const fs = makeFakeFs(
            staged(
                {depth: "full", ...triaged},
                {
                    [`${REVIEW}/routing.json`]: JSON.stringify({
                        teams: {owners: {"a.ts": ["team-b", "team-a"]}},
                    }),
                },
            ),
        );
        runSubmissionCli(fs);
        expect(fs.files[KEY_PATH]).toBe(
            [
                "excluded:gen.ts",
                "pattern:bump-deps=",
                "risk:a.ts=team-a+team-b",
                "risk:b.ts=",
            ].join("|"),
        );
    });

    it("stages nothing at any reduced depth (Step 7 skips them; a scoped subset must not overwrite the full signature)", () => {
        for (const depth of ["scoped", "flip-gated", "fast"]) {
            const fs = makeFakeFs(staged({depth, ...triaged}));
            runSubmissionCli(fs);
            expect(fs.files[KEY_PATH]).toBeUndefined();
        }
    });
});

describe("the inline posting bar (the Step 5 cap, as code)", () => {
    const manyClaims = (count: number, over: Record<string, unknown> = {}) =>
        Array.from({length: count}, (_, index) =>
            claim({
                id: `c${index + 1}`,
                line: index + 1,
                subject: `finding ${index + 1}`,
                ...over,
            }),
        );

    it("caps inline comments at 20, collapsing the overflow into the top comment", () => {
        // 22 blocking claims, confidence descending so the ranking is
        // deterministic: the two weakest collapse.
        const claims = manyClaims(22).map((entry, index) => ({
            ...entry,
            confidence: 0.99 - index * 0.01,
        }));
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        expect(plan.comments).toHaveLength(20);
        expect(plan.comments[0].body).toContain(
            "Lower-confidence observations (2; top: a.ts:21 issue (blocking): finding 21)",
        );
        expect(plan.comments[0].body).toContain("`a.ts:21`");
        expect(plan.comments[0].body).toContain("`a.ts:22`");
        // A collapsed blocking claim still drives the verdict.
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(plan.notes).toContainEqual(
            "2 claim(s) collapsed below the inline bar (cap 20, medium-confidence floor, non-blocking budget 3)",
        );
    });

    it("ranks blocking claims into the cap ahead of higher-confidence non-blocking ones", () => {
        const claims = [
            ...manyClaims(20, {
                label: "suggestion (non-blocking)",
                confidence: 0.9,
            }),
            claim({
                id: "blocker",
                line: 99,
                confidence: 0.6,
                subject: "the blocker",
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        // The blocking claim posts inline first; the non-blocking budget
        // (default 3) admits the next three in ranked order, and the rest
        // collapse with the budget-shed note.
        expect(plan.comments).toHaveLength(4);
        expect(plan.comments[0].line).toBe(99);
        expect(plan.comments[0].body).toContain(
            "Lower-confidence observations (17; top: a.ts:4 suggestion (non-blocking): finding 4)",
        );
        expect(plan.notes).toContainEqual(
            "17 non-blocking claim(s) collapsed over the inline budget (non-blocking budget 3)",
        );
    });

    it("reads the non-blocking budget from routing.json", () => {
        const claims = manyClaims(3, {
            label: "suggestion (non-blocking)",
            confidence: 0.9,
        });
        const plan = runSubmissionCli(
            makeFakeFs(
                staged(
                    {depth: "full", claims},
                    {
                        [`${REVIEW}/routing.json`]: JSON.stringify({
                            nonBlockingInlineBudget: 1,
                        }),
                    },
                ),
            ),
        );
        expect(plan.comments).toHaveLength(1);
        expect(plan.notes).toContainEqual(
            "2 non-blocking claim(s) collapsed over the inline budget (non-blocking budget 1)",
        );
    });

    it("never posts a nitpick inline, budget or no budget", () => {
        const claims = [
            claim({
                id: "nit",
                line: 1,
                label: "nitpick (non-blocking)",
                confidence: 0.95,
                subject: "rename it",
            }),
            claim({
                id: "sug",
                line: 2,
                label: "suggestion (non-blocking)",
                confidence: 0.6,
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        // The lower-confidence suggestion posts; the nitpick collapses
        // despite outranking it on confidence.
        expect(plan.comments).toHaveLength(1);
        expect(plan.comments[0].line).toBe(2);
        expect(plan.comments[0].body).toContain(
            "Lower-confidence observations (1; top: a.ts:1 nitpick (non-blocking): rename it)",
        );
    });

    it("exempts documentation-label claims from the budget (autofix selects by posted label)", () => {
        const claims = [
            ...manyClaims(3, {
                label: "suggestion (non-blocking)",
                confidence: 0.9,
            }),
            claim({
                id: "doc",
                line: 30,
                label: "suggestion (non-blocking, documentation)",
                confidence: 0.6,
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        // Three suggestions spend the whole budget; the documentation claim
        // still posts inline (it must become a thread for the documentation
        // autofix to see it).
        expect(plan.comments).toHaveLength(4);
        expect(plan.comments.map((entry) => entry.line)).toContain(30);
    });

    it("collapses sub-medium-confidence non-blocking claims even under the cap", () => {
        const claims = [
            claim({
                id: "strong",
                line: 1,
                label: "suggestion (non-blocking)",
                confidence: 0.8,
            }),
            claim({
                id: "weak",
                line: 2,
                label: "thought (non-blocking)",
                confidence: 0.3,
                subject: "a hunch",
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        expect(plan.comments).toHaveLength(1);
        expect(plan.comments[0].line).toBe(1);
        expect(plan.comments[0].body).toContain("a hunch");
        expect(plan.event).toBe("APPROVE");
    });

    it("rides the review body when nothing posts inline", () => {
        const claims = [
            claim({
                id: "weak",
                line: 2,
                label: "thought (non-blocking)",
                confidence: 0.3,
                subject: "a hunch",
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "Lower-confidence observations (1; top: a.ts:2 thought (non-blocking): a hunch)",
        );
        expect(plan.body).toContain("a hunch");
    });
});

describe("open-thread suppression verdict floor (trial suggestion g)", () => {
    it("floors the verdict at REQUEST_CHANGES when a blocking claim was suppressed as a duplicate of an open BLOCKING thread", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [],
                noteLines: [
                    "Note: 1 finding(s) not re-posted (already tracked in open review threads).",
                ],
                threadSuppressions: [
                    {
                        id: "correctness-reviewer-1",
                        source: "correctness-reviewer",
                        label: "todo (blocking)",
                        path: "a.ts",
                        line: 42,
                        thread_id: "T1",
                        threadBlocking: true,
                    },
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        // The reviewer re-confirmed a defect an open blocking thread tracks:
        // no duplicate comment posts, but the run must not flip to APPROVE.
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(plan.reasons).toContainEqual({
            code: "kept-blocking-thread",
            count: 1,
        });
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain("not re-posted");
    });

    it("does not floor on a suppressed non-blocking duplicate", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [],
                noteLines: [],
                threadSuppressions: [
                    {
                        id: "c1",
                        source: "holistic",
                        label: "suggestion (non-blocking)",
                        path: "a.ts",
                        thread_id: "T2",
                        threadBlocking: true,
                    },
                ],
            }),
        );
        expect(runSubmissionCli(fs).event).toBe("APPROVE");
    });

    it("does not floor a blocking candidate matched to a NON-blocking open thread", () => {
        // Suppression runs before validation, so the candidate's blocking
        // label is unvalidated; the matched thread's opener is the severity
        // that survived a prior run's validation. A false-positive blocking
        // candidate that text-matches an open suggestion thread must not
        // force REQUEST_CHANGES with no validation and no visible blocking
        // comment.
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [],
                noteLines: [],
                threadSuppressions: [
                    {
                        id: "correctness-reviewer-1",
                        source: "correctness-reviewer",
                        label: "issue (blocking)",
                        path: "a.ts",
                        line: 42,
                        thread_id: "T3",
                        threadBlocking: false,
                    },
                ],
            }),
        );
        expect(runSubmissionCli(fs).event).toBe("APPROVE");
    });
});

describe("the nitpick posting rules", () => {
    it("ranks nitpicks last in the collapse, whatever their confidence, and notes the shed", () => {
        const claims = [
            claim({
                id: "nit",
                line: 1,
                label: "nitpick (non-blocking)",
                confidence: 0.95,
                subject: "rename it",
            }),
            claim({
                id: "weak-thought",
                line: 2,
                label: "thought (non-blocking)",
                confidence: 0.3,
                subject: "a hunch",
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        // Both collapse (the nitpick by the ban, the thought by the
        // confidence floor), and the disclosure's top slot goes to the
        // thought: the class this surface never posts must not win the
        // summary line built for the tail's best finding.
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "Lower-confidence observations (2; top: a.ts:2 thought (non-blocking): a hunch)",
        );
        expect(plan.notes).toContainEqual(
            "1 nitpick claim(s) collapsed (nitpick-class never posts inline)",
        );
    });
});

describe("the budget's edge values", () => {
    it("a zero budget posts blocking and documentation claims only", () => {
        const claims = [
            claim({id: "blocking", line: 1, label: "issue (blocking)"}),
            claim({
                id: "doc",
                line: 2,
                label: "suggestion (non-blocking, documentation)",
                confidence: 0.9,
            }),
            claim({
                id: "sug",
                line: 3,
                label: "suggestion (non-blocking)",
                confidence: 0.9,
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(
                staged(
                    {depth: "full", claims},
                    {
                        [`${REVIEW}/routing.json`]: JSON.stringify({
                            nonBlockingInlineBudget: 0,
                        }),
                    },
                ),
            ),
        );
        expect(plan.comments.map((entry) => entry.line).sort()).toEqual([1, 2]);
        expect(plan.notes).toContainEqual(
            "1 non-blocking claim(s) collapsed over the inline budget (non-blocking budget 0)",
        );
    });

    it("a pr-level claim can be the tail's named top entry", () => {
        const claims = [
            claim({
                id: "pr-level",
                path: undefined,
                line: undefined,
                label: "note (non-blocking)",
                confidence: 0.9,
                subject: "A cross-file observation.",
            }),
            claim({
                id: "weak",
                line: 2,
                label: "thought (non-blocking)",
                confidence: 0.3,
                subject: "a hunch",
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(
                staged(
                    {depth: "scoped", claims},
                    {
                        [`${REVIEW}/routing.json`]: JSON.stringify({
                            reReviewBlockingOnly: true,
                        }),
                    },
                ),
            ),
        );
        // Both collapse under blocking-only; the pr-level note outranks the
        // low-confidence anchored thought for the summary slot.
        expect(plan.body).toContain(
            "Non-blocking observations (2; top: note (non-blocking): A cross-file observation.)",
        );
    });
});
