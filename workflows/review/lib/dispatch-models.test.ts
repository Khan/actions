import {describe, it, expect} from "vitest";

import {
    GEMINI_38_FLASH_MODEL,
    providerForPin,
    rebaseModels,
    resolveModelId,
    thinkingLevelForModel,
    withGemini38Flash,
} from "./dispatch-models";

/**
 * The pin-routing layer on its own: pin-to-provider mapping, pin-to-id
 * resolution (exact, dated, never tier-jumping), the api-proxy rebase, and
 * the gemini-3.8-flash catalog shim. The runners' tests
 * (dispatch-runner-pi.test.ts, judge-prose-runner.test.ts) cover how these
 * are wired into live registrations.
 */

describe("resolveModelId", () => {
    it("takes an exact catalog match", () => {
        expect(
            resolveModelId("claude-opus-4-8", [
                {id: "claude-opus-4-8"},
                {id: "claude-opus-4-8-20260101"},
            ]),
        ).toBe("claude-opus-4-8");
    });

    it("falls back to the pin's latest dated release when not exact", () => {
        expect(
            resolveModelId("claude-opus-4-8", [
                {id: "claude-opus-4-8-20251201"},
                {id: "claude-opus-4-8-20260101"},
            ]),
        ).toBe("claude-opus-4-8-20260101");
    });

    it("never jumps tiers on a family-prefix pin", () => {
        // A bare startsWith fallback resolved claude-sonnet-4 to the LONGER
        // claude-sonnet-4-5 id, silently running a different model tier than
        // the pin claims.
        expect(
            resolveModelId("claude-sonnet-4", [
                {id: "claude-sonnet-4-20250514"},
                {id: "claude-sonnet-4-5-20250929"},
            ]),
        ).toBe("claude-sonnet-4-20250514");
    });

    it("throws with the candidates rather than silently running another model", () => {
        expect(() =>
            resolveModelId("claude-opus-9", [{id: "claude-fable-5"}]),
        ).toThrow(/not in Pi's anthropic catalog.*claude-fable-5/s);
        // A non-dated extension is not a release of the pin either.
        expect(() =>
            resolveModelId("claude-opus-4-8", [{id: "claude-opus-4-8-latest"}]),
        ).toThrow(/not in Pi's anthropic catalog/);
        // The message names the pin's own provider, not Anthropic always.
        expect(() =>
            resolveModelId("gemini-9-flash", [{id: "gemini-3.8-flash"}]),
        ).toThrow(/not in Pi's google catalog/);
    });
});

describe("providerForPin", () => {
    it("routes gemini pins to Google and everything else to Anthropic", () => {
        expect(providerForPin("gemini-3.8-flash")).toBe("google");
        expect(providerForPin("claude-opus-5")).toBe("anthropic");
        // The default is deliberate: an unknown family fails inside
        // resolveModelId with candidates listed, never a silent reroute.
        expect(providerForPin("unknown-model")).toBe("anthropic");
    });
});

describe("withGemini38Flash", () => {
    it("appends the local entry to a catalog that predates the model", () => {
        const extended = withGemini38Flash([{id: "gemini-3.6-flash"}]);
        expect(extended.map((model) => model.id)).toEqual([
            "gemini-3.6-flash",
            "gemini-3.8-flash",
        ]);
    });

    it("defers to a catalog that already carries the id (the shim retires itself)", () => {
        const own = {id: "gemini-3.8-flash", theirs: true};
        expect(withGemini38Flash([own])).toEqual([own]);
    });

    it("prices the entry at the launch intro rate", () => {
        // The usd metering sums per-turn cost off these numbers; a zeroed
        // or list-priced entry would systematically mis-report the A/B.
        expect(GEMINI_38_FLASH_MODEL.cost).toEqual({
            input: 0.75,
            output: 3.75,
            cacheRead: 0.075,
            cacheWrite: 0,
        });
        expect(GEMINI_38_FLASH_MODEL.api).toBe("google-generative-ai");
    });

    it("declares off AND minimal unsupported (the 3.8 API takes LOW/MEDIUM/HIGH only)", () => {
        // The 3.6-shaped {off: null} map let pi-ai's clamp offer minimal,
        // which the 3.8 API 400s on.
        expect(GEMINI_38_FLASH_MODEL.thinkingLevelMap).toEqual({
            off: null,
            minimal: null,
        });
    });
});

describe("thinkingLevelForModel", () => {
    it("gives Google models high and everything else nothing", () => {
        expect(
            thinkingLevelForModel({
                id: "gemini-3.8-flash",
                api: "google-generative-ai",
            }),
        ).toBe("high");
        expect(
            thinkingLevelForModel({
                id: "claude-opus-4-8",
                api: "anthropic-messages",
            }),
        ).toBeUndefined();
        expect(thinkingLevelForModel({id: "bare"})).toBeUndefined();
    });
});

describe("rebaseModels", () => {
    it("rewrites every catalog model's own baseUrl (the field the API layer reads)", () => {
        const provider = {
            id: "anthropic",
            baseUrl: "https://api.anthropic.com",
            getModels: () => [
                {id: "a", baseUrl: "https://api.anthropic.com"},
                {id: "b", baseUrl: "https://api.anthropic.com"},
            ],
        };
        const steered = rebaseModels(provider, "http://api-proxy:10001");
        expect(steered.id).toBe("anthropic");
        expect(steered.getModels()).toEqual([
            {id: "a", baseUrl: "http://api-proxy:10001"},
            {id: "b", baseUrl: "http://api-proxy:10001"},
        ]);
        // The source provider is untouched.
        expect(provider.getModels()[0].baseUrl).toBe(
            "https://api.anthropic.com",
        );
    });
});
