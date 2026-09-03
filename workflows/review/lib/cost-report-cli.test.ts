import {describe, it, expect} from "vitest";

import {
    COST_REPORT_PATH,
    resolveRateCard,
    runCostReportCli,
    type CostReportFs,
} from "./cost-report-cli";

/** An in-memory fs over a path -> content map. */
const memFs = (
    files: Record<string, string>,
): CostReportFs & {files: Record<string, string>} => ({
    files,
    readFileSync: (p) => {
        if (!(p in files)) {
            throw new Error(`ENOENT ${p}`);
        }
        return files[p] as string;
    },
    writeFileSync: (p, data) => {
        files[p] = data;
    },
    appendFileSync: (p, data) => {
        files[p] = (files[p] ?? "") + data;
    },
    existsSync: (p) => p in files,
    mkdirSync: () => {},
});

const OPUS_6 = {
    model: "claude-opus-5",
    input: 400_000,
    output: 160_000,
    cacheRead: 0,
    cacheWrite: 0,
};

const MODELS_JSON = JSON.stringify({
    providers: {
        anthropic: {
            models: {
                "claude-opus-5": {
                    cost: {
                        input: "2.5e-06",
                        output: "1.25e-05",
                        cache_read: "2.5e-07",
                        cache_write: "3.125e-06",
                    },
                },
            },
        },
    },
});

const DISPATCH_RESULT = JSON.stringify({
    perAgent: [
        {
            name: "correctness-reviewer",
            model: "claude-opus-5",
            usd: 6,
            turns: 10,
            wallMs: 60_000,
            usage: [OPUS_6],
            toolCalls: 40,
        },
    ],
});

const PROXY_LOG = [
    JSON.stringify({
        request_id: "r1",
        model: "claude-opus-5-20260401",
        input_tokens: 800_000,
        output_tokens: 320_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
    }),
    "not json",
    "",
].join("\n");

const QUEUE = JSON.stringify({
    items: [
        {type: "create_pull_request_review_comment", body: "inline"},
        {
            type: "submit_pull_request_review",
            event: "COMMENT",
            body: "Review body.\n\n<details><summary><sub>review fingerprint</sub></summary>\n<sub>x</sub>\n</details>",
        },
    ],
});

describe("resolveRateCard", () => {
    it("prefers gh-aw's models.json and falls back to the lib checkout's review.md", () => {
        const withModels = memFs({
            "/tmp/gh-aw/models.json": MODELS_JSON,
            "workflows/review/review.md":
                '---\nmodels:\n  providers:\n    anthropic:\n      models:\n        claude-opus-5:\n          cost:\n            input: "1e-06"\n            output: "1e-06"\n---\n',
        });
        const fromModels = resolveRateCard(
            withModels,
            "workflows/review/review.md",
        );
        expect(fromModels.source).toBe("/tmp/gh-aw/models.json");
        expect(fromModels.card.get("claude-opus-5")?.input).toBe(2.5e-6);
        const withoutModels = memFs({
            "workflows/review/review.md": withModels.files[
                "workflows/review/review.md"
            ] as string,
        });
        const fromOverlay = resolveRateCard(
            withoutModels,
            "workflows/review/review.md",
        );
        expect(fromOverlay.source).toBe("workflows/review/review.md");
        expect(fromOverlay.card.get("claude-opus-5")?.input).toBe(1e-6);
        expect(
            resolveRateCard(memFs({}), "workflows/review/review.md"),
        ).toEqual({
            card: new Map(),
            source: "none",
        });
    });
});

