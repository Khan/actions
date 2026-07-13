/**
 * The effective per-run AI-credit cap: discovery from the environment and the
 * clamp that resizes a tier budget to fit inside it. Split from `router.ts`
 * by concern (and its max-lines budget); the router imports both functions
 * and remains the single CLI entry point.
 */

import type {RunBudget} from "./router";
import {DEFAULT_TIER_BUDGETS} from "./router";

/** The read-only slice of the filesystem surface cap discovery needs. */
export type CreditCapFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
};

/**
 * gh-aw's baked-in per-run AI-credits default (credits; 1 credit = $0.01),
 * assumed when no cap is discoverable from the environment.
 */
export const DEFAULT_MAX_AI_CREDITS = 1000;

/**
 * The landing target: a clamped budget's soft targets aim at this fraction
 * of the effective cap, never the cap itself; the landing reserve is the
 * complementary quarter. Spend is unobservable mid-run (the orchestrator
 * works from proxies), and requests already in flight when a checkpoint
 * passes still bill after it, so a soft target equal to the hard cap leaves
 * no room to land: the second budget-shed acceptance run engaged the clamp
 * and still died at 416/400 credits mid-skill-audit. The reserved quarter is
 * sized to absorb both the proxy estimation error and the in-flight
 * overshoot observed there.
 */
export const LANDING_TARGET_RATIO = 0.75;

/**
 * Clamp a tier budget to the effective per-run credit cap. The tier table is
 * sized inside the workflow's assumed $10 ceiling; when a consumer sets a
 * tighter `max-ai-credits`, the un-clamped soft targets promise more work
 * than the hard cap can pay for, and the run dies at the api-proxy with
 * findings in hand instead of shedding early (observed: a 400-credit run
 * planned against the high tier's $10 targets and was killed mid-validation).
 * The clamped soft dollar target is {@link LANDING_TARGET_RATIO} of the cap,
 * not the cap itself, so a run that sheds against its targets lands inside
 * the hard ceiling. Scaling is proportional to spend, floored at the trivial
 * tier's values so even a tiny cap yields the smallest designed review rather
 * than zero work. A zero/negative cap means explicitly uncapped; undefined
 * means unknown.
 */
export const clampBudgetToCreditCap = (
    budget: RunBudget,
    capCredits: number | undefined,
): RunBudget => {
    if (
        capCredits === undefined ||
        !Number.isFinite(capCredits) ||
        capCredits <= 0
    ) {
        return budget;
    }
    const capUsd = capCredits / 100;
    const softCapUsd = capUsd * LANDING_TARGET_RATIO;
    if (softCapUsd >= budget.maxUsd) {
        // The tier's own soft target already leaves at least the reserve
        // under the hard cap; record the cap and change nothing.
        return {...budget, effectiveCreditCap: capCredits};
    }
    const ratio = softCapUsd / budget.maxUsd;
    const floor = DEFAULT_TIER_BUDGETS.trivial;
    const scale = (value: number, min: number): number =>
        Math.max(min, Math.floor(value * ratio));
    return {
        ...budget,
        maxReviewerInvocations: scale(
            budget.maxReviewerInvocations,
            floor.maxReviewerInvocations,
        ),
        maxToolCallsPerFinding: scale(
            budget.maxToolCallsPerFinding,
            floor.maxToolCallsPerFinding,
        ),
        maxTotalToolCalls: scale(
            budget.maxTotalToolCalls,
            floor.maxTotalToolCalls,
        ),
        maxWallClockMinutes: scale(
            budget.maxWallClockMinutes,
            floor.maxWallClockMinutes,
        ),
        maxUsd: softCapUsd,
        effectiveCreditCap: capCredits,
        capClamped: true,
    };
};

/**
 * Resolve the effective per-run AI-credit cap from the environment, most
 * explicit source first:
 *
 *   1. `REVIEW_MAX_AI_CREDITS` — the frontmatter `env:` mirror of
 *      `max-ai-credits` (the cap itself is enforced runner-side by the
 *      firewall api-proxy and is not otherwise exported to the agent).
 *   2. `GH_AW_MAX_AI_CREDITS` — in case a future gh-aw exports it directly.
 *   3. The awf firewall config (`apiProxy.maxAiCredits`), when its file is
 *      visible from the agent container.
 *   4. gh-aw's baked-in default ({@link DEFAULT_MAX_AI_CREDITS}).
 *
 * Returns the cap in credits; may be zero/negative when a source explicitly
 * disables the cap (the clamp treats that as uncapped).
 */
export const resolveCreditCap = (
    env: Record<string, string | undefined>,
    fs: CreditCapFs,
): number => {
    for (const name of ["REVIEW_MAX_AI_CREDITS", "GH_AW_MAX_AI_CREDITS"]) {
        const raw = env[name];
        if (raw !== undefined && raw.trim() !== "") {
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    const runnerTemp = env["RUNNER_TEMP"];
    const candidates = [
        ...(runnerTemp ? [`${runnerTemp}/gh-aw/awf-config.json`] : []),
        "/tmp/gh-aw/awf-config.json",
    ];
    for (const path of candidates) {
        if (!fs.existsSync(path)) {
            continue;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as {
                apiProxy?: {maxAiCredits?: unknown};
            };
            const cap = parsed.apiProxy?.maxAiCredits;
            if (typeof cap === "number" && Number.isFinite(cap)) {
                return cap;
            }
        } catch {
            // Unreadable or unparseable candidate: fall through to the next.
        }
    }
    return DEFAULT_MAX_AI_CREDITS;
};
