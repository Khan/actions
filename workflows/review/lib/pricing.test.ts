import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {
    ANTHROPIC_LIST_RATES,
    khanCost,
    listDrift,
    mergeUsage,
    pinOf,
    priceTokens,
    rateCardFromProviders,
    readOverlayRates,
    usageOfResponse,
    usageOfResultMessage,
    type AgentCost,
    type ModelTokens,
} from "./pricing";

const reviewMd = readFileSync(join(__dirname, "..", "review.md"), "utf8");

/** 1M input, 100k output, 2M cache read, 200k cache write. */
const OPUS_TOKENS: ModelTokens = {
    model: "claude-opus-5",
    input: 1_000_000,
    output: 100_000,
    cacheRead: 2_000_000,
    cacheWrite: 200_000,
};

describe("readOverlayRates", () => {
    it("reads every overlay entry in review.md as per-token rates", () => {
        const card = readOverlayRates(reviewMd);
        // The exact pin set, so a pin the walker silently drops (which the
        // report would then read as "no overlay entry", 2x production, and
        // look intentional) fails here. Update this list with the overlay.
        expect([...card.keys()].sort()).toEqual([
            "claude-fable-5",
            "claude-haiku-4-5",
            "claude-opus-4-8",
            "claude-opus-5",
            "claude-sonnet-4-6",
            "claude-sonnet-5",
        ]);
        expect(card.get("claude-opus-5")).toEqual({
            input: 2.5e-6,
            output: 1.25e-5,
            cacheRead: 2.5e-7,
            cacheWrite: 3.125e-6,
        });
    });

    it("ignores comments and unrelated blocks, drops half-read entries, derives missing cache rates", () => {
        const md = [
            "---",
            "models:",
            "  # $/1M tokens, a different unit; must not be read as a pin",
            "  default-ai-credits-pricing:",
            "    input: 5.0",
            "    output: 25.0",
            "  providers:",
            "    anthropic:",
            "      models:",
            "        # a comment between pins",
            "        claude-opus-5:",
            "          cost:",
            '            input: "2.5e-06"',
            '            output: "1.25e-05"',
            '            cache_read: "2.5e-07"',
            '            cache_write: "3.125e-06"',
            "        claude-half-read:",
            "          cost:",
            '            input: "1e-06"',
            "    google:",
            "      models:",
            "        gemini-x:",
            "          cost:",
            "            input: 1e-07",
            "            output: 4e-07",
            "max-ai-credits: 1000",
            "---",
            "body: not frontmatter",
        ].join("\n");
        expect([...readOverlayRates(md)]).toEqual([
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
                "gemini-x",
                {
                    input: 1e-7,
                    output: 4e-7,
                    cacheRead: 1e-8,
                    cacheWrite: 1.25e-7,
                },
            ],
        ]);
    });

    it("lists every overlay pin in the list table, at a flat multiple across token classes", () => {
        // A pin the overlay prices but the list table does not would leave
        // the list-rate check blind on that model. The flat-multiple check
        // is documentation as much as a guard: the overlay's note says 50%
        // of list, and this is where that stops being prose.
        for (const [pin, khan] of readOverlayRates(reviewMd)) {
            const list = ANTHROPIC_LIST_RATES.get(pin);
            expect(
                list,
                `${pin} has an overlay entry but no list rate`,
            ).toBeDefined();
            if (list === undefined) {
                continue;
            }
            const ratio = khan.input / list.input;
            expect(khan.output / list.output).toBeCloseTo(ratio, 9);
            expect(khan.cacheRead / list.cacheRead).toBeCloseTo(ratio, 9);
            expect(khan.cacheWrite / list.cacheWrite).toBeCloseTo(ratio, 9);
            expect(ratio).toBeCloseTo(0.5, 9);
        }
    });
});

describe("rateCardFromProviders", () => {
    it("lets anthropic's entry win over another provider's copy of the same pin", () => {
        // gh-aw's models.json carries claude-opus-5 under anthropic (the
        // overlay, 2.5e-06) and github-copilot (list, 5e-06). Object order
        // must not decide which one prices the run.
        const providers = {
            "github-copilot": {
                models: {
                    "claude-opus-5": {
                        cost: {input: "5e-06", output: "2.5e-05"},
                    },
                },
            },
            anthropic: {
                models: {
                    "claude-opus-5": {
                        cost: {input: "2.5e-06", output: "1.25e-05"},
                    },
                },
            },
            google: {
                models: {
                    "gemini-3.8-flash": {cost: {input: 1e-7, output: 4e-7}},
                },
            },
        };
        const card = rateCardFromProviders(providers);
        expect(card.get("claude-opus-5")?.input).toBe(2.5e-6);
        expect(card.get("gemini-3.8-flash")?.input).toBe(1e-7);
        expect(
            rateCardFromProviders({anthropic: providers.anthropic}).size,
        ).toBe(1);
        expect(rateCardFromProviders(null).size).toBe(0);
    });
});

