/**
 * The per-finding investigation tool-call cap, enforced in code.
 *
 * Reviewer sub-agents get bounded investigation (grep callers, trace
 * call chains, run one targeted cheap check per finding — the instructions live
 * in `review.md`). This module is the deterministic guard that keeps
 * that investigation *bounded*: it counts the tool calls a single finding spends
 * and refuses the call that would exceed the cap, so a runaway reviewer cannot
 * burn the whole run's budget chasing one finding.
 *
 * The cap lives inside the run budget: the numbers
 * are not configured here but read from the {@link RunBudget} the router already
 * computes — `maxToolCallsPerFinding` (the per-finding cap) and `maxTotalToolCalls`
 * (the run-wide ceiling the per-finding calls also draw down). This module owns
 * only the *accounting and the refusal decision*, not the numbers, so there is a
 * single source of truth for budget and it scales with risk tier automatically.
 *
 * How it is invoked: each finding-producing sub-agent runs the CLI at the bottom
 * of this file (`investigation-cap.ts request <finding-id>`) before every
 * investigation tool call, per its prompt in `review.md`. The CLI reads the caps
 * from the router's `routing.json` and the calls already spent from an
 * append-only journal shared by all sub-agents of the run, so the accounting is
 * run-wide even though the sub-agents are separate processes.
 *
 * Determinism boundary: every decision here is
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
 *   - `maxToolCallsPerFinding`: the most investigation tool calls a
 *     single finding may spend.
 *   - `maxTotalToolCalls`: the run-wide ceiling. Per-finding calls
 *     draw down this shared pool, so a review with many findings cannot exceed
 *     the run budget even when no single finding hits its own cap.
 */
export type ToolCallCaps = {
    maxToolCallsPerFinding: number;
    maxTotalToolCalls: number;
};

/**
 * The assumed default caps (tunable later). These mirror the router's "low"
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

/** A read-only snapshot of the guard's accounting (for logging / live counters). */
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
 * deterministically" means at this layer.
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

/* -------------------------------------------------------------------------- */
/* CLI entrypoint (sub-agents call this before each investigation tool call)  */
/* -------------------------------------------------------------------------- */

/**
 * On-disk contract. The caps come from the router's `routing.json` (falling
 * back to {@link DEFAULT_TOOL_CALL_CAPS} when routing has not run); spent calls
 * live in an append-only journal, one finding id per line, shared by every
 * sub-agent of the run. Append-then-recount keeps the accounting run-wide
 * across separate sub-agent processes; concurrent requests can overshoot a cap
 * by at most the number of in-flight sub-agents, which is acceptable for a
 * budget ceiling (the decision itself is a pure function of the observed
 * journal).
 */
const REVIEW_DIR = "/tmp/gh-aw/review";
const ROUTING_PATH = `${REVIEW_DIR}/routing.json`;
const JOURNAL_PATH = `${REVIEW_DIR}/investigation-journal.log`;

/** Count spent calls in journal content: one line = one authorised call. Pure. */
export const journalUsage = (
    content: string,
    findingId: string,
): {usedForFinding: number; usedTotal: number} => {
    let usedForFinding = 0;
    let usedTotal = 0;
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "") {
            continue;
        }
        usedTotal += 1;
        if (line === findingId) {
            usedForFinding += 1;
        }
    }
    return {usedForFinding, usedTotal};
};

type CapCliFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
    appendFileSync: (p: string, data: string) => void;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

/**
 * `investigation-cap.ts request <finding-id>`: decide whether the calling
 * sub-agent may spend one more investigation tool call on `<finding-id>`, and
 * record the consumption when allowed. Factored out (fs injected) so it is
 * testable without touching the real filesystem. Returns the decision the CLI
 * prints; the entrypoint exits non-zero when refused so a shell caller can
 * gate on the exit code alone.
 */
export const runCapCli = (argv: string[], fs: CapCliFs): CapDecision => {
    const [command, findingId] = argv;
    if (command !== "request" || findingId === undefined || findingId === "") {
        throw new Error("usage: investigation-cap.ts request <finding-id>");
    }

    const caps: ToolCallCaps = fs.existsSync(ROUTING_PATH)
        ? capsFromRunBudget(
              (
                  JSON.parse(fs.readFileSync(ROUTING_PATH, "utf8")) as {
                      runBudget: RunBudget;
                  }
              ).runBudget,
          )
        : DEFAULT_TOOL_CALL_CAPS;

    const journal = fs.existsSync(JOURNAL_PATH)
        ? fs.readFileSync(JOURNAL_PATH, "utf8")
        : "";
    const {usedForFinding, usedTotal} = journalUsage(journal, findingId);

    const decision = decideToolCall(usedForFinding, usedTotal, caps);
    if (decision.allowed) {
        fs.mkdirSync(REVIEW_DIR, {recursive: true});
        fs.appendFileSync(JOURNAL_PATH, `${findingId}\n`);
    }
    return decision;
};

// Run only when executed directly (the sub-agent prompts in review.md), never
// on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as CapCliFs;
    const decision = runCapCli(process.argv.slice(2), fs);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(decision));
    process.exit(decision.allowed ? 0 : 1);
}
