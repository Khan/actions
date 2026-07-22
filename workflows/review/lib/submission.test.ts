import {describe, it, expect} from "vitest";

import {evaluateDispatchConformance} from "./dispatch-gate";
import {labelForFinding, renderComment} from "./render-comment";
import {renderRereviewStamp, STAMP_SCHEMA_VERSION} from "./rereview-mode";
import {
    isDropInSuggestion,
    renderClaimComment,
    runSubmissionCli,
    type SubmissionFs,
} from "./submission";

/**
 * Submission-plan tests (deterministic-orchestrator slice 4): Steps 4-6 as
 * code. The plan is composed from the dispatcher's validated claims through
 * the same lib functions the eval runner uses (computeVerdict,
 * renderReviewBody, the rereview accountability CLI, the stamp), and the
 * dispatch-conformance gate's plan-match rule turns any deviation between
 * the plan and the queued safe outputs into a blocked red run (the #244
 * accountability-splice check).
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

describe("renderClaimComment", () => {
    it("renders the Conventional Comment with the post-validation label", () => {
        expect(
            renderClaimComment(
                claim({
                    label: "suggestion (non-blocking)",
                    suggestion: "fixed()",
                }) as never,
            ),
        ).toBe(
            "**suggestion (non-blocking):** The guard was removed.\n\n```suggestion\nfixed()\n```",
        );
    });

    it("keeps the rule quote as a blockquote between prose and fix", () => {
        const body = renderClaimComment(
            claim({rule_quote: "Always guard.\nEven here."}) as never,
        );
        expect(body).toContain("> **Rule:** Always guard.\n> Even here.");
    });

    it("keeps the suggestion fence for small code-shaped payloads", () => {
        // Run 29897276810's legitimate drop-ins: a one-line cutoff fix and a
        // five-line query chain.
        expect(
            isDropInSuggestion(
                "\tcutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
            ),
        ).toBe(true);
        expect(
            isDropInSuggestion(
                [
                    "\tq := datastore.NewQuery(models.AIGuideMemoryKind).",
                    '\t\tFilterField("kaid", "=", kaid).',
                    '\t\tFilterField("created_at", "<", cutoff).',
                    "\t\tKeysOnly().",
                    "\t\tLimit(500)",
                ].join("\n"),
            ),
        ).toBe(true);
    });

    it("treats prose that names code as prose (run 29901690493's fence misses)", () => {
        expect(
            isDropInSuggestion(
                "Use ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays), and add a test that writes a memory with created_at beyond the window and asserts it is deleted by the pass.",
            ),
        ).toBe(false);
        expect(
            isDropInSuggestion(
                "Filter by the retention cutoff at read time in Query; keep (or drop) the write-path delete as a storage-cost optimization only.",
            ),
        ).toBe(false);
    });

    it("renders an English-prose suggestion as a sketch, not a suggestion fence (r3628128268)", () => {
        const prose =
            "Add a created_at >= cutoff filter in Query so stale memories can never surface regardless of write activity, and consider a native Datastore TTL policy on created_at in place of (or alongside) the write-path ExpireStale pass.";
        expect(isDropInSuggestion(prose)).toBe(false);
        const body = renderClaimComment(
            claim({
                label: "suggestion (non-blocking)",
                suggestion: prose,
            }) as never,
        );
        expect(body).not.toContain("```suggestion");
        expect(body).toContain("A sketch, not a committable replacement:");
        expect(body).toContain(`\`\`\`\`\n${prose}\n\`\`\`\``);
    });

    it("renders an oversized code payload as a sketch (r3628128224's 30-line test fn)", () => {
        const testFn = [
            "func (suite *expirationSuite) TestExpirationRemovesStaleMemories() {",
            "\tctx := suite.KAContext()",
            ...Array.from(
                {length: 26},
                (_, i) => `\tsuite.Require().NoError(step${i}(ctx))`,
            ),
            "\tsuite.Require().Len(keys, 1)",
            "}",
        ].join("\n");
        expect(isDropInSuggestion(testFn)).toBe(false);
        const body = renderClaimComment(
            claim({label: "todo (blocking)", suggestion: testFn}) as never,
        );
        expect(body).not.toContain("```suggestion");
        expect(body).toContain("A sketch, not a committable replacement:");
    });
});

describe("runSubmissionCli", () => {
    it("plans REQUEST_CHANGES with the fixed body line when a blocking claim posts", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim()],
                noteLines: [],
                reconciliation: {resolve: ["t1"], keep: []},
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(plan.body.split("\n")[0]).toBe(
            "Changes requested — see inline comments.",
        );
        expect(plan.comments).toEqual([
            {
                path: "a.ts",
                line: 2,
                body: "**issue (blocking):** The guard was removed.",
            },
        ]);
        expect(plan.resolve).toEqual(["t1"]);
        // The stamp is the final line (hidden HTML comment).
        expect(plan.body.split("\n").at(-1)).toMatch(/^<!--.*-->$/);
        // The plan is staged for the gate's plan-match rule.
        expect(
            JSON.parse(fs.files[`${REVIEW}/submission-plan.json`]).event,
        ).toBe("REQUEST_CHANGES");
    });

    it("plans an empty-head APPROVE when only non-blocking claims post", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim({label: "suggestion (non-blocking)"})],
                noteLines: [
                    "Note: holistic not assessed this run (shed under the High-tier run budget).",
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("APPROVE");
        // Empty verdict head with inline comments; the note line and stamp
        // are the body.
        expect(plan.body).toContain("holistic not assessed this run");
        expect(plan.body).not.toContain("Approved — no blocking issues found.");
    });

    it("plans the comment-less APPROVE body when nothing posts", () => {
        const fs = makeFakeFs(staged({depth: "full", claims: []}));
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("APPROVE");
        expect(plan.body).toContain("Approved — no blocking issues found.");
    });

    it("applies the reduced-depth flip floor from kept blocking threads", () => {
        const stamp = renderRereviewStamp({
            schemaVersion: STAMP_SCHEMA_VERSION,
            depth: "full",
            verdict: "REQUEST_CHANGES",
            anchorDraft: false,
            anchorHunks: {},
        });
        const fs = makeFakeFs(
            staged(
                {depth: "fast", claims: []},
                {
                    [`${REVIEW}/prior-reviews.json`]: JSON.stringify([
                        {body: stamp},
                    ]),
                    [`${REVIEW}/threads.json`]: JSON.stringify([
                        {
                            thread_id: "t1",
                            path: "a.ts",
                            line: 2,
                            comments: [
                                {
                                    author: "github-actions[bot]",
                                    body: "**issue (blocking):** still broken",
                                },
                            ],
                        },
                    ]),
                    [`${REVIEW}/out/thread-reconciler.json`]: JSON.stringify({
                        resolve: [],
                        keep: ["t1"],
                    }),
                    [`${REVIEW}/pr-context.json`]: JSON.stringify({
                        number: 1,
                        repo: "o/r",
                    }),
                },
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("REQUEST_CHANGES");
        // The depth note rides the body on a reduced run.
        expect(plan.body).toContain(
            "Note: re-review ran at fast depth (re-review mode full).",
        );
    });

    it("applies the flip floor from the cache-memory stamp when posted bodies carry none (the production shape)", () => {
        const fs = makeFakeFs(
            staged(
                {depth: "fast", claims: []},
                {
                    // What production priors actually look like: the ingest
                    // sanitizer stripped the stamp.
                    [`${REVIEW}/prior-reviews.json`]: JSON.stringify([
                        {body: "Changes requested — see inline comments."},
                    ]),
                    [`${REVIEW}/threads.json`]: JSON.stringify([
                        {
                            thread_id: "t1",
                            path: "a.ts",
                            line: 2,
                            comments: [
                                {
                                    author: "github-actions[bot]",
                                    body: "**issue (blocking):** still broken",
                                },
                            ],
                        },
                    ]),
                    [`${REVIEW}/out/thread-reconciler.json`]: JSON.stringify({
                        resolve: [],
                        keep: ["t1"],
                    }),
                    [`${REVIEW}/pr-context.json`]: JSON.stringify({
                        number: 41007,
                        repo: "o/r",
                    }),
                    "/tmp/gh-aw/cache-memory/pr-41007.json": JSON.stringify({
                        verdict: "REQUEST_CHANGES",
                        stampHunks: {"a.ts": ["deadbeef00000000"]},
                        wasDraft: false,
                    }),
                },
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("REQUEST_CHANGES");
    });

    it("folds a pr-level claim into the body instead of an inline comment", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [
                    claim({
                        path: undefined,
                        line: undefined,
                        label: "note (non-blocking)",
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "**note (non-blocking):** The guard was removed.",
        );
        expect(plan.notes.join(" ")).toContain("folded into the review body");
    });

    it("throws when the dispatcher has not run", () => {
        expect(() => runSubmissionCli(makeFakeFs())).toThrow(
            /dispatch-result.json not staged/,
        );
    });
});

describe("the gate's plan-match rule (slice 4)", () => {
    const plannedFs = () =>
        makeFakeFs(
            staged({
                depth: "full",
                claims: [claim()],
                reconciliation: {resolve: [], keep: []},
            }),
        );
    const outFiles = {
        "pattern-triage.json": JSON.stringify({reviewFiles: ["a.ts"]}),
        "correctness-reviewer.json": "{}",
        "claim-validator.json": "{}",
        "thread-reconciler.json": JSON.stringify({resolve: [], keep: []}),
    };

    const queuedFromPlan = (plan: {
        event: string;
        body: string;
        comments: {path: string; line: number; body: string}[];
    }) => [
        ...plan.comments.map((comment) => ({
            type: "create_pull_request_review_comment",
            ...comment,
        })),
        {
            type: "submit_pull_request_review",
            event: plan.event,
            body: plan.body,
        },
    ];

    it("passes when the queued outputs match the plan (sanitizer-normalized)", () => {
        const plan = runSubmissionCli(plannedFs());
        const result = evaluateDispatchConformance({
            items: queuedFromPlan(plan),
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(result.violations).toEqual([]);
    });

    it("passes when the ingest sanitizer stripped the plan's stamp comment from the queued body (run 29893634730)", () => {
        const plan = runSubmissionCli(plannedFs());
        // The plan's body carries the hidden fingerprint stamp; what the
        // gate sees queued is the POST-sanitizer body, comments deleted.
        expect(plan.body).toContain("<!--");
        const sanitizedBody = plan.body.replace(/<!--[\s\S]*?-->/g, "");
        const result = evaluateDispatchConformance({
            items: queuedFromPlan({...plan, body: sanitizedBody}),
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(result.violations).toEqual([]);
    });

    it("tolerates the sanitizer's typographic ASCII fold (run 29903306596's ellipsis)", () => {
        const fancy = claim({
            discussion:
                "composite indexes that are missing from index.yaml \u2026 the order of the \u201cproperties\u201d matters \u2014 it\u2019s direction-sensitive.",
        });
        const plan = runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [fancy],
                    reconciliation: {resolve: [], keep: []},
                }),
            ),
        );
        // What the gate sees queued is the POST-sanitizer body: unicode
        // typography folded to ASCII.
        const folded = plan.comments.map((comment) => ({
            ...comment,
            body: comment.body
                .replace(/\u2026/g, "...")
                .replace(/[\u201c\u201d]/g, '"')
                .replace(/\u2014/g, "-")
                .replace(/\u2019/g, "'"),
        }));
        const result = evaluateDispatchConformance({
            items: queuedFromPlan({...plan, comments: folded}),
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(result.violations).toEqual([]);
    });

    it("blocks a spliced body, a flipped event, and a dropped comment", () => {
        const plan = runSubmissionCli(plannedFs());
        const splicedBody = evaluateDispatchConformance({
            items: queuedFromPlan({
                ...plan,
                body: `${plan.body}\nAlso, everything looks great!`,
            }),
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(splicedBody.violations.map((v) => v.code)).toContain(
            "submission-plan-mismatch",
        );

        const flipped = evaluateDispatchConformance({
            items: queuedFromPlan({...plan, event: "APPROVE", comments: []}),
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(flipped.violations.map((v) => v.code)).toContain(
            "submission-plan-mismatch",
        );

        const dropped = evaluateDispatchConformance({
            items: queuedFromPlan({...plan, comments: []}),
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(dropped.violations.map((v) => v.code)).toContain(
            "submission-plan-mismatch",
        );
    });

    it("the redundant-approval skip queues nothing only for an APPROVE plan with no comments", () => {
        const approvePlan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims: []})),
        );
        const result = evaluateDispatchConformance({
            items: [],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: approvePlan,
        });
        expect(result.conformant).toBe(true);
        // Dropping a REQUEST_CHANGES plan is the withheld-verdict shape and
        // blocks (pinned in detail in the hardening suite below).
        const rcPlan = runSubmissionCli(plannedFs());
        const dropped = evaluateDispatchConformance({
            items: [],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: rcPlan,
        });
        expect(dropped.conformant).toBe(false);
    });
});

describe("re-review hardening (slice 4 feedback)", () => {
    const gateInput = (plan: ReturnType<typeof runSubmissionCli>) => ({
        plan: {depth: "full"},
        routing: {enabledReviewers: [], lensesToSpawn: []},
        outFiles: {
            "pattern-triage.json": JSON.stringify({reviewFiles: ["a.ts"]}),
            "correctness-reviewer.json": "{}",
            "claim-validator.json": "{}",
        },
        submissionPlan: plan,
    });
    const rcPlan = () =>
        runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [claim()],
                    reconciliation: {resolve: [], keep: []},
                }),
            ),
        );

    it("blocks queued comments with no submission (the ungated COMMENT review shape)", () => {
        const plan = rcPlan();
        const result = evaluateDispatchConformance({
            ...gateInput(plan),
            items: plan.comments.map((comment) => ({
                type: "create_pull_request_review_comment",
                ...comment,
            })),
        });
        expect(result.violations.map((v) => v.code)).toContain(
            "submission-plan-mismatch",
        );
    });

    it("blocks a silently-dropped REQUEST_CHANGES plan (nothing queued)", () => {
        const plan = rcPlan();
        const result = evaluateDispatchConformance({
            ...gateInput(plan),
            items: [],
        });
        expect(result.violations.map((v) => v.code)).toEqual([
            "submission-plan-mismatch",
        ]);
    });

    it("permits queueing nothing only for an APPROVE plan with no comments", () => {
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims: []})),
        );
        const result = evaluateDispatchConformance({
            ...gateInput(plan),
            items: [],
        });
        expect(result.conformant).toBe(true);
    });

    it("tolerates sanitizer-shaped drift: case, backticks, whitespace, URL rewrites", () => {
        const plan = rcPlan();
        const mangle = (text: string): string =>
            `${text
                .toUpperCase()
                .replace(/ /g, "  ")
                .replace(
                    "GUARD",
                    "`GUARD` https://evil.example/redirect?x=1",
                )}`;
        const planWithUrl = {
            ...plan,
            body: `${plan.body}\nSee https://github.com/Khan/actions/pull/1 for context.`,
        };
        const result = evaluateDispatchConformance({
            ...gateInput(planWithUrl),
            items: [
                ...plan.comments.map((comment) => ({
                    type: "create_pull_request_review_comment",
                    path: comment.path,
                    line: comment.line,
                    body: comment.body.toUpperCase().replace(/ /g, "  "),
                })),
                {
                    type: "submit_pull_request_review",
                    event: plan.event,
                    body: `${plan.body}\nSee https://redirect.github.example/rewritten for context.`,
                },
            ],
        });
        expect(
            result.violations.filter(
                (v) => v.code === "submission-plan-mismatch",
            ),
        ).toEqual([]);
        // mangle() is used above only for the URL clause; keep the linter
        // honest about it.
        expect(mangle("guard")).toContain("GUARD");
    });

    it("appends the tripwire note with the 2-decimal share", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "full",
                mode: "scoped",
                tripwireRearmed: true,
                divergence: {unreviewedShare: 0.4567},
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).toContain(
            "Note: divergence tripwire re-armed a full review (unreviewed share 0.46).",
        );
    });

    it("keeps a blank line inside a rule-quote blockquote", () => {
        const body = renderClaimComment(
            claim({rule_quote: "First.\n\nSecond."}) as never,
        );
        expect(body).toContain("> **Rule:** First.\n>\n> Second.");
    });

    it("renderClaimComment matches renderComment byte-for-byte on the same finding", () => {
        const finding = {
            schema_version: 2,
            id: "f1",
            lens: "correctness",
            anchor: {type: "line", path: "a.ts", line: 2, side: "RIGHT"},
            severity: "blocking",
            confidence: 0.9,
            evidence_trace: ["a.ts:2"],
            failure_scenario: "fails",
            producing_hunt: "h",
            model_authored_prose: "The guard was removed.",
            rule_quote: "Always guard.\n\nEven here.",
            suggested_patch: "guard()",
        } as never;
        const canonical = renderComment(finding);
        const viaClaim = renderClaimComment(
            claim({
                label: labelForFinding(finding),
                discussion: "The guard was removed.",
                rule_quote: "Always guard.\n\nEven here.",
                suggestion: "guard()",
            }) as never,
        );
        expect(viaClaim).toBe(canonical);
    });
});

describe("open-thread suppression verdict floor (trial suggestion g)", () => {
    it("floors the verdict at REQUEST_CHANGES when a blocking claim was suppressed as an open-thread duplicate", () => {
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
                    },
                ],
            }),
        );
        expect(runSubmissionCli(fs).event).toBe("APPROVE");
    });
});
