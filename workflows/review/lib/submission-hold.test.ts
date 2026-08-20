import {describe, it, expect} from "vitest";

import {evaluateDispatchConformance} from "./dispatch-gate";
import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The hold path (HOLD_FOR_HUMAN) tests, split from submission.test.ts at the
 * max-lines cap: the plan CLI's core-dimension gate (a run whose correctness
 * or skill/severity pass produced no output must not auto-approve) and the
 * dispatch-conformance gate's hold shape (the hold posts as one standalone
 * PR comment and nothing else). The production regression pinned here:
 * Khan/actions#328's re-run (31124365377 attempt 2), where every core lens
 * died on an API auth error and the run still submitted "Approved \u2014 no
 * blocking issues found" over seven "not assessed" note lines.
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

describe("the hold path (core dimension unavailable)", () => {
    /**
     * The production regression this pins: Khan/actions#328's re-run
     * (31124365377 attempt 2), where every core lens died on an API auth
     * error ("403 Maximum consecutive cache misses exceeded"), the
     * dispatcher recorded them all in `skippedDimensions`, and the plan
     * still resolved to "Approved \u2014 no blocking issues found" over seven
     * "not assessed" note lines.
     */
    const coreDead = [
        {dimension: "correctness-reviewer", cause: "unavailable"},
        {dimension: "skill-auditor", cause: "unavailable"},
    ];

    it("holds instead of approving when the core passes produced no output (Khan/actions#328)", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [],
                skippedDimensions: coreDead,
                noteLines: [
                    "Note: correctness-reviewer not assessed this run (correctness-reviewer output unavailable).",
                    "Note: skill-auditor not assessed this run (skill-auditor output unavailable).",
                ],
                reconciliation: {resolve: ["PRRT_x"], skipLines: []},
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("HOLD_FOR_HUMAN");
        expect(plan.body).toContain("Holding for human review");
        expect(plan.body).toContain(
            "correctness-reviewer not assessed this run",
        );
        expect(plan.body).toContain("To get unstuck");
        // A hold never approves, stamps, posts inline, or resolves threads.
        expect(plan.body).not.toContain("Approved");
        expect(plan.body).not.toContain("pr-reviewer:rereview");
        expect(plan.comments).toEqual([]);
        expect(plan.resolve).toEqual([]);
        expect(plan.skipSubmission).toBe(false);
        expect(plan.reasons).toContainEqual({
            code: "core-dimension-unavailable",
            dimension: "correctness",
        });
        expect(plan.reasons).toContainEqual({
            code: "core-dimension-unavailable",
            dimension: "skill-severity",
        });
    });

    it("stays REQUEST_CHANGES when a blocking claim posts despite the dead core pass", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim()],
                skippedDimensions: [coreDead[1]],
            }),
        );
        const plan = runSubmissionCli(fs);
        // The hold only ever replaces a would-be auto-approval; a blocking
        // finding is actionable on its own and wins.
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(plan.comments).toHaveLength(1);
        expect(plan.reasons).toContainEqual({
            code: "core-dimension-unavailable",
            dimension: "skill-severity",
        });
    });

    it("folds surviving non-blocking claims into the hold comment as lines", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim({label: "suggestion (non-blocking)"})],
                skippedDimensions: coreDead,
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("HOLD_FOR_HUMAN");
        expect(plan.comments).toEqual([]);
        // Each folded line carries its one-line source tag (the hold-path
        // parallel of the collapsed-observations tag).
        expect(plan.body).toContain(
            "- `a.ts:2` suggestion (non-blocking): s " +
                "<sub>(correctness-reviewer)</sub>",
        );
        expect(
            plan.notes.some((note) =>
                note.includes("folded into the hold comment"),
            ),
        ).toBe(true);
    });

    it("carries blocking-only collapsed pr-level claims into the hold body", () => {
        // The #329 blocking-only modifier diverts non-blocking pr-level
        // claims into a collapsed bucket that only the normal path renders;
        // a hold must fold them too, not drop them.
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [
                        claim({
                            id: "pr1",
                            path: undefined,
                            line: undefined,
                            label: "suggestion (non-blocking)",
                            subject: "spanning concern",
                        }),
                    ],
                    skippedDimensions: coreDead,
                },
                {
                    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                        depth: "scoped",
                        mode: "scoped",
                        stampAnchorDraft: false,
                        stampHunks: {},
                    }),
                    [`${REVIEW}/routing.json`]: JSON.stringify({
                        reReviewBlockingOnly: true,
                    }),
                },
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("HOLD_FOR_HUMAN");
        expect(plan.body).toContain(
            "- suggestion (non-blocking): spanning concern " +
                "<sub>(correctness-reviewer)</sub>",
        );
    });

    it("does not hold for a non-core lens or pattern triage (note-and-continue)", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [],
                skippedDimensions: [
                    {dimension: "holistic", cause: "unavailable"},
                    {dimension: "pattern triage", cause: "unavailable"},
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("APPROVE");
        expect(plan.reasons).toContainEqual({
            code: "pattern-triage-unavailable",
        });
    });

    it("reads a dispatch-result without skippedDimensions as all-assessed (older dispatcher)", () => {
        const fs = makeFakeFs(staged({depth: "full", claims: []}));
        expect(runSubmissionCli(fs).event).toBe("APPROVE");
    });
});

