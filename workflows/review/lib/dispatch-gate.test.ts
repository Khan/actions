import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {
    BLOCKED_SENTINEL_PATH,
    disclosesSkippedDimension,
    evaluateDispatchConformance,
    renderGateSummary,
    runDispatchGateCli,
    KEEP_ITEM_TYPES,
    type DispatchGateFs,
    type DispatchGateInput,
    type SafeOutputItem,
} from "./dispatch-gate";

/**
 * Dispatch-conformance gate tests.
 *
 * The production failure this gate exists for (Khan/webapp#40992, run
 * 29865480728): the orchestrator dispatched zero sub-agents, wrote a single
 * self-authored `out/orchestrator-findings.json` calling the run a
 * "streamlined direct review", and queued a REQUEST_CHANGES with three inline
 * comments and a bare body. The contrasting conforming run (Khan/actions#272,
 * 2026-07-20) staged one `out/<agent>.json` per dispatched reviewer and
 * disclosed its missing validator with exactly "Note: claim validation not
 * assessed this run (claim-validator output unavailable)." Both shapes are
 * reproduced below verbatim from the downloaded run artifacts.
 *
 * NOTE: the eval suite cannot cover this failure class by construction (the
 * harness dispatches sub-agents from a script, so protocol fidelity is
 * exactly what it never exercises); these deterministic tests are the whole
 * coverage story for the gate.
 */

const submitItem = (event: string, body = ""): SafeOutputItem => ({
    type: "submit_pull_request_review",
    event,
    body,
});

const commentItem = (line = 1): SafeOutputItem => ({
    type: "create_pull_request_review_comment",
    path: "a.ts",
    line,
    body: "**issue (blocking):** x",
});

const uploadItem: SafeOutputItem = {type: "upload_artifact", path: "out"};

/** A fully conforming full-depth staging (the Khan/actions#272 shape). */
const conformingOutFiles = (): Record<string, string> => ({
    "pattern-triage.json": JSON.stringify({
        patterns: [],
        reviewFiles: ["a.ts"],
    }),
    "correctness-reviewer.json": JSON.stringify({findings: [], files: []}),
    "claim-validator.json": JSON.stringify({verifications: []}),
    "rereview-plan.json": JSON.stringify({depth: "full"}),
});

const evaluate = (overrides: Partial<DispatchGateInput>) =>
    evaluateDispatchConformance({
        items: [],
        plan: undefined,
        routing: undefined,
        outFiles: {},
        ...overrides,
    });

