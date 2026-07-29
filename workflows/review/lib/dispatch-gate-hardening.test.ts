import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {
    BLOCKED_SENTINEL_PATH,
    disclosesSkippedDimension,
    evaluateDispatchConformance,
    renderGateSummary,
    runDispatchGateCli,
    type DispatchGateFs,
    type DispatchGateInput,
    type SafeOutputItem,
} from "./dispatch-gate";
import {renderRereviewStamp, STAMP_SCHEMA_VERSION} from "./rereview-mode";

/**
 * Dispatch-conformance gate hardening tests: the review-feedback rounds
 * (fail-open ordering, disclosure precision, keep-list survivors, template
 * coupling, staged-input robustness). Split from dispatch-gate.test.ts by
 * the max-lines budget; the fixtures below are small local copies of that
 * file's helpers.
 */

const AGENT_OUTPUT = "/tmp/gh-aw/agent_output.json";

const makeFakeFs = (
    files: Record<string, string> = {},
): DispatchGateFs & {files: Record<string, string>} => {
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

const submitItem = (event: string, body = ""): SafeOutputItem => ({
    type: "submit_pull_request_review",
    event,
    body,
});

const commentItem = (
    line = 1,
    body = "**suggestion (non-blocking):** x",
): SafeOutputItem => ({
    type: "create_pull_request_review_comment",
    path: "a.ts",
    line,
    body,
});

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

describe("verdict and resolution chokepoints (slice 3)", () => {
    const conforming = () => ({
        plan: {depth: "full"},
        routing: {enabledReviewers: [], lensesToSpawn: []},
        outFiles: conformingOutFiles(),
    });

    it("rejects an APPROVE queued alongside a blocking inline comment", () => {
        const result = evaluate({
            ...conforming(),
            items: [
                commentItem(2, "**issue (blocking):** guard removed"),
                submitItem("APPROVE", ""),
            ],
        });
        expect(result.violations.map((v) => v.code)).toEqual([
            "approve-with-blocking-comment",
        ]);
        // The same comment under REQUEST_CHANGES is the conforming shape.
        const rc = evaluate({
            ...conforming(),
            items: [
                commentItem(2, "**issue (blocking):** guard removed"),
                submitItem(
                    "REQUEST_CHANGES",
                    "Changes requested — see inline comments.",
                ),
            ],
        });
        expect(rc.conformant).toBe(true);
    });

    it("vetoes a reduced-depth flip over kept blocking threads", () => {
        const stampedPrior = [
            {
                body: renderRereviewStamp({
                    schemaVersion: STAMP_SCHEMA_VERSION,
                    depth: "full",
                    verdict: "REQUEST_CHANGES",
                    anchorDraft: false,
                    anchorHunks: {},
                }),
            },
        ];
        const base = {
            items: [submitItem("APPROVE", "")],
            plan: {depth: "fast"},
            outFiles: {"thread-reconciler.json": "{}"},
            priorReviews: stampedPrior,
        };
        const vetoed = evaluate({
            ...base,
            rereviewAccounting: {keptBlockingCount: 2},
        });
        expect(vetoed.violations.map((v) => v.code)).toEqual([
            "flip-vetoed-kept-blocking",
        ]);
        // Zero kept blocking threads: the flip is legitimate.
        const clean = evaluate({
            ...base,
            rereviewAccounting: {keptBlockingCount: 0},
        });
        expect(clean.conformant).toBe(true);
        // Missing accounting fails open, with a note.
        const open = evaluate(base);
        expect(open.conformant).toBe(true);
        expect(open.notes.join(" ")).toContain("fail-open");
        // The rule never applies at full depth.
        const full = evaluate({
            ...conforming(),
            items: [submitItem("APPROVE", "")],
            priorReviews: stampedPrior,
            rereviewAccounting: {keptBlockingCount: 2},
        });
        expect(full.conformant).toBe(true);
    });

    it("vetoes the flip from a cache-memory stamp when posted bodies carry none (the production shape)", () => {
        // Prior bodies exist but the ingest sanitizer stripped their stamps;
        // the flip rule anchors on the same cache-memory carrier the plan
        // CLI used.
        const vetoed = evaluate({
            items: [submitItem("APPROVE", "")],
            plan: {depth: "fast"},
            outFiles: {"thread-reconciler.json": "{}"},
            priorReviews: [{body: "Changes requested — see inline comments."}],
            cacheMemory: {
                verdict: "REQUEST_CHANGES",
                stampHunks: {"a.ts": ["deadbeef00000000"]},
                wasDraft: false,
            },
            rereviewAccounting: {keptBlockingCount: 2},
        });
        expect(vetoed.violations.map((v) => v.code)).toEqual([
            "flip-vetoed-kept-blocking",
        ]);
        // An invalid cache record anchors nothing: fail-open, no veto.
        const open = evaluate({
            items: [submitItem("APPROVE", "")],
            plan: {depth: "fast"},
            outFiles: {"thread-reconciler.json": "{}"},
            priorReviews: [{body: "no stamp"}],
            cacheMemory: {verdict: "COMMENTED"},
            rereviewAccounting: {keptBlockingCount: 2},
        });
        expect(open.conformant).toBe(true);
    });

    it("rejects a queued resolution the reconciler did not decide", () => {
        const resolveItem = (id: string): SafeOutputItem => ({
            type: "resolve_pull_request_review_thread",
            thread_id: id,
        });
        const outFiles = {
            ...conformingOutFiles(),
            "thread-reconciler.json": JSON.stringify({
                resolve: ["t1", "t2"],
                keep: ["t3"],
            }),
        };
        const rogue = evaluate({
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            items: [submitItem("APPROVE", ""), resolveItem("t3")],
        });
        expect(rogue.violations.map((v) => v.code)).toEqual([
            "resolve-not-decided",
        ]);
        // Decided resolutions pass; the deficit is reported, not blocked.
        const partial = evaluate({
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles,
            items: [submitItem("APPROVE", ""), resolveItem("t1")],
        });
        expect(partial.conformant).toBe(true);
        expect(partial.notes.join(" ")).toContain(
            "1 reconciler-decided resolution(s) not queued (t2)",
        );
        // Resolutions with no reconciler output at all are the freelance move.
        const noReconciler = evaluate({
            plan: {depth: "full"},
            routing: {enabledReviewers: [], lensesToSpawn: []},
            outFiles: conformingOutFiles(),
            items: [submitItem("APPROVE", ""), resolveItem("t1")],
        });
        expect(noReconciler.violations.map((v) => v.code)).toEqual([
            "resolve-not-decided",
        ]);
    });
});

describe("staged-input robustness (slice 3 re-review)", () => {
    it("tolerates null and non-object entries in prior-reviews.json", () => {
        const stamp = renderRereviewStamp({
            schemaVersion: STAMP_SCHEMA_VERSION,
            depth: "full",
            verdict: "REQUEST_CHANGES",
            anchorDraft: false,
            anchorHunks: {},
        });
        const result = evaluate({
            items: [submitItem("APPROVE", "")],
            plan: {depth: "fast"},
            outFiles: {},
            priorReviews: [null, 42, "junk", {nobody: true}, {body: stamp}],
            rereviewAccounting: {keptBlockingCount: 1},
        });
        // The valid stamp is still found and the flip veto still fires; the
        // garbage entries neither throw nor disable the gate.
        expect(result.violations.map((v) => v.code)).toEqual([
            "flip-vetoed-kept-blocking",
        ]);
    });
});