describe("runCostReportCli", () => {
    it("prices the run, appends the collapsed block before the stamp, and writes the summary and artifact", () => {
        const fs = memFs({
            "/tmp/gh-aw/review/dispatch-result.json": DISPATCH_RESULT,
            "/tmp/gh-aw/models.json": MODELS_JSON,
            "/tmp/gh-aw/agent_usage.json": JSON.stringify({ai_credits: 600}),
            "/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl":
                PROXY_LOG,
            // The same request under the audit dir: deduped by request_id.
            "/tmp/gh-aw/sandbox/firewall/audit/api-proxy-logs/token-usage.jsonl":
                PROXY_LOG,
            "/tmp/gh-aw/agent_output.json": QUEUE,
        });
        const outcome = runCostReportCli(fs, {
            reviewMdPath: "workflows/review/review.md",
            stepSummaryPath: "/summary.md",
        });
        expect(outcome.rateSource).toBe("/tmp/gh-aw/models.json");
        expect(outcome.bodyUpdated).toBe(true);
        // Agent $3.00 plus the engine's remainder $3.00, reconciling to the
        // 600 credits gh-aw metered.
        expect(outcome.report.total).toEqual({khanUsd: 6, listUsd: 12});
        expect(outcome.report.reconciliation?.ratio).toBe(1);

        const queue = JSON.parse(
            fs.files["/tmp/gh-aw/agent_output.json"] as string,
        );
        const submit = queue.items[1];
        expect(queue.items[0]).toEqual({
            type: "create_pull_request_review_comment",
            body: "inline",
        });
        expect(submit.event).toBe("COMMENT");
        const costAt = submit.body.indexOf("review cost: $6.00 at Khan's rate");
        const stampAt = submit.body.indexOf("review fingerprint");
        expect(costAt).toBeGreaterThan(0);
        expect(stampAt).toBeGreaterThan(costAt);
        expect(submit.body).toContain(
            "| correctness-reviewer | claude-opus-5 | 40 | 10 | 60s | 400.0k / 160.0k / 0 / 0 | $3.00 | $6.00 |",
        );
        expect(submit.body).toContain("| orchestrator | claude-opus-5 |");

        expect(fs.files["/summary.md"]).toContain("## Review cost");
        expect(fs.files["/summary.md"]).toContain(
            "| Total | | | | | | $6.00 | $12.00 |",
        );
        const artifact = JSON.parse(fs.files[COST_REPORT_PATH] as string);
        expect(artifact.rateSource).toBe("/tmp/gh-aw/models.json");
        expect(artifact.total).toEqual({khanUsd: 6, listUsd: 12});
    });

    it("still writes the summary and artifact when the gate stripped the queue, and notes a missing proxy log", () => {
        const fs = memFs({
            "/tmp/gh-aw/review/dispatch-result.json": DISPATCH_RESULT,
            "/tmp/gh-aw/models.json": MODELS_JSON,
            "/tmp/gh-aw/agent_output.json": JSON.stringify({
                items: [{type: "upload_artifact"}],
            }),
        });
        const outcome = runCostReportCli(fs, {
            reviewMdPath: "workflows/review/review.md",
        });
        expect(outcome.bodyUpdated).toBe(false);
        expect(outcome.report.engine).toBeUndefined();
        expect(outcome.report.notes).toContain(
            "The api-proxy log was not readable, so the orchestrator's share is not in this table and the total is the dispatcher's alone.",
        );
        expect(fs.files["/tmp/gh-aw/agent_output.json"]).toBe(
            JSON.stringify({items: [{type: "upload_artifact"}]}),
        );
        expect(fs.files[COST_REPORT_PATH]).toContain('"khanUsd": 3');
    });

    it("throws when there is no dispatch result, leaving everything untouched", () => {
        const fs = memFs({"/tmp/gh-aw/agent_output.json": QUEUE});
        expect(() =>
            runCostReportCli(fs, {reviewMdPath: "workflows/review/review.md"}),
        ).toThrow(/no dispatch result to price/);
        expect(fs.files["/tmp/gh-aw/agent_output.json"]).toBe(QUEUE);
        expect(fs.files[COST_REPORT_PATH]).toBeUndefined();
    });

    it("notes when no rate table is readable and prices at list", () => {
        const fs = memFs({
            "/tmp/gh-aw/review/dispatch-result.json": DISPATCH_RESULT,
        });
        const outcome = runCostReportCli(fs, {
            reviewMdPath: "workflows/review/review.md",
        });
        expect(outcome.rateSource).toBe("none");
        expect(outcome.report.total.khanUsd).toBe(6);
        expect(outcome.report.notes).toContain(
            "No Khan-rate table was readable on the runner, so Cost (Khan rate) equals the SDK's list figure.",
        );
    });
});