describe("evaluateDispatchConformance", () => {
    it("flags the webapp#40992 freelance shape: verdict and findings with zero dispatches", () => {
        // Reproduced from the run 29865480728 artifacts: three comments, a
        // REQUEST_CHANGES with the bare non-empty-body line, no routing, no
        // plan, and only the self-authored findings file in out/.
        const result = evaluate({
            items: [
                commentItem(39),
                commentItem(70),
                commentItem(13),
                submitItem(
                    "REQUEST_CHANGES",
                    "Changes requested — see inline comments.",
                ),
                uploadItem,
            ],
            outFiles: {
                "orchestrator-findings.json": JSON.stringify({
                    process: "streamlined direct review",
                }),
            },
        });
        expect(result.conformant).toBe(false);
        expect(result.depth).toBe("full");
        expect(result.violations.map((v) => v.code)).toEqual([
            "correctness-missing",
            "validator-missing-with-findings",
        ]);
        expect(result.verdictEvent).toBe("REQUEST_CHANGES");
        expect(result.commentCount).toBe(3);
    });

    it("passes the Khan/actions#272 conforming shape: dispatched roster, validator gap disclosed", () => {
        const outFiles = conformingOutFiles();
        delete outFiles["claim-validator.json"];
        const result = evaluate({
            items: [
                commentItem(),
                submitItem(
                    "APPROVE",
                    "Note: claim validation not assessed this run (claim-validator output unavailable).",
                ),
                uploadItem,
            ],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
        });
        expect(result.violations).toEqual([]);
        expect(result.conformant).toBe(true);
    });

    it("passes a fully-staged conforming run with findings", () => {
        const result = evaluate({
            items: [
                commentItem(),
                submitItem(
                    "REQUEST_CHANGES",
                    "Changes requested — see inline comments.",
                ),
            ],
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: conformingOutFiles(),
        });
        expect(result.conformant).toBe(true);
    });

    it("is trivially conformant when nothing posting is queued", () => {
        // The redundant-approval skip (Step 6) queues no submission at all.
        const result = evaluate({items: [uploadItem]});
        expect(result.conformant).toBe(true);
        expect(result.verdictEvent).toBeNull();
        expect(result.commentCount).toBe(0);
    });

    describe("per depth mode", () => {
        it("requires the correctness pass at full, scoped, and flip-gated", () => {
            for (const depth of ["full", "scoped", "flip-gated"]) {
                const result = evaluate({
                    items: [
                        submitItem(
                            "APPROVE",
                            "Approved — no blocking issues found.",
                        ),
                    ],
                    plan: {depth},
                    outFiles: {},
                });
                expect(
                    result.violations.map((v) => v.code),
                    `depth ${depth}`,
                ).toEqual(["correctness-missing"]);
            }
        });

        it("carries no correctness requirement at fast depth (reconcile-only roster)", () => {
            const result = evaluate({
                items: [
                    submitItem(
                        "APPROVE",
                        "Approved — no blocking issues found.",
                    ),
                ],
                plan: {depth: "fast"},
                outFiles: {"thread-reconciler.json": "{}"},
            });
            expect(result.conformant).toBe(true);
            expect(result.depth).toBe("fast");
        });

        it("still requires the validator when findings post at fast depth (no producer ran)", () => {
            const result = evaluate({
                items: [commentItem(), submitItem("APPROVE")],
                plan: {depth: "fast"},
                outFiles: {},
            });
            expect(result.violations.map((v) => v.code)).toEqual([
                "validator-missing-with-findings",
            ]);
        });

        it("defaults a missing or unrecognized plan to full depth (the strictest)", () => {
            const missing = evaluate({
                items: [submitItem("APPROVE")],
                outFiles: {},
            });
            expect(missing.depth).toBe("full");
            expect(missing.notes).toContain(
                "rereview plan not staged: rules ran at full depth",
            );
            const garbled = evaluate({
                items: [submitItem("APPROVE")],
                plan: {depth: "turbo"},
                outFiles: {},
            });
            expect(garbled.depth).toBe("full");
            expect(garbled.violations.map((v) => v.code)).toEqual([
                "correctness-missing",
            ]);
        });
    });

    describe("the pattern-triage empty-reviewFiles waiver", () => {
        it("waives the correctness requirement when triage emptied the review set", () => {
            const result = evaluate({
                items: [
                    submitItem(
                        "APPROVE",
                        "Approved — no blocking issues found.",
                    ),
                ],
                plan: {depth: "full"},
                outFiles: {
                    "pattern-triage.json": JSON.stringify({
                        patterns: ["rename"],
                        reviewFiles: [],
                    }),
                },
            });
            expect(result.conformant).toBe(true);
            expect(result.notes.join(" ")).toContain("waived");
        });

        it("does not waive when reviewFiles is non-empty or triage output is unparseable", () => {
            for (const triage of [
                JSON.stringify({reviewFiles: ["a.ts"]}),
                "not json",
                JSON.stringify({}),
            ]) {
                const result = evaluate({
                    items: [submitItem("APPROVE")],
                    plan: {depth: "full"},
                    outFiles: {"pattern-triage.json": triage},
                });
                expect(result.violations.map((v) => v.code)).toEqual([
                    "correctness-missing",
                ]);
            }
        });

        it("does not apply at flip-gated depth (triage never runs there)", () => {
            const result = evaluate({
                items: [submitItem("APPROVE")],
                plan: {depth: "flip-gated"},
                outFiles: {
                    "pattern-triage.json": JSON.stringify({reviewFiles: []}),
                },
            });
            expect(result.violations.map((v) => v.code)).toEqual([
                "correctness-missing",
            ]);
        });
    });

    describe("unparseable dispatched output", () => {
        it("accepts an unparseable correctness output when the body discloses it", () => {
            // Step 3 allows staging the raw (possibly non-JSON) text of a
            // failed sub-agent; the Step 6 note is the required disclosure.
            const result = evaluate({
                items: [
                    submitItem(
                        "APPROVE",
                        "Note: correctness not assessed this run (correctness-reviewer output unavailable).",
                    ),
                ],
                plan: {depth: "full"},
                outFiles: {"correctness-reviewer.json": "raw model text"},
            });
            expect(result.conformant).toBe(true);
        });

        it("flags an unparseable correctness output with no disclosure", () => {
            const result = evaluate({
                items: [submitItem("APPROVE")],
                plan: {depth: "full"},
                outFiles: {"correctness-reviewer.json": "raw model text"},
            });
            expect(result.violations.map((v) => v.code)).toEqual([
                "correctness-unparseable-undisclosed",
            ]);
        });
    });

    describe("planned-shed disclosure (rule 3)", () => {
        const routing = {
            enabledReviewers: ["holistic", "test-adequacy"],
            lensesToSpawn: ["security-auth"],
        };

        it("passes when every planned-but-undispatched name is disclosed", () => {
            const result = evaluate({
                items: [
                    submitItem(
                        "APPROVE",
                        [
                            "Note: holistic not assessed this run (shed under the High-tier run budget).",
                            "Note: test-adequacy not assessed this run (shed under the High-tier run budget).",
                            "Note: security-auth not assessed this run (shed under the High-tier run budget).",
                        ].join("\n"),
                    ),
                ],
                plan: {depth: "full"},
                routing,
                outFiles: conformingOutFiles(),
            });
            expect(result.conformant).toBe(true);
        });

        it("flags each undisclosed planned shed by name", () => {
            const outFiles = {
                ...conformingOutFiles(),
                "holistic.json": JSON.stringify({findings: []}),
            };
            const result = evaluate({
                items: [
                    submitItem(
                        "APPROVE",
                        "Approved — no blocking issues found.",
                    ),
                ],
                plan: {depth: "scoped"},
                routing,
                outFiles,
            });
            expect(result.violations).toEqual([
                expect.objectContaining({
                    code: "shed-undisclosed",
                    dimension: "test-adequacy",
                }),
                expect.objectContaining({
                    code: "shed-undisclosed",
                    dimension: "security-auth",
                }),
            ]);
        });

        it("skips the rule (with a note) when routing was never staged", () => {
            const result = evaluate({
                items: [submitItem("APPROVE")],
                plan: {depth: "full"},
                outFiles: conformingOutFiles(),
            });
            expect(result.conformant).toBe(true);
            expect(result.notes.join(" ")).toContain(
                "planned-roster rule skipped",
            );
        });
    });
});