describe("usageOfResultMessage", () => {
    it("reads modelUsage keyed by canonical model, and is undefined without it", () => {
        expect(
            usageOfResultMessage({
                modelUsage: {
                    "claude-opus-5": {
                        inputTokens: 10,
                        outputTokens: 20,
                        cacheReadInputTokens: 30,
                        cacheCreationInputTokens: 40,
                        costUSD: 0.01,
                    },
                    "claude-haiku-4-5-20251001": {
                        inputTokens: 1,
                        canonicalModel: "claude-haiku-4-5",
                    },
                },
            }),
        ).toEqual([
            {
                model: "claude-opus-5",
                input: 10,
                output: 20,
                cacheRead: 30,
                cacheWrite: 40,
            },
            {
                model: "claude-haiku-4-5",
                input: 1,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
        ]);
        expect(usageOfResultMessage({})).toBeUndefined();
        expect(usageOfResultMessage({modelUsage: {}})).toBeUndefined();
    });
});

describe("priceTokens", () => {
    it("prices each token class at its own rate and sums across models", () => {
        // Opus 5 list: $5 + $0.5*... per class: 1M*5e-6 + 100k*25e-6 +
        // 2M*0.5e-6 + 200k*6.25e-6 = 5 + 2.5 + 1 + 1.25 = 9.75.
        expect(priceTokens([OPUS_TOKENS], ANTHROPIC_LIST_RATES)).toEqual({
            usd: 9.75,
            unpriced: [],
        });
        const khan = readOverlayRates(reviewMd);
        expect(priceTokens([OPUS_TOKENS], khan).usd).toBeCloseTo(4.875, 9);
    });

    it("prices a dated id under its pin and names the models it cannot price", () => {
        expect(pinOf("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
        expect(pinOf("gemini-3.8-flash")).toBe("gemini-3.8-flash");
        const priced = priceTokens(
            [
                {...OPUS_TOKENS, model: "claude-haiku-4-5-20251001"},
                {...OPUS_TOKENS, model: "gemini-3.8-flash"},
            ],
            ANTHROPIC_LIST_RATES,
        );
        // Haiku list: 1 + 0.5 + 0.2 + 0.25 = 1.95, gemini left out and named.
        expect(priced.usd).toBeCloseTo(1.95, 9);
        expect(priced.unpriced).toEqual(["gemini-3.8-flash"]);
    });
});

describe("mergeUsage", () => {
    it("sums per model and sorts by model id", () => {
        expect(
            mergeUsage([
                {...OPUS_TOKENS, model: "b"},
                {...OPUS_TOKENS, model: "a"},
                {...OPUS_TOKENS, model: "b"},
            ]),
        ).toEqual([
            {...OPUS_TOKENS, model: "a"},
            {
                model: "b",
                input: 2_000_000,
                output: 200_000,
                cacheRead: 4_000_000,
                cacheWrite: 400_000,
            },
        ]);
    });
});

const cost = (usd: number, usage?: ModelTokens): AgentCost => ({
    agent: "a",
    model: usage?.model ?? "m",
    usd,
    ...(usage === undefined ? {} : {usage: [usage]}),
});

describe("khanCost", () => {
    const khan = readOverlayRates(reviewMd);

    it("prices tokens at the overlay and keeps recorded list dollars where it cannot", () => {
        const gemini = {...OPUS_TOKENS, model: "gemini-3.8-flash"};
        expect(
            khanCost(
                [
                    cost(9.75, OPUS_TOKENS),
                    cost(4, gemini),
                    {agent: "u", model: "claude-opus-5", usd: 2},
                ],
                khan,
            ),
        ).toEqual({
            // 4.875 for opus from tokens, 4 for gemini at its recorded list,
            // and the untracked opus dispatch by ratio: 2 * 0.5.
            usd: 9.875,
            atList: ["gemini-3.8-flash"],
            untracked: 1,
        });
    });

    it("treats an empty usage list as untracked, and an untracked model with no ratio as list", () => {
        // A result whose modelUsage carried no per-model attribution reaches
        // here as `[]`, and it must not read as free.
        expect(
            khanCost(
                [
                    {agent: "a", model: "claude-opus-5", usd: 2, usage: []},
                    {agent: "b", model: "gemini-3.8-flash", usd: 3},
                ],
                khan,
            ),
        ).toEqual({usd: 4, atList: ["gemini-3.8-flash"], untracked: 2});
    });
});

describe("listDrift", () => {
    it("is silent within tolerance and reports the ratio outside it", () => {
        expect(listDrift([cost(9.75, OPUS_TOKENS)])).toBeUndefined();
        expect(listDrift([cost(9.7, OPUS_TOKENS)])).toBeUndefined();
        const drift = listDrift([cost(19.5, OPUS_TOKENS)]);
        expect(drift).toEqual({
            computedUsd: 9.75,
            recordedUsd: 19.5,
            ratio: 0.5,
        });
    });

    it("compares only the agents the list table prices in full", () => {
        expect(listDrift([])).toBeUndefined();
        expect(listDrift([cost(5)])).toBeUndefined();
        const gemini = {...OPUS_TOKENS, model: "gemini-3.8-flash"};
        expect(listDrift([cost(5, gemini)])).toBeUndefined();
        // Gemini is skipped, opus is in tolerance.
        expect(
            listDrift([cost(5, gemini), cost(9.75, OPUS_TOKENS)]),
        ).toBeUndefined();
    });
});

describe("usageOfResponse", () => {
    it("reads the Messages API usage block and the resolved model", () => {
        expect(
            usageOfResponse(
                {
                    model: "claude-haiku-4-5-20251001",
                    usage: {
                        input_tokens: 120,
                        output_tokens: 30,
                        cache_read_input_tokens: 400,
                        cache_creation_input_tokens: 0,
                    },
                },
                "claude-haiku-4-5",
            ),
        ).toEqual({
            model: "claude-haiku-4-5-20251001",
            input: 120,
            output: 30,
            cacheRead: 400,
            cacheWrite: 0,
        });
        expect(usageOfResponse({}, "claude-haiku-4-5")).toEqual({
            model: "claude-haiku-4-5",
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        });
    });
});
