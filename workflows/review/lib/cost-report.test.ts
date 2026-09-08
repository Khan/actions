import {describe, it, expect} from "vitest";

import {
    buildCostReport,
    compactTokens,
    renderCostDetails,
    renderCostTable,
    withCostDetails,
    type CostAgentEntry,
} from "./cost-report";
import type {ModelTokens, RateCard} from "./pricing";

/** The overlay's opus-5 and haiku-4-5 entries (50% of list). */
const KHAN: RateCard = new Map([
    [
        "claude-opus-5",
        {
            input: 2.5e-6,
            output: 1.25e-5,
            cacheRead: 2.5e-7,
            cacheWrite: 3.125e-6,
        },
    ],
    [
        "claude-haiku-4-5",
        {input: 5e-7, output: 2.5e-6, cacheRead: 5e-8, cacheWrite: 6.25e-7},
    ],
]);

/** Opus tokens that price to exactly $6.00 list, $3.00 Khan. */
const OPUS_6: ModelTokens = {
    model: "claude-opus-5",
    input: 400_000,
    output: 160_000,
    cacheRead: 0,
    cacheWrite: 0,
};
/** Haiku tokens that price to $1.00 list, $0.50 Khan. */
const HAIKU_1: ModelTokens = {
    model: "claude-haiku-4-5-20251001",
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};

const agent = (
    name: string,
    over: Partial<CostAgentEntry> = {},
): CostAgentEntry => ({
    name,
    model: "claude-opus-5",
    usd: 6,
    turns: 10,
    wallMs: 60_000,
    usage: [OPUS_6],
    toolCalls: 40,
    ...over,
});