describe("disclosesSkippedDimension", () => {
    it("matches the observed production validator wording (Khan/actions#272)", () => {
        expect(
            disclosesSkippedDimension(
                "Note: claim validation not assessed this run (claim-validator output unavailable).",
                "claim-validator",
            ),
        ).toBe(true);
    });

    it("matches the planned-shed wording and separator variants", () => {
        expect(
            disclosesSkippedDimension(
                "Note: test adequacy not assessed this run (shed under the Low-tier run budget).",
                "test-adequacy",
            ),
        ).toBe(true);
        expect(
            disclosesSkippedDimension(
                "Note: security/auth not assessed this run (shed under the Low-tier run budget).",
                "security-auth",
            ),
        ).toBe(true);
    });

    it("requires the not-assessed phrasing, not a bare name mention", () => {
        expect(
            disclosesSkippedDimension(
                "The holistic reviewer found nothing.",
                "holistic",
            ),
        ).toBe(false);
        expect(
            disclosesSkippedDimension(
                "Note: holistic not assessed this run.",
                "security-auth",
            ),
        ).toBe(false);
    });
});

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal in-memory fs honoring the paths the CLI touches. */
const makeFakeFs = (
    files: Record<string, string>,
): DispatchGateFs & {
    files: Record<string, string>;
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
        readdirSync: (p: string) => {
            const prefix = `${p}/`;
            return [
                ...new Set(
                    Object.keys(state)
                        .filter((f) => f.startsWith(prefix))
                        .map((f) => f.slice(prefix.length).split("/")[0]),
                ),
            ];
        },
    };
};

const AGENT_OUTPUT = "/tmp/gh-aw/agent_output.json";
const OUT = "/tmp/gh-aw/review/out";