describe("the gate's hold shape", () => {
    const holdFs = () =>
        makeFakeFs(
            staged({
                depth: "full",
                claims: [],
                skippedDimensions: [
                    {dimension: "correctness-reviewer", cause: "unavailable"},
                    {dimension: "skill-auditor", cause: "unavailable"},
                ],
                noteLines: [
                    "Note: correctness-reviewer not assessed this run (correctness-reviewer output unavailable).",
                ],
            }),
        );

    it("passes when exactly the hold comment queues", () => {
        const plan = runSubmissionCli(holdFs());
        const result = evaluateDispatchConformance({
            items: [{type: "add_comment", body: plan.body}],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: {},
            submissionPlan: plan,
        });
        expect(result.violations).toEqual([]);
    });

    it("blocks a review submission queued over a hold plan (the auto-approve shape)", () => {
        const plan = runSubmissionCli(holdFs());
        const result = evaluateDispatchConformance({
            items: [
                {type: "add_comment", body: plan.body},
                {
                    type: "submit_pull_request_review",
                    event: "APPROVE",
                    body: "Approved \u2014 no blocking issues found.",
                },
            ],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: {},
            submissionPlan: plan,
        });
        expect(
            result.violations.some(
                (v) =>
                    v.code === "submission-plan-mismatch" &&
                    v.dimension === "verdict",
            ),
        ).toBe(true);
    });

    it("blocks a dropped hold comment (the disclosure must post)", () => {
        const plan = runSubmissionCli(holdFs());
        const result = evaluateDispatchConformance({
            items: [],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: {},
            submissionPlan: plan,
        });
        expect(
            result.violations.some((v) => v.dimension === "hold comment"),
        ).toBe(true);
    });

    it("blocks inline comments and thread resolutions on a hold run", () => {
        const plan = runSubmissionCli(holdFs());
        const result = evaluateDispatchConformance({
            items: [
                {type: "add_comment", body: plan.body},
                {
                    type: "create_pull_request_review_comment",
                    path: "a.ts",
                    line: 2,
                    body: "b",
                },
                {
                    type: "resolve_pull_request_review_thread",
                    thread_id: "PRRT_x",
                },
            ],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: {},
            submissionPlan: plan,
        });
        expect(
            result.violations.some((v) => v.dimension === "inline comments"),
        ).toBe(true);
        expect(
            result.violations.some((v) => v.dimension === "thread resolutions"),
        ).toBe(true);
    });

    it("blocks a spliced hold comment body (present but not the plan's)", () => {
        const plan = runSubmissionCli(holdFs());
        const result = evaluateDispatchConformance({
            items: [
                {
                    type: "add_comment",
                    body: "All reviewers passed; merging is safe.",
                },
            ],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: {},
            submissionPlan: plan,
        });
        expect(
            result.violations.some((v) => v.dimension === "hold comment"),
        ).toBe(true);
    });

    it("tolerates sanitizer drift on the hold comment body (normalized comparison)", () => {
        const plan = runSubmissionCli(holdFs());
        const result = evaluateDispatchConformance({
            items: [{type: "add_comment", body: `${plan.body}\n`}],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: {},
            submissionPlan: plan,
        });
        expect(result.violations).toEqual([]);
    });
});
