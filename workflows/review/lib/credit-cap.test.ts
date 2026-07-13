import {describe, it, expect} from "vitest";

import {
    clampBudgetToCreditCap,
    DEFAULT_MAX_AI_CREDITS,
    resolveCreditCap,
} from "./credit-cap";

import {
    computeRunBudget,
    DEFAULT_TIER_BUDGETS,
    type RouterConfig,
} from "./router.ts";

/**
 * Credit-cap resolution and budget clamping (split out of router.test.ts,
 * which sits against the max-lines lint limit).
 */

/** The smallest router config the clamp path needs; the tier is explicit. */
const minimalConfig: RouterConfig = {generatedPatterns: []};

/** In-memory fs seam, mirroring router.test.ts's helper. */
const fakeFs = (inputs: Record<string, string>) => {
    const written: Record<string, string> = {};
    const mkdirCalls: string[] = [];
    const fs = {
        readFileSync: (p: string, _enc: "utf8"): string => {
            const content = inputs[p];
            if (content === undefined) {
                throw new Error(`unexpected read: ${p}`);
            }
            return content;
        },
        writeFileSync: (p: string, data: string): void => {
            written[p] = data;
        },
        existsSync: (p: string): boolean => p in inputs,
        mkdirSync: (p: string, _opts: {recursive: boolean}): void => {
            mkdirCalls.push(p);
        },
    };
    return {fs, written, mkdirCalls};
};

describe("clampBudgetToCreditCap", () => {
    it("records but does not clamp a cap that covers the tier budget", () => {
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 2500);
        expect(clamped).toEqual({
            ...DEFAULT_TIER_BUDGETS.high,
            effectiveCreditCap: 2500,
        });
        expect(clamped.capClamped).toBeUndefined();
    });

    it("scales every soft target to the reserve-adjusted cap, not the cap", () => {
        // The budget-shed incident shape: the high tier ($10) planned inside a
        // 400-credit ($4) cap, so the run died at the api-proxy mid-validation.
        // The soft dollar target is 75% of the cap (the landing target; the
        // remaining quarter is the landing reserve): the acceptance re-run
        // showed a soft target equal to the hard cap still dies at it
        // (416/400), because spend is unobservable mid-run and in-flight
        // work bills after the last observable checkpoint.
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 400);
        expect(clamped).toEqual({
            ...DEFAULT_TIER_BUDGETS.high,
            maxReviewerInvocations: 3, // floor(12 * 0.3)
            maxToolCallsPerFinding: 2, // floor(8 * 0.3)
            maxTotalToolCalls: 36, // floor(120 * 0.3)
            maxWallClockMinutes: 6, // floor(20 * 0.3)
            maxUsd: 3, // 4 * 0.75
            effectiveCreditCap: 400,
            capClamped: true,
        });
    });

    it("leaves a tier alone only when its target clears the reserve", () => {
        // $10 tier under a 1400-credit ($14) cap: 75% of the cap is $10.50,
        // above the tier's own $10 target, so nothing needs resizing.
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 1400);
        expect(clamped).toEqual({
            ...DEFAULT_TIER_BUDGETS.high,
            effectiveCreditCap: 1400,
        });
        // $10 tier under a 1200-credit ($12) cap: the reserve-adjusted target
        // ($9) is below the tier's $10, so the clamp engages.
        const tight = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 1200);
        expect(tight.capClamped).toBe(true);
        expect(tight.maxUsd).toBe(9);
    });

    it("never drops below the trivial tier's floors", () => {
        const floor = DEFAULT_TIER_BUDGETS.trivial;
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 10);
        expect(clamped.maxReviewerInvocations).toBe(
            floor.maxReviewerInvocations,
        );
        expect(clamped.maxToolCallsPerFinding).toBe(
            floor.maxToolCallsPerFinding,
        );
        expect(clamped.maxTotalToolCalls).toBe(floor.maxTotalToolCalls);
        expect(clamped.maxWallClockMinutes).toBe(floor.maxWallClockMinutes);
        // The dollar target has no floor: a floor above the cap would defeat
        // the cap. 75% of the $0.10 cap, within float precision.
        expect(clamped.maxUsd).toBeCloseTo(0.075, 10);
        expect(clamped.capClamped).toBe(true);
    });

    it("treats a zero or negative cap as explicitly uncapped", () => {
        expect(clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, -1)).toEqual(
            DEFAULT_TIER_BUDGETS.high,
        );
        expect(clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 0)).toEqual(
            DEFAULT_TIER_BUDGETS.high,
        );
    });

    it("returns the budget unchanged for a non-finite cap", () => {
        expect(
            clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, Infinity),
        ).toEqual(DEFAULT_TIER_BUDGETS.high);
        expect(clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, NaN)).toEqual(
            DEFAULT_TIER_BUDGETS.high,
        );
    });

    it("applies through computeRunBudget via config.maxAiCredits", () => {
        const budget = computeRunBudget("high", false, {
            ...minimalConfig,
            maxAiCredits: 400,
        });
        expect(budget.tier).toBe("high");
        expect(budget.capClamped).toBe(true);
        expect(budget.maxUsd).toBe(3);
    });
});