describe("runDispatchGateCli", () => {
    it("blocks a synthetic violation: strips posting items, keeps evidence, preserves the original queue", () => {
        // The fabricated out/ directory is missing correctness-reviewer.json;
        // the queue carries a verdict, comments, a thread resolution, and the
        // artifact upload (the definition-of-done repro).
        const queue = {
            items: [
                {
                    type: "create_pull_request_review_comment",
                    path: "a.ts",
                    line: 1,
                    body: "x",
                },
                {
                    type: "submit_pull_request_review",
                    event: "REQUEST_CHANGES",
                    body: "Changes requested — see inline comments.",
                },
                {
                    type: "resolve_pull_request_review_thread",
                    thread_id: "PRRT_1",
                },
                {type: "add_comment", body: "risks"},
                {type: "upload_artifact", path: "out"},
                {type: "missing_tool", tool: "x"},
            ],
        };
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify(queue),
            [`${OUT}/orchestrator-findings.json`]: "{}",
        });
        const report = runDispatchGateCli(fs);

        expect(report.blocked).toBe(true);
        expect(report.violations.map((v) => v.code)).toEqual([
            "correctness-missing",
            "validator-missing-with-findings",
        ]);
        // The rewritten queue keeps only the KEEP_ITEM_TYPES survivors.
        const rewritten = JSON.parse(fs.files[AGENT_OUTPUT]) as {
            items: {type: string}[];
        };
        expect(rewritten.items.map((i) => i.type)).toEqual([
            "upload_artifact",
            "missing_tool",
        ]);
        expect(rewritten.items.every((i) => KEEP_ITEM_TYPES.has(i.type))).toBe(
            true,
        );
        // Forensics: the original queue and the report ride the agent artifact.
        expect(
            JSON.parse(fs.files["/tmp/gh-aw/agent/agent_output.pre-gate.json"]),
        ).toEqual(queue);
        const report2 = JSON.parse(
            fs.files["/tmp/gh-aw/agent/dispatch-gate.json"],
        ) as {blocked: boolean; strippedItemTypes: Record<string, number>};
        expect(report2.blocked).toBe(true);
        expect(report2.strippedItemTypes).toEqual({
            create_pull_request_review_comment: 1,
            submit_pull_request_review: 1,
            resolve_pull_request_review_thread: 1,
            add_comment: 1,
        });
    });

    it("leaves a conforming run's queue untouched and reports conformant", () => {
        const queueText = JSON.stringify({
            items: [
                {
                    type: "create_pull_request_review_comment",
                    path: "a.ts",
                    line: 1,
                    body: "x",
                },
                {
                    type: "submit_pull_request_review",
                    event: "APPROVE",
                    body: "",
                },
            ],
        });
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: queueText,
            "/tmp/gh-aw/review/routing.json": JSON.stringify({
                enabledReviewers: [],
                lensesToSpawn: [],
            }),
            "/tmp/gh-aw/review/rereview-plan.json": JSON.stringify({
                depth: "full",
            }),
            [`${OUT}/pattern-triage.json`]: JSON.stringify({
                reviewFiles: ["a.ts"],
            }),
            [`${OUT}/correctness-reviewer.json`]: "{}",
            [`${OUT}/claim-validator.json`]: "{}",
        });
        const report = runDispatchGateCli(fs);
        expect(report.blocked).toBe(false);
        expect(report.violations).toEqual([]);
        expect(fs.files[AGENT_OUTPUT]).toBe(queueText);
        expect(fs.files["/tmp/gh-aw/agent/agent_output.pre-gate.json"]).toBe(
            undefined,
        );
        // The report still lands for the conformance-rate measurement.
        expect(
            (
                JSON.parse(fs.files["/tmp/gh-aw/agent/dispatch-gate.json"]) as {
                    blocked: boolean;
                }
            ).blocked,
        ).toBe(false);
    });

    it("reads the plan from the out/ copy when the review-dir original is gone", () => {
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({
                items: [
                    {
                        type: "submit_pull_request_review",
                        event: "APPROVE",
                        body: "",
                    },
                ],
            }),
            [`${OUT}/rereview-plan.json`]: JSON.stringify({depth: "fast"}),
        });
        const report = runDispatchGateCli(fs);
        expect(report.depth).toBe("fast");
        expect(report.blocked).toBe(false);
    });

    it("gates nothing when the queue is missing or unparseable (placeholder runs)", () => {
        for (const files of [
            {},
            {[AGENT_OUTPUT]: "not json"},
            {[AGENT_OUTPUT]: JSON.stringify({items: []})},
        ]) {
            const fs = makeFakeFs(files);
            const report = runDispatchGateCli(fs);
            expect(report.blocked).toBe(false);
            expect(report.conformant).toBe(true);
        }
    });

    it("renders a summary a human can read at a glance", () => {
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({
                items: [
                    {
                        type: "submit_pull_request_review",
                        event: "REQUEST_CHANGES",
                        body: "Changes requested — see inline comments.",
                    },
                ],
            }),
        });
        const report = runDispatchGateCli(fs);
        const summary = renderGateSummary(report);
        expect(summary).toContain("## Dispatch-conformance gate");
        expect(summary).toContain("**BLOCKED**");
        expect(summary).toContain("correctness-missing");
        const okSummary = renderGateSummary({
            ...report,
            blocked: false,
            violations: [],
            verdictEvent: null,
            commentCount: 0,
        });
        expect(okSummary).toContain("Nothing to gate");
    });
});

