/**
 * R9: the per-finding investigation tool-call cap, enforced in code.
 *
 * Slice 5 gives reviewer sub-agents bounded investigation (grep callers, trace
 * call chains, run one targeted cheap check per finding — the instructions live
 * in `review.md`, task-5-1). This module is the deterministic guard that keeps
 * that investigation *bounded*: it counts the tool calls a single finding spends
 * and refuses the call that would exceed the cap, so a runaway lens cannot burn
 * the whole run's budget chasing one finding.
 *
 * The cap "lives inside the run budget from slice 3" (plan §slice-5): the numbers
 * are not configured here but read from the {@link RunBudget} the router already
 * computes — `maxToolCallsPerFinding` (the per-finding cap) and `maxTotalToolCalls`
 * (the run-wide ceiling the per-finding calls also draw down). This module owns
 * only the *accounting and the refusal decision*, not the numbers, so there is a
 * single source of truth for budget and it scales with risk tier automatically.
 *
 * Determinism boundary (plan §8.6/§8.7, the R8 tripwire): every decision here is
 * a pure function of the counts and the caps, and every string it emits is a
 * fixed code (a {@link RefusalReason}), never a sentence about the code under
 * review. Prose stays with the lens sub-agents.
 */

import type {RunBudget} from "./router";

/* -------------------------------------------------------------------------- */
/* Caps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The two ceilings the guard enforces. Both are drawn from the run budget:
 *   - `maxToolCallsPerFinding`: the R9 cap — the most investigation tool calls a
 *     single finding may spend.
 *   - `maxTotalToolCalls`: the run-wide ceiling from slice 3. Per-finding calls
 *     draw down this shared pool, so a review with many findings cannot exceed
 *     the run budget even when no single finding hits its own cap.
 */
export type ToolCallCaps = {
    maxToolCallsPerFinding: number;
    maxTotalToolCalls: number;
};

/**
 * The assumed default caps, documented per task-5-2 (operator: implementer
 * judgement, tunable later, NOT a HITL surface). These mirror the router's "low"
 * tier defaults ({@link DEFAULT_TIER_BUDGETS.low} — also the misrouted floor), so
 * a guard constructed without a run budget behaves like the default-tier run.
 * Real runs pass {@link capsFromRunBudget} and never fall back to these.
 */
export const DEFAULT_TOOL_CALL_CAPS: ToolCallCaps = {
    maxToolCallsPerFinding: 3,
    maxTotalToolCalls: 20,
};

/** Project the two cap fields out of a full {@link RunBudget}. */
export const capsFromRunBudget = (budget: RunBudget): ToolCallCaps => ({
    maxToolCallsPerFinding: budget.maxToolCallsPerFinding,
    maxTotalToolCalls: budget.maxTotalToolCalls,
});

/**
 * Coerce caps to non-negative integers so a malformed budget degrades to a
 * deterministic refusal rather than an inconsistent count. A non-finite, NaN, or
 * negative value floors to 0 (every call refused); a fractional value floors to
 * the integer at or below it. Pure.
 */
const normalizeCap = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const normalizeCaps = (caps: ToolCallCaps): ToolCallCaps => ({
    maxToolCallsPerFinding: normalizeCap(caps.maxToolCallsPerFinding),
    maxTotalToolCalls: normalizeCap(caps.maxTotalToolCalls),
});

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a tool call was refused. Fixed codes, not prose:
 *   - `per-finding-cap-exceeded`: this finding has already spent its cap.
 *   - `run-total-cap-exceeded`: the run-wide pool is exhausted (this finding may
 *     still be under its own cap).
 * The per-finding cap is evaluated first, so a finding at both limits reports
 * `per-finding-cap-exceeded` (the more specific, actionable reason).
 */
export const REFUSAL_REASONS = [
    "per-finding-cap-exceeded",
    "run-total-cap-exceeded",
] as const;

export type RefusalReason = typeof REFUSAL_REASONS[number];

/**
 * The outcome of a cap check. `remainingForFinding` / `remainingForRun` are the
 * headroom *before* the requested call is (or would be) counted, clamped at 0,
 * so callers can surface budget pressure regardless of the verdict.
 */
export type CapDecision =
    | {
          allowed: true;
          remainingForFinding: number;
          remainingForRun: number;
      }
    | {
          allowed: false;
          reason: RefusalReason;
          remainingForFinding: number;
          remainingForRun: number;
      };