describe("resolveCreditCap", () => {
    const noFs = {
        existsSync: (): boolean => false,
        readFileSync: (): string => {
            throw new Error("unexpected read");
        },
    };

    it("prefers the REVIEW_MAX_AI_CREDITS frontmatter mirror", () => {
        expect(
            resolveCreditCap(
                {REVIEW_MAX_AI_CREDITS: "2500", GH_AW_MAX_AI_CREDITS: "400"},
                noFs,
            ),
        ).toBe(2500);
    });

    it("falls back to GH_AW_MAX_AI_CREDITS", () => {
        expect(resolveCreditCap({GH_AW_MAX_AI_CREDITS: "400"}, noFs)).toBe(400);
    });

    it("ignores non-numeric and empty env values and keeps looking", () => {
        expect(
            resolveCreditCap(
                {REVIEW_MAX_AI_CREDITS: "lots", GH_AW_MAX_AI_CREDITS: ""},
                noFs,
            ),
        ).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("ignores a non-finite env cap rather than returning it", () => {
        // "Infinity" parses to a number, but a non-finite cap is useless to
        // the clamp; treat it like any other unusable value and keep looking.
        expect(
            resolveCreditCap({REVIEW_MAX_AI_CREDITS: "Infinity"}, noFs),
        ).toBe(DEFAULT_MAX_AI_CREDITS);
        expect(
            resolveCreditCap({GH_AW_MAX_AI_CREDITS: "-Infinity"}, noFs),
        ).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("reads apiProxy.maxAiCredits from a visible awf config", () => {
        const {fs} = fakeFs({
            "/tmp/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: 400},
            }),
        });
        expect(resolveCreditCap({}, fs)).toBe(400);
    });

    it("prefers the RUNNER_TEMP awf config over the /tmp fallback", () => {
        const {fs} = fakeFs({
            "/rt/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: 250},
            }),
            "/tmp/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: 400},
            }),
        });
        expect(resolveCreditCap({RUNNER_TEMP: "/rt"}, fs)).toBe(250);
    });

    it("falls through an awf config that omits maxAiCredits", () => {
        const {fs} = fakeFs({
            "/tmp/gh-aw/awf-config.json": JSON.stringify({apiProxy: {}}),
        });
        expect(resolveCreditCap({}, fs)).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("falls through a non-numeric awf maxAiCredits", () => {
        const {fs} = fakeFs({
            "/tmp/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: "400"},
            }),
        });
        expect(resolveCreditCap({}, fs)).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("survives an unparseable awf config and falls through", () => {
        const {fs} = fakeFs({
            "/tmp/gh-aw/awf-config.json": "not json",
        });
        expect(resolveCreditCap({}, fs)).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("defaults to gh-aw's baked-in cap when nothing is discoverable", () => {
        expect(resolveCreditCap({}, noFs)).toBe(DEFAULT_MAX_AI_CREDITS);
    });
});
