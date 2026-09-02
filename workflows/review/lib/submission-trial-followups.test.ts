import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * Submission-plan tests for the post-trial follow-ups and the P1 posting
 * budget: risks/patterns key staging, the inline posting bar, the
 * non-blocking budget and nitpick rules, and the open-thread suppression
 * verdict floor. Split from submission.test.ts by the max-lines budget; the
 * fixtures below are small local copies of that file's helpers.
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
        rmSync: (p: string) => {
            delete state[p];
        },
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

    it("caps inline comments at 20, collapsing the overflow into the body", () => {
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
        // The section lands in the review body (never riding an inline
        // comment: the body is what the autofix's body-sourced work list
        // and both stagers can see).
        expect(plan.body).toContain("**Lower-confidence observations (2):**");
        expect(plan.body).toContain("`a.ts:21`");
        expect(plan.body).toContain("`a.ts:22`");
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
        expect(plan.body).toContain("**Lower-confidence observations (17):**");
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
        expect(plan.body).toContain("Lower-confidence observations (1)");
        expect(plan.body).toContain(
            "- `a.ts:1` nitpick (non-blocking): rename it",
        );
    });

    it("budgets documentation-label claims like any other (autofix reads the collapsed section)", () => {
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
        // collapses, where the autofix's body-sourced work list still
        // reaches it (workflows/autofix/lib/collapsed.ts).
        expect(plan.comments).toHaveLength(3);
        expect(plan.comments.map((entry) => entry.line)).not.toContain(30);
        // The collapsed section lands in the review body, where the
        // body-sourced work list parses it.
        expect(plan.body).toContain("`a.ts:30`");
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
        expect(plan.body).toContain("a hunch");
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
        // N=1 is no longer a special case: the tail's own `<details>`
        // block (and the `<details open>` arm that kept a one-entry preview
        // from doubling the observation, Khan/actions#387) went away when
        // the body collapsed to a single fold.
        expect(plan.body).toContain("**Lower-confidence observations (1):**");
        expect(plan.body).not.toContain("<details open>");
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
        // confidence floor), and the thought leads the list: the class this
        // surface never posts must not win the tail's first slot.
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain("**Lower-confidence observations (2):**");
        const entries = plan.body
            .split("\n")
            .filter((line) => line.startsWith("- "));
        expect(entries[0]).toContain("thought (non-blocking): a hunch");
        expect(plan.notes).toContainEqual(
            "1 nitpick claim(s) collapsed (nitpick-class never posts inline)",
        );
    });
});

describe("the budget's edge values", () => {
    it("a zero budget posts blocking claims only (the doc exemption is gone)", () => {
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
        expect(plan.comments.map((entry) => entry.line)).toEqual([1]);
        expect(plan.notes).toContainEqual(
            "2 non-blocking claim(s) collapsed over the inline budget (non-blocking budget 0)",
        );
    });

    it("a pr-level claim can lead the tail", () => {
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
        // low-confidence anchored thought and so leads the list.
        expect(plan.body).toContain("**Non-blocking observations (2):**");
        const entries = plan.body
            .split("\n")
            .filter((line) => line.startsWith("- "));
        expect(entries[0]).toContain(
            "note (non-blocking): A cross-file observation.",
        );
    });
});

describe("the budget's spend order", () => {
    it("spends the budget on the highest-confidence non-blocking claims", () => {
        const claims = [
            claim({
                id: "weakest",
                line: 1,
                label: "suggestion (non-blocking)",
                confidence: 0.55,
            }),
            claim({
                id: "strongest",
                line: 2,
                label: "suggestion (non-blocking)",
                confidence: 0.95,
            }),
            claim({
                id: "middle",
                line: 3,
                label: "suggestion (non-blocking)",
                confidence: 0.75,
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(
                staged(
                    {depth: "full", claims},
                    {
                        [`${REVIEW}/routing.json`]: JSON.stringify({
                            nonBlockingInlineBudget: 2,
                        }),
                    },
                ),
            ),
        );
        // The budget spends in ranked order, so the two strongest post and
        // the weakest is the one collapsed.
        expect(plan.comments.map((entry) => entry.line).sort()).toEqual([2, 3]);
        // The shed claim lands in the review body's collapsed section.
        expect(plan.body).toContain("`a.ts:1`");
    });
});

describe("the collapsed entries' structural neutralization", () => {
    it("neutralizes a details/summary tag in an entry's subject", () => {
        // The entries now sit inside the shared `review details` fold, so a
        // live `</details>` in one bullet closes THAT fold and spills the
        // rest of the tail (config and fingerprint lines included) into the
        // visible body — the Khan/actions#401 failure, one level out.
        const hostile = "Breaks out</summary></details> <b>of the block</b>";
        const claims = [
            claim({
                id: "hostile",
                line: 2,
                label: "thought (non-blocking)",
                confidence: 0.3,
                subject: hostile,
            }),
            claim({
                id: "long",
                line: 3,
                label: "thought (non-blocking)",
                confidence: 0.2,
                subject: "x".repeat(150),
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        expect(plan.body).toContain(
            "thought (non-blocking): Breaks out(/summary)(/details)",
        );
        // The heading is a plain markdown line now: no model text rides it,
        // so there is nothing there to escape or truncate.
        expect(plan.body).toContain("**Lower-confidence observations (2):**");
        // A long subject keeps its full text: only the retired summary
        // teaser ever truncated.
        expect(plan.body).toContain("x".repeat(150));
        // Exactly one `</details>` in the whole body: the tail fold's own.
        expect(plan.body.split("</details>").length - 1).toBe(1);
    });

    it("leaves a backticked tag alone in an entry (markdown, not raw HTML)", () => {
        const claims = [
            claim({
                id: "spanned",
                line: 2,
                label: "thought (non-blocking)",
                confidence: 0.3,
                subject: "The `</details>` guard skips the sketch.",
            }),
        ];
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims})),
        );
        // The entry sits below the fold's blank line, so GFM parses it as
        // markdown and the code span is real: the finding can name the tag.
        expect(plan.body).toContain(
            "thought (non-blocking): The `</details>` guard skips the sketch.",
        );
    });
});
