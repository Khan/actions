import {describe, expect, it} from "vitest";
import {calculateCost, createModels, type Usage} from "@earendil-works/pi-ai";
import {openaiProvider} from "@earendil-works/pi-ai/providers/openai";

import {ASTRA_MODEL, withAstra} from "./dispatch-astra";

const usage = (input: number): Usage => ({
    input,
    output: 1_000,
    cacheRead: 100_000,
    cacheWrite: 10_000,
    totalTokens: input + 111_000,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
});

describe("astra catalog and pricing", () => {
    it("adds astra without replacing a future catalog entry", () => {
        expect(withAstra([{id: "gpt-5.5"}])).toEqual([
            {id: "gpt-5.5"},
            ASTRA_MODEL,
        ]);
        const catalog = [{id: "gpt-6-astra", own: true}];
        expect(withAstra(catalog)).toBe(catalog);
    });

    it("meters standard pricing at exactly 272K total input", () => {
        const cost = calculateCost(ASTRA_MODEL, usage(162_000));
        expect(cost.input).toBeCloseTo(1.62);
        expect(cost.cacheRead).toBeCloseTo(0.1);
        expect(cost.cacheWrite).toBeCloseTo(0.125);
        expect(cost.output).toBeCloseTo(0.05);
        expect(cost.total).toBeCloseTo(1.895);
    });

    it("meters the full request at long-context rates above 272K", () => {
        const cost = calculateCost(ASTRA_MODEL, usage(162_001));
        expect(cost.input).toBeCloseTo(3.24002);
        expect(cost.cacheRead).toBeCloseTo(0.2);
        expect(cost.cacheWrite).toBeCloseTo(0.25);
        expect(cost.output).toBeCloseTo(0.075);
        expect(cost.total).toBeCloseTo(3.76502);
    });

    it("uses the actual Responses adapter with high reasoning and astra caching", async () => {
        const models = createModels();
        const provider = openaiProvider();
        models.setProvider({
            ...provider,
            getModels: () => [...withAstra(provider.getModels())],
        });
        const model = models.getModel("openai", "gpt-6-astra");
        expect(model).toBeDefined();
        let payload: Record<string, unknown> | undefined;
        let url = "";
        const result = await models.completeSimple(
            model!,
            {
                systemPrompt: "Review the diff.",
                messages: [
                    {role: "user", content: "Inspect it.", timestamp: 0},
                ],
                tools: [
                    {
                        name: "Read",
                        description: "Read a file",
                        parameters: {
                            type: "object",
                            properties: {path: {type: "string"}},
                            required: ["path"],
                        },
                    },
                ],
            },
            {
                // Test-only credential and transport. This never sends a request.
                apiKey: "test-only",
                reasoning: "high",
                cacheRetention: "long",
                onPayload: (body) => {
                    payload = body as Record<string, unknown>;
                },
                fetch: async (input) => {
                    url = String(input);
                    const event = {
                        type: "response.completed",
                        response: {
                            id: "resp_test",
                            status: "completed",
                            output: [],
                            usage: {
                                input_tokens: 272_001,
                                input_tokens_details: {
                                    cached_tokens: 100_000,
                                    cache_write_tokens: 10_000,
                                },
                                output_tokens: 1_000,
                                total_tokens: 273_001,
                            },
                        },
                    };
                    return new global.Response(
                        `data: ${JSON.stringify(event)}\n\n`,
                        {
                            headers: {"content-type": "text/event-stream"},
                        },
                    );
                },
            },
        );
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(result.stopReason).toBe("stop");
        expect(result.usage.input).toBe(162_001);
        expect(result.usage.cacheWrite).toBe(10_000);
        expect(result.usage.cost.total).toBeCloseTo(3.76502);
        expect(payload?.["model"]).toBe("gpt-6-astra");
        expect(payload?.["reasoning"]).toEqual({
            effort: "high",
            summary: "auto",
        });
        expect(payload?.["prompt_cache_options"]).toEqual({ttl: "30m"});
        expect(payload?.["prompt_cache_retention"]).toBeUndefined();
        expect(payload?.["temperature"]).toBeUndefined();
        expect(payload?.["service_tier"]).toBe("default");
        expect(payload?.["store"]).toBe(false);
        expect(payload?.["tools"]).toEqual([
            expect.objectContaining({type: "function", name: "Read"}),
        ]);
    });
});