describe("fail-open ordering and disclosure precision (review feedback)", () => {
    it("requires the phrase and the dimension on the same line", () => {
        // One legitimate note plus a prose mention of another dimension: the
        // mention must not read as that dimension's disclosure.
        const body = [
            "Note: holistic not assessed this run (shed under the High-tier run budget).",
            "No security/auth concerns in this change.",
        ].join("\n");
        expect(disclosesSkippedDimension(body, "holistic")).toBe(true);
        expect(disclosesSkippedDimension(body, "security-auth")).toBe(false);
    });

    it("flags a present-but-unparseable validator output with findings queued", () => {
        const result = evaluate({
            items: [commentItem(), submitItem("APPROVE", "")],
            plan: {depth: "fast"},
            outFiles: {"claim-validator.json": "not json"},
        });
        expect(result.violations.map((v) => v.code)).toEqual([
            "validator-missing-with-findings",
        ]);
        expect(result.violations[0].detail).toContain("unparseable");
    });

    it("strips and counts a typeless item under (untyped)", () => {
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({
                items: [
                    {event: "REQUEST_CHANGES"},
                    {
                        type: "submit_pull_request_review",
                        event: "REQUEST_CHANGES",
                        body: "x",
                    },
                ],
            }),
        });
        const report = runDispatchGateCli(fs);
        expect(report.blocked).toBe(true);
        expect(report.strippedItemTypes["(untyped)"]).toBe(1);
        expect(JSON.parse(fs.files[AGENT_OUTPUT]).items).toEqual([]);
    });

    it("writes the violation sentinel only on a real block", () => {
        const blockedFs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({
                items: [
                    {
                        type: "submit_pull_request_review",
                        event: "REQUEST_CHANGES",
                        body: "x",
                    },
                ],
            }),
        });
        runDispatchGateCli(blockedFs);
        expect(blockedFs.files[BLOCKED_SENTINEL_PATH]).toBeDefined();

        const cleanFs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({items: []}),
        });
        runDispatchGateCli(cleanFs);
        expect(cleanFs.files[BLOCKED_SENTINEL_PATH]).toBe(undefined);
    });

    it("leaves the queue intact when a pre-decision write throws (fail-open path)", () => {
        const queueText = JSON.stringify({
            items: [
                {
                    type: "submit_pull_request_review",
                    event: "REQUEST_CHANGES",
                    body: "x",
                },
            ],
        });
        const fs = makeFakeFs({[AGENT_OUTPUT]: queueText});
        const failingFs = {
            ...fs,
            writeFileSync: (p: string, data: string) => {
                if (p.endsWith("dispatch-gate.json")) {
                    throw new Error("disk full");
                }
                fs.writeFileSync(p, data);
            },
        };
        expect(() => runDispatchGateCli(failingFs)).toThrow("disk full");
        // The report write precedes every queue mutation, so the original
        // queue is untouched and the CLI entry fails open.
        expect(fs.files[AGENT_OUTPUT]).toBe(queueText);
        expect(fs.files[BLOCKED_SENTINEL_PATH]).toBe(undefined);
    });

    it("degrades block to detect (still red) when only the queue rewrite fails", () => {
        const queueText = JSON.stringify({
            items: [
                {
                    type: "submit_pull_request_review",
                    event: "REQUEST_CHANGES",
                    body: "x",
                },
            ],
        });
        const fs = makeFakeFs({[AGENT_OUTPUT]: queueText});
        const failingFs = {
            ...fs,
            writeFileSync: (p: string, data: string) => {
                if (p === AGENT_OUTPUT) {
                    throw new Error("read-only queue");
                }
                fs.writeFileSync(p, data);
            },
        };
        const report = runDispatchGateCli(failingFs);
        expect(report.blocked).toBe(true);
        expect(report.notes.join(" ")).toContain("queue rewrite failed");
        // The sentinel landed, so the step still fails the job.
        expect(fs.files[BLOCKED_SENTINEL_PATH]).toBeDefined();
        expect(fs.files[AGENT_OUTPUT]).toBe(queueText);
    });

    it("notes a present-but-unparseable routing.json distinctly from a missing one", () => {
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({items: []}),
            "/tmp/gh-aw/review/routing.json": "corrupt {",
        });
        const report = runDispatchGateCli(fs);
        expect(report.notes.join(" ")).toContain("present but unparseable");
    });
});