describe("buildCostReport", () => {
    it("prices each agent from its tokens at Khan's rate and keeps the SDK's list figure beside it", () => {
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer")],
            khan: KHAN,
        });
        expect(report.agents).toHaveLength(1);
        const row = report.agents[0];
        expect(row).toMatchObject({
            label: "correctness-reviewer",
            models: ["claude-opus-5"],
            attempts: 1,
            toolCalls: 40,
            turns: 10,
            wallMs: 60_000,
            khanUsd: 3,
            listUsd: 6,
        });
        expect(report.total).toEqual({khanUsd: 3, listUsd: 6});
        // No proxy log: the orchestrator is missing and the report says so.
        expect(report.engine).toBeUndefined();
        expect(report.notes).toEqual([
            "The api-proxy log was not readable, so the orchestrator's share is not in this table and the total is the dispatcher's alone.",
        ]);
    });

    it("groups an agent's attempts, sums the judge per agent and as its own row", () => {
        const report = buildCostReport({
            perAgent: [
                agent("correctness-reviewer", {
                    failed: "refused",
                    judgeUsage: [HAIKU_1],
                }),
                agent("correctness-reviewer", {
                    fellBackTo: "claude-opus-5",
                    judgeUsage: [HAIKU_1],
                }),
                agent("security-reviewer", {toolCalls: 12}),
            ],
            khan: KHAN,
        });
        expect(report.agents.map((r) => r.label)).toEqual([
            "correctness-reviewer",
            "security-reviewer",
        ]);
        expect(report.agents[0]).toMatchObject({
            attempts: 2,
            toolCalls: 80,
            turns: 20,
            khanUsd: 6,
            listUsd: 12,
            judgeKhanUsd: 1,
        });
        expect(report.judge).toMatchObject({
            label: "prose judge",
            models: ["claude-haiku-4-5"],
            attempts: 2,
            khanUsd: 1,
            listUsd: 2,
        });
        // 6 + 3 agents, 1 judge, at Khan's rate. List: 12 + 6 + 2.
        expect(report.total).toEqual({khanUsd: 10, listUsd: 20});
    });

    it("derives the orchestrator as the proxy remainder per model and reconciles against ai_credits", () => {
        // Proxy saw 2x the agent's opus tokens plus the judge's haiku: the
        // other half of the opus is the engine.
        const proxy: ModelTokens[] = [
            {
                ...OPUS_6,
                model: "claude-opus-5-20260401",
                input: 800_000,
                output: 320_000,
            },
            HAIKU_1,
        ];
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer", {judgeUsage: [HAIKU_1]})],
            khan: KHAN,
            proxyUsage: proxy,
            // 3 (agent) + 0.5 (judge) + 3 (engine) = 6.50 at Khan's rate.
            agentUsage: {ai_credits: 650},
        });
        expect(report.engine).toMatchObject({
            label: "orchestrator",
            models: ["claude-opus-5"],
            khanUsd: 3,
            listUsd: 6,
        });
        expect(report.total).toEqual({khanUsd: 6.5, listUsd: 13});
        expect(report.reconciliation).toEqual({
            aiCreditsUsd: 6.5,
            proxyKhanUsd: 6.5,
            ratio: 1,
        });
        expect(report.notes).toEqual([]);
    });

    it("flags a reconciliation gap and a dispatcher meter the proxy never saw", () => {
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer")],
            khan: KHAN,
            // The proxy saw fewer opus tokens than the SDK claims.
            proxyUsage: [{...OPUS_6, input: 200_000, output: 80_000}],
            // gh-aw says $3.00; the proxy tokens price to $1.50 here.
            agentUsage: {ai_credits: 300},
        });
        expect(report.engine?.khanUsd).toBe(0);
        expect(report.notes).toEqual([
            "The dispatcher's meters exceed the proxy's total on claude-opus-5, so the orchestrator row is floored at zero there and the proxy log is likely partial.",
            "gh-aw metered $3.00 and this report prices the same tokens at $1.50 (0.50x): the rate cards differ.",
        ]);
    });

    it("prices an untracked dispatch by ratio and an un-overlaid one at list when there is no proxy log", () => {
        const report = buildCostReport({
            perAgent: [
                agent("correctness-reviewer"),
                agent("security-reviewer", {usage: undefined, usd: 2}),
                agent("gemini-lens", {
                    model: "gemini-3.8-flash",
                    usd: 4,
                    usage: [{...OPUS_6, model: "gemini-3.8-flash"}],
                }),
            ],
            khan: KHAN,
        });
        // 3 from tokens, 2 * 0.5 by ratio (untracked opus), 4 at list.
        expect(report.total.khanUsd).toBe(8);
        expect(report.notes.slice(0, 2)).toEqual([
            "No Khan-rate entry, so read at list: gemini-3.8-flash.",
            "1 dispatch(es) recorded no token counts and are priced from the SDK's list figure by the overlay ratio (at list where the model has none).",
        ]);
    });

    it("leaves an untracked dispatch inside the orchestrator remainder when the proxy log is in hand", () => {
        // The proxy saw both agents' tokens, and only one agent attributed
        // them. Pricing the other's recorded dollars as well would count
        // those tokens twice, once in its row and once in the remainder.
        const report = buildCostReport({
            perAgent: [
                agent("correctness-reviewer"),
                agent("security-reviewer", {usage: undefined, usd: 6}),
            ],
            khan: KHAN,
            proxyUsage: [{...OPUS_6, input: 800_000, output: 320_000}],
            agentUsage: {ai_credits: 600},
        });
        const security = report.agents.find(
            (r) => r.label === "security-reviewer",
        );
        expect(security).toMatchObject({attempts: 1, khanUsd: 0, listUsd: 0});
        expect(report.engine?.khanUsd).toBe(3);
        expect(report.total).toEqual({khanUsd: 6, listUsd: 12});
        expect(report.reconciliation?.ratio).toBe(1);
        expect(report.notes).toEqual([
            "1 dispatch(es) recorded no token counts, so their spend is inside the orchestrator row rather than their own.",
        ]);
    });

    it("flags a dispatcher model the proxy log never saw at all", () => {
        // The `t === undefined` arm: the dispatcher billed opus, the proxy
        // log only has haiku. No negative row is invented, the note says so.
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer")],
            khan: KHAN,
            proxyUsage: [HAIKU_1],
        });
        expect(report.engine).toMatchObject({models: ["claude-haiku-4-5"]});
        expect(report.notes[0]).toBe(
            "The dispatcher's meters exceed the proxy's total on claude-opus-5, so the orchestrator row is floored at zero there and the proxy log is likely partial.",
        );
    });

    it("adds up two proxy model ids that share a pin before taking the remainder", () => {
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer")],
            khan: KHAN,
            proxyUsage: [
                {...OPUS_6, model: "claude-opus-5-20260401"},
                {...OPUS_6, model: "claude-opus-5-20260615"},
            ],
        });
        // 2 * $6 list seen by the proxy, $6 attributed: $6 list left, $3 Khan.
        expect(report.engine).toMatchObject({khanUsd: 3, listUsd: 6});
    });

    it("cross-checks the list table against the SDK's meter on the sub-agents", () => {
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer", {usd: 12})],
            khan: KHAN,
        });
        expect(report.notes).toContain(
            "List-rate check: the list table prices the sub-agents' tokens at $6.00 and the SDK metered $12.00 (0.50x), so one of the two has moved (see pricing.ts).",
        );
    });
});

