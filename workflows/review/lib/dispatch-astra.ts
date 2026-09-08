/** Astra's eval catalog entry, until the pinned pi-ai catalog includes it. */
import type {Model} from "@earendil-works/pi-ai";

/**
 * Standard API pricing, including cache writes and the full-request tier
 * above 272K input tokens. pi-ai 0.84.4 already meters both features.
 * Source: https://developers.openai.com/api/docs/models/gpt-6-astra
 */
export const ASTRA_MODEL: Model<"openai-responses"> = {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [
            {
                inputTokensAbove: 272_000,
                input: 20,
                output: 75,
                cacheRead: 2,
                cacheWrite: 25,
            },
        ],
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
    },
    compat: {
        supportsStrictMode: true,
        // Astra uses prompt_cache_options.ttl, not prompt_cache_retention.
        // Disable pi-ai's old 24h field even if PI_CACHE_RETENTION=long.
        supportsLongCacheRetention: false,
    },
    samplingParams: {
        prompt_cache_options: {ttl: "30m"},
        service_tier: "default",
    },
};

/** Prefer a future pi-ai catalog entry over this local definition. */
export const withAstra = <T extends {id: string}>(
    catalog: readonly T[],
): readonly (T | Model<"openai-responses">)[] =>
    catalog.some((model) => model.id === ASTRA_MODEL.id)
        ? catalog
        : [...catalog, ASTRA_MODEL];
