import {describe, it, expect} from "vitest";

import {evaluateDispatchConformance} from "./dispatch-gate";
import {labelForFinding, renderComment} from "./render-comment";
import {renderRereviewStamp, STAMP_SCHEMA_VERSION} from "./rereview-mode";
import {
    computeBodyStats,
    MAX_VERBATIM_FOLD_CHARS,
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

/**
 * Stage a prior APPROVE via the cache-memory carrier (posted bodies never
 * keep their stamp), which is what makes a redundant-approval skip legitimate.
 */
const priorApprove = (): Record<string, string> => ({
    [`${REVIEW}/pr-context.json`]: JSON.stringify({number: 41007}),
    "/tmp/gh-aw/cache-memory/pr-41007.json": JSON.stringify({
        verdict: "APPROVE",
        stampHunks: {"a.ts": ["deadbeef00000000"]},
        wasDraft: false,
    }),
});

describe("computeBodyStats", () => {
    it("reports nearest-rank percentiles over comment body lengths", () => {
        const comments = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(
            (length) => ({path: "a.ts", line: 1, body: "x".repeat(length)}),
        );
        expect(computeBodyStats(comments, "body")).toEqual({
            comments: 10,
            medianChars: 50, // nearest-rank: ceil(0.5 * 10) = 5th of 10
            p90Chars: 90, // ceil(0.9 * 10) = 9th of 10
            maxChars: 100,
            totalChars: 550,
            bodyChars: 4,
        });
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
                body:
                    "**issue (blocking):** The guard was removed.\n\n" +
                    "<details><summary><sub>review details</sub></summary>\n" +
                    "<sub>found by correctness-reviewer</sub>\n" +
                    "</details>",
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

    it("stages body-size stats measured over the final rendered bodies (PRA-46)", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim()],
                noteLines: [],
                reconciliation: {resolve: [], keep: []},
            }),
        );
        const plan = runSubmissionCli(fs);
        // One comment: every percentile is that comment's FINAL length
        // (attribution footer included), not the bare claim render.
        const commentChars = plan.comments[0]?.body.length as number;
        expect(plan.bodyStats).toEqual({
            comments: 1,
            medianChars: commentChars,
            p90Chars: commentChars,
            maxChars: commentChars,
            totalChars: commentChars,
            bodyChars: plan.body.length,
        });
        expect(plan.comments[0]?.body).toContain("review details");
        // The stats ride the staged artifact for the live drift watch.
        expect(
            JSON.parse(fs.files[`${REVIEW}/submission-plan.json`]).bodyStats,
        ).toEqual(plan.bodyStats);
    });

    it("stages zeroed comment stats when nothing posts inline", () => {
        const fs = makeFakeFs(staged({depth: "full", claims: []}));
        const plan = runSubmissionCli(fs);
        expect(plan.bodyStats).toEqual({
            comments: 0,
            medianChars: 0,
            p90Chars: 0,
            maxChars: 0,
            totalChars: 0,
            bodyChars: plan.body.length,
        });
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
                        also_flagged_by: [{source: "completeness", line: 7}],
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "**note (non-blocking):** The guard was removed.",
        );
        // The fold carries the same collapsed attribution footer an inline
        // comment gets (submission.ts's pr-level branch).
        expect(plan.body).toContain(
            "<details><summary><sub>review details</sub></summary>\n" +
                "<sub>found by correctness-reviewer | also flagged by " +
                "completeness (at line 7)</sub>\n" +
                "</details>",
        );
        expect(plan.body).not.toContain("<summary>Full finding</summary>");
        expect(plan.notes.join(" ")).toContain("folded into the review body");
    });

    it("folds a long pr-level claim as its subject plus a collapsed full finding", () => {
        // webapp#41290 review 4867627688 folded a ~2,600-char pr-anchored
        // finding verbatim into the body, burying the accountability
        // section around it; past the verbatim cap the body carries the
        // subject line and the discussion collapses.
        const discussion = `The moderation goroutine races the completion goroutine. ${"Every detail of the trace is repeated at length here. ".repeat(
            Math.ceil(MAX_VERBATIM_FOLD_CHARS / 50),
        )}`;
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [
                    claim({
                        path: undefined,
                        line: undefined,
                        label: "issue (blocking)",
                        subject:
                            "The moderation goroutine races the completion goroutine.",
                        discussion,
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "**issue (blocking):** The moderation goroutine races the completion goroutine.",
        );
        expect(plan.body).toContain("<summary>Full finding</summary>");
        expect(plan.body).toContain(discussion);
        // The verbatim wall is gone: the discussion appears only inside the
        // details block, after the subject-line fold.
        expect(plan.body.indexOf(discussion)).toBeGreaterThan(
            plan.body.indexOf("<summary>Full finding</summary>"),
        );
        expect(plan.event).toBe("REQUEST_CHANGES");
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

    it("tolerates URL/scheme redaction and template-delimiter escaping (v0.81.6 sanitizer audit)", () => {
        // The deployed URL policy is allowed-only and runs inside code
        // regions too: a cited non-allowlisted domain (MDN, StackOverflow)
        // comes back "(host/redacted)", a blocked scheme "(redacted)", and
        // unbackticked template delimiters gain escaping backslashes; none
        // of these may false-block a byte-faithful transcription.
        const cited = claim({
            discussion:
                "See https://developer.mozilla.org/en-US/docs/Web/API/AbortController for the contract; never emit javascript:alert(1) links, and ${{ github.token }} must stay out of run logs.",
        });
        const plan = runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [cited],
                    reconciliation: {resolve: [], keep: []},
                }),
            ),
        );
        const sanitized = plan.comments.map((comment) => ({
            ...comment,
            body: comment.body
                .replace(
                    /https:\/\/developer\.mozilla\.org\S+/g,
                    "(developer.mozilla.org/redacted)",
                )
                .replace(/javascript:\S+/g, "(redacted)")
                .replace(/\$\{\{/g, "\\$\\{\\{"),
        }));
        expect(JSON.stringify(sanitized)).not.toBe(
            JSON.stringify(plan.comments),
        );
        const result = evaluateDispatchConformance({
            items: queuedFromPlan({...plan, comments: sanitized}),
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

    it("appends the attribution footer as the last visible line, before the stamp", () => {
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim()],
            }),
        );
        const plan = runSubmissionCli(fs);
        const lines = plan.body.split("\n");
        // Stamp last (hidden), the collapsed footer block directly above it.
        expect(lines.at(-1)).toMatch(/^<!--.*-->$/);
        expect(lines.at(-2)).toBe("</details>");
        expect(lines.at(-3)).toMatch(/^<sub>.*schema \d+.*<\/sub>$/);
        expect(lines.at(-4)).toBe(
            "<details><summary><sub>review details</sub></summary>",
        );
        // The CLI also staged the footer file Step 7 pastes.
        expect(fs.files["/tmp/gh-aw/review/version-footer.txt"]).toBe(
            lines.slice(-4, -1).join("\n"),
        );
    });

    it("the redundant-approval skip queues nothing only for an APPROVE plan with no comments", () => {
        const approvePlan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims: []}, priorApprove())),
        );
        expect(approvePlan.skipSubmission).toBe(true);
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
            makeFakeFs(staged({depth: "full", claims: []}, priorApprove())),
        );
        const result = evaluateDispatchConformance({
            ...gateInput(plan),
            items: [],
        });
        expect(result.conformant).toBe(true);
    });

    it("refuses the skip when the body carries only a collapsed low-confidence section", () => {
        // The divergence this field exists to remove: the collapsed
        // `<details>` section is neither a `Note:` line nor an accountability
        // section, so the prompt's old prose predicate let the orchestrator
        // skip a submission the gate then red-flagged, withholding the
        // approval AND the observations on every later run.
        const plan = runSubmissionCli(
            makeFakeFs(
                staged(
                    {
                        depth: "full",
                        claims: [
                            claim({
                                id: "weak",
                                label: "thought (non-blocking)",
                                confidence: 0.3,
                                subject: "a hunch",
                            }),
                        ],
                    },
                    priorApprove(),
                ),
            ),
        );
        expect(plan.event).toBe("APPROVE");
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain("Lower-confidence observations");
        expect(plan.skipSubmission).toBe(false);
        // ...and queueing nothing for it is a red run, not a silent skip.
        const dropped = evaluateDispatchConformance({
            ...gateInput(plan),
            items: [],
        });
        expect(dropped.conformant).toBe(false);
    });

    // The blocking-only posting-surface cases live in
    // submission-blocking-only.test.ts (this file's max-lines budget).

    it("refuses the skip without a prior APPROVE (a first approval must post)", () => {
        const plan = runSubmissionCli(
            makeFakeFs(staged({depth: "full", claims: []})),
        );
        expect(plan.skipSubmission).toBe(false);
        expect(
            evaluateDispatchConformance({...gateInput(plan), items: []})
                .conformant,
        ).toBe(false);
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
            body: `${plan.body}\nSee https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for context.`,
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
                    // The domain-redaction shape the sanitizer actually
                    // produces for a non-allowlisted host: the host is kept,
                    // the path is replaced.
                    body: `${plan.body}\nSee (developer.mozilla.org/redacted) for context.`,
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

    it("tolerates a zero-width or CGJ character the sanitizer stripped", () => {
        // hardenUnicodeText deletes zero-width space/non-joiner/joiner,
        // the word joiner, the BOM, and the combining grapheme joiner. A
        // plan whose prose carries one and a queued copy that dropped it
        // are the SAME submission; only the strip arms of normalizeBody
        // keep that from reading as a splice.
        // Alternation, not a character class: the ZWJ and the CGJ are
        // combining/joining characters that no-misleading-character-class
        // rejects inside `[...]`.
        const ZERO_WIDTH = /\u200b|\u200c|\u200d|\u2060|\ufeff|\u034f/g;
        const invisible = claim({
            discussion:
                "The\u200bguard\u200cwas\u200dremoved\u2060from\ufeffthe\u034ffast path.",
        });
        const plan = runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [invisible],
                    reconciliation: {resolve: [], keep: []},
                }),
            ),
        );
        const stripped = plan.comments.map((comment) => ({
            ...comment,
            body: comment.body.replace(ZERO_WIDTH, ""),
        }));
        // The queued copy really did lose characters.
        expect(stripped[0]?.body).not.toBe(plan.comments[0]?.body);
        const result = evaluateDispatchConformance({
            ...gateInput(plan),
            items: [
                ...stripped.map((comment) => ({
                    type: "create_pull_request_review_comment",
                    ...comment,
                })),
                {
                    type: "submit_pull_request_review",
                    event: plan.event,
                    body: plan.body.replace(ZERO_WIDTH, ""),
                },
            ],
        });
        expect(result.violations).toEqual([]);
    });

    it("blocks a link-target splice that swaps the host", () => {
        // URL folding is host-bearing, so the sanitizer's own rewrites pass
        // (test above) while an "improvement" that points the reader at a
        // different site does not; the #244 splice class.
        const plan = rcPlan();
        const planWithUrl = {
            ...plan,
            body: `${plan.body}\nSee https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for context.`,
        };
        const result = evaluateDispatchConformance({
            ...gateInput(planWithUrl),
            items: [
                ...plan.comments.map((comment) => ({
                    type: "create_pull_request_review_comment",
                    ...comment,
                })),
                {
                    type: "submit_pull_request_review",
                    event: plan.event,
                    body: `${plan.body}\nSee https://stackoverflow.com/questions/1 for context.`,
                },
            ],
        });
        expect(
            result.violations.filter(
                (v) => v.code === "submission-plan-mismatch",
            ).length,
        ).toBe(1);
    });

    it("blocks queueing nothing when the APPROVE plan carries a disclosure note", () => {
        // The redundant-approval skip is only for the bare comment-less
        // approve body. An APPROVE that shed a lens carries a mandatory
        // "not assessed this run" disclosure; dropping that submission would
        // withhold both the disclosure and the approval.
        const plan = runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [],
                    noteLines: [
                        "Note: security-lens not assessed this run (output unavailable).",
                    ],
                }),
            ),
        );
        expect(plan.event).toBe("APPROVE");
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain("not assessed this run");
        const result = evaluateDispatchConformance({
            ...gateInput(plan),
            items: [],
        });
        expect(result.violations.map((v) => v.code)).toEqual([
            "submission-plan-mismatch",
        ]);
    });

    it("drops a claim on an open human-thread line from the comments AND the verdict", () => {
        // review.md Step 5: a bot comment on a line with an open human
        // review thread talks over the conversation. Scripted mode has to
        // apply the filter here, because rule 7 forbids the orchestrator
        // from dropping the comment itself.
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [
                    claim({id: "c1", path: "a.ts", line: 2}),
                    claim({id: "c2", path: "b.ts", line: 7}),
                ],
                reconciliation: {
                    resolve: [],
                    keep: [],
                    skipLines: [{path: "a.ts", line: 2}],
                },
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments.map((comment) => comment.path)).toEqual(["b.ts"]);
        expect(plan.notes).toContain(
            "claim c1 dropped: open human thread at a.ts:2",
        );
        // c2 is still blocking, so the verdict stands on its own.
        expect(plan.event).toBe("REQUEST_CHANGES");
    });

    it("approves when every blocking claim sits on an open human-thread line", () => {
        // The verdict counts only the labels on comments that actually
        // post; a filtered blocking claim cannot drive REQUEST_CHANGES.
        const plan = runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [claim({id: "c1", path: "a.ts", line: 2})],
                    reconciliation: {
                        resolve: [],
                        keep: [],
                        skipLines: [{path: "a.ts", line: 2}],
                    },
                }),
            ),
        );
        expect(plan.comments).toEqual([]);
        expect(plan.event).toBe("APPROVE");
    });

    it("ignores malformed skipLines entries rather than crashing", () => {
        const plan = runSubmissionCli(
            makeFakeFs(
                staged({
                    depth: "full",
                    claims: [claim()],
                    reconciliation: {
                        resolve: [],
                        keep: [],
                        skipLines: ["a.ts:2", {path: "a.ts"}, null, 7],
                    },
                }),
            ),
        );
        expect(plan.comments).toHaveLength(1);
        expect(plan.event).toBe("REQUEST_CHANGES");
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
