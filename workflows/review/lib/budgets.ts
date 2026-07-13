/**
 * The default run-budget table and its calibration record, split out of
 * `router.ts` (which sits against the max-lines lint limit). Everything here
 * is re-exported from `./router.ts`, the routing vocabulary's single entry
 * point; import from there.
 */

import type {RunBudget} from "./router";
import type {RiskTier} from "./routing-config";

/**
 * Default budget table, sized inside the workflow's assumed 20-minute / $10
 * per-run ceiling. Every field scales monotonically with the tier; the table
 * is exported so the eval suite and consumers can override it.
 *
 * Calibration (re-measured 2026-07-10 against production runs on Khan/actions
 * #232/#238): a run spends ~3 minutes of fixed overhead (staging, router,
 * provenance, pattern-triage) before the first reviewer returns, so wall
 * clocks below ~6 minutes hit the shed threshold before review work lands;
 * and the standard enabled roster is seven whole-change reviewers (two
 * defaults plus the five opt-ins both current consumers enable), so an
 * invocation cap of 4 deterministically shed dimensions on every low run. Low and medium now fit the roster;
 * trivial stays deliberately small (the two default reviewers; the rest are
 * declared budget sheds). The low cap of 8 lets a lens-free low-tier run
 * dispatch the full roster; path-matched lenses also consume slots, so a low
 * PR matching two or more lenses still sheds from the bottom of the value
 * ranking (that residual is sized when the modes are priced, not here).
 * `maxUsd` is deliberately left uncalibrated (per-run cost measurement is
 * deferred to #249): the dollar column is the original estimate.
 */
export const DEFAULT_TIER_BUDGETS: Record<RiskTier, RunBudget> = {
    trivial: {
        tier: "trivial",
        floored: false,
        maxReviewerInvocations: 2,
        maxToolCallsPerFinding: 2,
        maxTotalToolCalls: 10,
        maxWallClockMinutes: 6,
        maxUsd: 0.5,
    },
    low: {
        tier: "low",
        floored: false,
        maxReviewerInvocations: 8,
        maxToolCallsPerFinding: 3,
        maxTotalToolCalls: 20,
        maxWallClockMinutes: 10,
        maxUsd: 1.5,
    },
    medium: {
        tier: "medium",
        floored: false,
        maxReviewerInvocations: 10,
        maxToolCallsPerFinding: 5,
        maxTotalToolCalls: 60,
        maxWallClockMinutes: 15,
        maxUsd: 4,
    },
    high: {
        tier: "high",
        floored: false,
        maxReviewerInvocations: 12,
        maxToolCallsPerFinding: 8,
        maxTotalToolCalls: 120,
        maxWallClockMinutes: 20,
        maxUsd: 10,
    },
};

/**
 * Tier a misrouted PR (source files touched, but no specialist lens matched) is
 * floored to. A misrouted PR still gets a real review from the always-on
 * reviewers, so it must not fall to the trivial budget just because no path
 * pattern claimed it. "low" is the documented default floor.
 */
export const DEFAULT_MISROUTED_FLOOR_TIER: RiskTier = "low";