describe("renderCostTable and renderCostDetails", () => {
    it("renders one row per agent, the judge, the orchestrator, and a total, Khan's rate first", () => {
        const report = buildCostReport({
            perAgent: [agent("correctness-reviewer", {judgeUsage: [HAIKU_1]})],
            khan: KHAN,
            proxyUsage: [{...OPUS_6, input: 800_000, output: 320_000}, HAIKU_1],
            agentUsage: {ai_credits: 650},
        });
        const table = renderCostTable(report);
        expect(table).toContain(
            "| Agent | Model | Calls | Turns | Wall | Tokens in / out / cache read / cache write | Cost (Khan rate) | List price |",
        );
        expect(table).toContain(
            "| correctness-reviewer | claude-opus-5 | 40 | 10 | 60s | 400.0k / 160.0k / 0 / 0 | $3.00 (+$0.50 judge) | $6.00 |",
        );
        expect(table).toContain(
            "| prose judge | claude-haiku-4-5 |  |  |  | 1.0M / 0 / 0 / 0 | $0.50 | $1.00 |",
        );
        expect(table).toContain(
            "| orchestrator | claude-opus-5 |  |  |  | 400.0k / 160.0k / 0 / 0 | $3.00 | $6.00 |",
        );
        expect(table).toContain("| Total | | | | | | $6.50 | $13.00 |");
        expect(table).toContain("gh-aw metered $6.50 for the run");
        const details = renderCostDetails(report);
        expect(
            details.startsWith(
                "<details><summary><sub>review cost: $6.50 at Khan's rate</sub></summary>\n\n|",
            ),
        ).toBe(true);
        expect(details.endsWith("\n\n</details>")).toBe(true);
    });

    it("marks a sub-agents-only total when the proxy log was missing, and escapes cells", () => {
        const report = buildCostReport({
            perAgent: [agent("weird|<name>")],
            khan: KHAN,
        });
        expect(renderCostDetails(report)).toContain(
            "review cost: $3.00 at Khan's rate (sub-agents only)",
        );
        expect(renderCostTable(report)).toContain(
            "| weird&#124;&#60;name&#62; |",
        );
        // Notes carry proxy-log model ids too, so they are escaped as well.
        const proxied = buildCostReport({
            perAgent: [agent("correctness-reviewer")],
            khan: KHAN,
            proxyUsage: [OPUS_6, {...OPUS_6, model: "<img>|x"}],
        });
        expect(renderCostTable(proxied)).toContain(
            "- The proxy saw models this report cannot price: &#60;img&#62;&#124;x.",
        );
    });

    it("formats token counts as magnitudes", () => {
        expect(compactTokens(999)).toBe("999");
        expect(compactTokens(12_345)).toBe("12.3k");
        expect(compactTokens(1_234_567)).toBe("1.2M");
    });
});

describe("withCostDetails", () => {
    const details =
        "<details><summary><sub>review cost: $1.00</sub></summary>\n\n| t |\n\n</details>";

    it("inserts before the fingerprint stamp so the stamp stays the final block", () => {
        const body =
            "Review body.\n\n<details><summary><sub>review fingerprint</sub></summary>\n<sub>x</sub>\n</details>";
        const out = withCostDetails(body, details);
        expect(out).toBe(
            "Review body.\n\n" +
                details +
                "\n\n<details><summary><sub>review fingerprint</sub></summary>\n<sub>x</sub>\n</details>",
        );
    });

    it("ignores a body that merely quotes the chip's markup mid-line", () => {
        const body =
            "The bot writes `<details><summary><sub>review cost` blocks, and this sentence must survive.\n";
        const out = withCostDetails(body, details);
        expect(out.startsWith(body.trimEnd())).toBe(true);
        expect(out.match(/review cost/g)).toHaveLength(2);
    });

    it("appends when there is no stamp, and replaces an existing block rather than stacking", () => {
        const once = withCostDetails("Review body.\n", details);
        expect(once).toBe(`Review body.\n\n${details}\n`);
        const twice = withCostDetails(once, details.replace("$1.00", "$2.00"));
        expect(twice.match(/review cost/g)).toHaveLength(1);
        expect(twice).toContain("$2.00");
        expect(twice).not.toContain("$1.00");
    });
});
