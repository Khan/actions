import {describe, it, expect} from "vitest";

import {
    aggregateSamples,
    extractSamples,
    renderAggregateMarkdown,
} from "./aggregate";
import {rawReport} from "./aggregate-fixtures";

describe("pooled cost at Khan's rate", () => {
    const KHAN = new Map([
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
    /** $1.50 at opus-5 list (matches the fixture's baseline usd), $0.75 Khan. */
    const opusTokens = {
        model: "claude-opus-5",
        input: 100_000,
        output: 40_000,
        cacheRead: 0,
        cacheWrite: 0,
    };
    const haikuTokens = {
        model: "claude-haiku-4-5-20251001",
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
    };
    const withTokens = {
        perCase: [
            {
                caseId: "case-1",
                agentCosts: [
                    {
                        agent: "correctness-reviewer",
                        model: "claude-opus-5",
                        usd: 1.5,
                        usage: [opusTokens],
                    },
                ],
            },
        ],
        overhead: {judge: [haikuTokens], arbiter: []},
    };

    it("extracts per-agent cost and the instrument's tokens per sample", () => {
        const [sample] = extractSamples(
            "r1",
            rawReport({baselineTokens: withTokens}),
        );
        expect(sample?.baseline.agentCosts).toEqual([
            {
                agent: "correctness-reviewer",
                model: "claude-opus-5",
                usd: 1.5,
                usage: [opusTokens],
            },
        ]);
        expect(sample?.baseline.overhead).toEqual([haikuTokens]);
        expect(sample?.candidate.agentCosts).toBeUndefined();
        expect(sample?.candidate.overhead).toBeUndefined();
    });

    it("prices the pool at Khan's rate beside list and adds the instrument's spend", () => {
        const raw = rawReport({
            baselineTokens: withTokens,
            candidateTokens: withTokens,
        });
        const report = aggregateSamples([
            ...extractSamples("r1", raw),
            ...extractSamples("r2", raw),
        ]);
        const plain = renderAggregateMarkdown(report);
        expect(plain).toContain("| Cost (list price) | $3.00 |  | $5.00 |  |");
        expect(plain).not.toContain("Khan rate");
        const markdown = renderAggregateMarkdown(report, {khanRates: KHAN});
        expect(markdown).toContain(
            "| Cost (Khan rate) | $1.50 |  | $1.50 |  |",
        );
        expect(markdown).toContain(
            "| Judge + arbiter (list / Khan rate) | $2.00 / $1.00 |  | $2.00 / $1.00 |  |",
        );
        expect(markdown).not.toContain("cover only the samples");
        // Sub-agents (3.00 / 1.50 pooled) plus the instrument, like the
        // single-run table's row.
        expect(markdown).toContain(
            "| Run total (list / Khan rate) | $5.00 / $2.50 |  | $7.00 / $2.50 |  |",
        );
        // The same provenance the single-run table carries, so a pooled
        // fallback-to-list figure cannot pass for an overlay price.
        expect(markdown).toContain(
            "Cost (Khan rate) prices the same tokens at the `models.providers` overlay in review.md, which is what production meters (claude-opus-5).",
        );
        expect(markdown).not.toContain("List-rate check");
    });

    it("carries the list-rate check and the at-list note into the pooled table", () => {
        const drifted = {
            ...withTokens,
            perCase: [
                {
                    caseId: "case-1",
                    agentCosts: [
                        // The SDK metered twice what the table prices.
                        {
                            agent: "correctness-reviewer",
                            model: "claude-opus-5",
                            usd: 3,
                            usage: [opusTokens],
                        },
                        {
                            agent: "gemini-lens",
                            model: "gemini-3.8-flash",
                            usd: 1,
                            usage: [{...opusTokens, model: "gemini-3.8-flash"}],
                        },
                    ],
                },
            ],
        };
        const markdown = renderAggregateMarkdown(
            aggregateSamples(
                extractSamples("r1", rawReport({baselineTokens: drifted})),
            ),
            {khanRates: KHAN},
        );
        expect(markdown).toContain(
            "No overlay entry, so read at list: gemini-3.8-flash.",
        );
        expect(markdown).toContain(
            "List-rate check (baseline): the eval's list table prices these tokens at $1.50 and the SDK metered $3.00 (0.50x).",
        );
    });

    it("says when only some pooled samples recorded tokens", () => {
        const report = aggregateSamples([
            ...extractSamples("r1", rawReport({baselineTokens: withTokens})),
            ...extractSamples("r2", rawReport({})),
        ]);
        const markdown = renderAggregateMarkdown(report, {khanRates: KHAN});
        expect(markdown).toContain("| Cost (Khan rate) | $0.75 |  | n/a |  |");
        expect(markdown).toContain(
            "Khan-rate figures cover only the samples that recorded per-agent cost (baseline: 1/2), the list figure covers every sample.",
        );
    });
});
