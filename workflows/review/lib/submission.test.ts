import {describe, it, expect} from "vitest";

import {evaluateDispatchConformance} from "./dispatch-gate";
import {renderRereviewStamp, STAMP_SCHEMA_VERSION} from "./rereview-mode";
import {
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

    it("does not fire when no submission is queued (the redundant-approval skip)", () => {
        const plan = runSubmissionCli(plannedFs());
        const result = evaluateDispatchConformance({
            items: [],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            submissionPlan: plan,
        });
        expect(result.conformant).toBe(true);
    });
});