describe("re-review hardening (second feedback round)", () => {
    it("a disclosure note does not waive a fully-missing correctness output", () => {
        const result = evaluate({
            items: [
                submitItem(
                    "APPROVE",
                    "Note: correctness not assessed this run (correctness-reviewer output unavailable).",
                ),
            ],
            plan: {depth: "full"},
            outFiles: {},
        });
        expect(result.violations.map((v) => v.code)).toEqual([
            "correctness-missing",
        ]);
    });

    it("still strips the queue when the sentinel/pre-gate writes fail", () => {
        const queueText = JSON.stringify({
            items: [
                {
                    type: "submit_pull_request_review",
                    event: "REQUEST_CHANGES",
                    body: "x",
                },
            ],
        });
        const fs = makeFakeFs({[AGENT_OUTPUT]: queueText});
        const failingFs = {
            ...fs,
            writeFileSync: (p: string, data: string) => {
                if (
                    p === BLOCKED_SENTINEL_PATH ||
                    p.endsWith("agent_output.pre-gate.json")
                ) {
                    throw new Error("disk full");
                }
                fs.writeFileSync(p, data);
            },
        };
        const report = runDispatchGateCli(failingFs);
        expect(report.blocked).toBe(true);
        expect(report.notes.join(" ")).toContain(
            "sentinel/pre-gate write failed",
        );
        // The queue rewrite still ran: the violating queue can never post.
        expect(JSON.parse(fs.files[AGENT_OUTPUT]).items).toEqual([]);
    });
});

describe("third-round nits: keep-list survivors, template coupling, summary", () => {
    it("keeps noop and missing_data through a strip", () => {
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({
                items: [
                    {
                        type: "submit_pull_request_review",
                        event: "REQUEST_CHANGES",
                        body: "x",
                    },
                    {type: "noop", message: "m"},
                    {type: "missing_data", data: "d"},
                ],
            }),
        });
        const report = runDispatchGateCli(fs);
        expect(report.blocked).toBe(true);
        expect(
            JSON.parse(fs.files[AGENT_OUTPUT]).items.map(
                (i: {type: string}) => i.type,
            ),
        ).toEqual(["noop", "missing_data"]);
    });

    it("review.md's Step 6 note templates still carry the phrase the gate matches", () => {
        // Couples the disclosure matcher to the prompt templates: a Step 6
        // reword that drops the phrase must fail here, not silently break
        // rules 2/3 in production.
        const reviewMd = readFileSync(
            join(__dirname, "..", "review.md"),
            "utf8",
        );
        expect(reviewMd).toContain(
            "not assessed this run (shed under the <tier>-tier run budget)",
        );
        expect(reviewMd).toContain(
            "not assessed this run (<sub-agent> output unavailable)",
        );
    });

    it("renders the Conformant summary branch", () => {
        const fs = makeFakeFs({
            [AGENT_OUTPUT]: JSON.stringify({
                items: [
                    {
                        type: "submit_pull_request_review",
                        event: "APPROVE",
                        body: "Approved — no blocking issues found.",
                    },
                ],
            }),
            "/tmp/gh-aw/review/rereview-plan.json": JSON.stringify({
                depth: "fast",
            }),
        });
        const report = runDispatchGateCli(fs);
        expect(report.blocked).toBe(false);
        expect(renderGateSummary(report)).toContain("Conformant.");
    });
});