/**
 * Pure decision: given how many calls a finding has already spent, the run total
 * so far, and the caps, decide whether one more call is allowed. Does not mutate
 * anything — {@link InvestigationCap.request} calls this and then records the
 * consumption. Exported so the verdict can be reproduced in a test without a
 * stateful instance.
 */
export const decideToolCall = (
    usedForFinding: number,
    usedTotal: number,
    caps: ToolCallCaps,
): CapDecision => {
    const {maxToolCallsPerFinding, maxTotalToolCalls} = normalizeCaps(caps);

    const remainingForFinding = Math.max(
        0,
        maxToolCallsPerFinding - usedForFinding,
    );
    const remainingForRun = Math.max(0, maxTotalToolCalls - usedTotal);

    if (usedForFinding >= maxToolCallsPerFinding) {
        return {
            allowed: false,
            reason: "per-finding-cap-exceeded",
            remainingForFinding,
            remainingForRun,
        };
    }

    if (usedTotal >= maxTotalToolCalls) {
        return {
            allowed: false,
            reason: "run-total-cap-exceeded",
            remainingForFinding,
            remainingForRun,
        };
    }

    return {allowed: true, remainingForFinding, remainingForRun};
};

/* -------------------------------------------------------------------------- */
/* Stateful guard                                                             */
/* -------------------------------------------------------------------------- */

/** A read-only snapshot of the guard's accounting (for logging / R15 counters). */
export type CapUsageSnapshot = {
    caps: ToolCallCaps;
    usedTotal: number;
    /** Calls spent per finding id, in insertion order. */
    perFinding: Record<string, number>;
};

/**
 * The stateful enforcement point for one review run. Construct one per run
 * (typically via {@link InvestigationCap.fromRunBudget}); route every prospective
 * investigation tool call through {@link request}. A finding is identified by its
 * schema `id` (see `finding-schema.ts`); calls for distinct findings are counted
 * independently but all draw down the shared run-total pool.
 *
 * The guard never *performs* a tool call — it only authorises one. Callers that
 * receive `allowed: false` must not run the call; that is what "refused
 * deterministically" (the task-5-2 AC) means at this layer.
 */
export class InvestigationCap {
    private readonly caps: ToolCallCaps;
    private readonly perFinding = new Map<string, number>();
    private usedTotal = 0;

    constructor(caps: ToolCallCaps = DEFAULT_TOOL_CALL_CAPS) {
        // Normalise once at construction so every subsequent decision uses the
        // same coerced caps the accounting is measured against.
        this.caps = normalizeCaps(caps);
    }

    /** Build a guard from the router's run budget (the production path). */
    static fromRunBudget(budget: RunBudget): InvestigationCap {
        return new InvestigationCap(capsFromRunBudget(budget));
    }

    /** The (normalised) caps this guard enforces. */
    getCaps(): ToolCallCaps {
        return {...this.caps};
    }

    /** Calls already spent by `findingId` (0 if it has spent none). */
    usedForFinding(findingId: string): number {
        return this.perFinding.get(findingId) ?? 0;
    }

    /** Calls spent across every finding this run. */
    getUsedTotal(): number {
        return this.usedTotal;
    }

    /**
     * Non-mutating: would one more call for `findingId` be allowed right now?
     * Use this to preview headroom without consuming it; {@link request} is the
     * mutating counterpart.
     */
    check(findingId: string): CapDecision {
        return decideToolCall(
            this.usedForFinding(findingId),
            this.usedTotal,
            this.caps,
        );
    }

    /**
     * Request one investigation tool call for `findingId`. Returns the same
     * decision {@link check} would, and — only when allowed — records the
     * consumption (increments the finding's count and the run total). A refused
     * call changes no state, so a caller may retry after freeing budget elsewhere
     * (there is none to free mid-run, but the accounting stays consistent).
     */
    request(findingId: string): CapDecision {
        const decision = this.check(findingId);
        if (decision.allowed) {
            this.perFinding.set(findingId, this.usedForFinding(findingId) + 1);
            this.usedTotal += 1;
        }
        return decision;
    }

    /** An immutable snapshot of current accounting. */
    snapshot(): CapUsageSnapshot {
        return {
            caps: {...this.caps},
            usedTotal: this.usedTotal,
            perFinding: Object.fromEntries(this.perFinding),
        };
    }
}
