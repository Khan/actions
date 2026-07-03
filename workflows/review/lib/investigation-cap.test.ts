import {describe, it, expect} from "vitest";

import {computeRunBudget, type RouterConfig} from "./router.ts";
import {
    capsFromRunBudget,
    decideToolCall,
    DEFAULT_TOOL_CALL_CAPS,
    InvestigationCap,
    REFUSAL_REASONS,
    type CapDecision,
    type ToolCallCaps,
} from "./investigation-cap.ts";

/**
 * Tests for the R9 per-finding investigation tool-call cap (TASK-5-3).
 *
 * The cap is the deterministic guard that keeps reviewer investigation bounded:
 * it counts the tool calls a single finding spends and refuses the call that
 * would exceed either the per-finding cap or the run-wide pool. The AC is "cap
 * enforced; over-cap calls refused deterministically", so these tests pin:
 *   - the pure `decideToolCall` verdict (precedence, clamping, normalisation);
 *   - the stateful `InvestigationCap` accounting (per-finding independence, the
 *     shared run-total pool, no state mutation on a refusal);
 *   - determinism (same inputs / same request sequence => identical verdicts);
 *   - the R8 determinism boundary (every refusal is a fixed code, never prose);
 *   - the budget wiring (`capsFromRunBudget` / `fromRunBudget` read the numbers
 *     from the slice-3 `RunBudget` — single source of truth).
 *
 * The module is pure TypeScript with no I/O, so every assertion is over an
 * in-memory fixture.
 */

// Small, explicit caps so the boundaries are obvious in each assertion.
const caps: ToolCallCaps = {maxToolCallsPerFinding: 3, maxTotalToolCalls: 5};

// Narrowing helpers: assert the discriminant and return the narrowed branch so
// the union member's fields are type-safe to read.
const expectAllowed = (
    decision: CapDecision,
): Extract<CapDecision, {allowed: true}> => {
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
        throw new Error(`expected allowed, got refusal: ${decision.reason}`);
    }
    return decision;
};

const expectRefused = (
    decision: CapDecision,
): Extract<CapDecision, {allowed: false}> => {
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
        throw new Error("expected refusal, got allowed");
    }
    return decision;
};

/* -------------------------------------------------------------------------- */
/* decideToolCall: the pure verdict                                           */
/* -------------------------------------------------------------------------- */

describe("decideToolCall", () => {
    it("allows a call when under both caps and reports the pre-call headroom", () => {
        const decision = expectAllowed(decideToolCall(1, 2, caps));
        // remaining is measured BEFORE this call would be counted.
        expect(decision.remainingForFinding).toBe(2); // 3 - 1
        expect(decision.remainingForRun).toBe(3); // 5 - 2
    });

    it("allows the call at exactly one-below the per-finding cap", () => {
        const decision = expectAllowed(decideToolCall(2, 0, caps));
        expect(decision.remainingForFinding).toBe(1);
    });

    it("refuses when the finding has already spent its per-finding cap", () => {
        const decision = expectRefused(decideToolCall(3, 0, caps));
        expect(decision.reason).toBe("per-finding-cap-exceeded");
        expect(decision.remainingForFinding).toBe(0);
        expect(decision.remainingForRun).toBe(5);
    });

    it("refuses on the run-total pool even when the finding is under its own cap", () => {
        const decision = expectRefused(decideToolCall(0, 5, caps));
        expect(decision.reason).toBe("run-total-cap-exceeded");
        expect(decision.remainingForFinding).toBe(3);
        expect(decision.remainingForRun).toBe(0);
    });

    it("reports the per-finding cap first when both limits are hit (more specific)", () => {
        const decision = expectRefused(decideToolCall(3, 5, caps));
        expect(decision.reason).toBe("per-finding-cap-exceeded");
    });

    it("clamps both headroom values at 0 when counts overshoot the caps", () => {
        const decision = expectRefused(decideToolCall(9, 9, caps));
        expect(decision.remainingForFinding).toBe(0);
        expect(decision.remainingForRun).toBe(0);
    });

    it("emits only fixed refusal codes, never prose about the code under review", () => {
        const refusals = [
            decideToolCall(3, 0, caps),
            decideToolCall(0, 5, caps),
            decideToolCall(3, 5, caps),
        ].map((d) => expectRefused(d).reason);
        for (const reason of refusals) {
            expect(REFUSAL_REASONS).toContain(reason);
        }
    });

    it("is a pure function: identical inputs yield an identical verdict", () => {
        expect(decideToolCall(1, 2, caps)).toEqual(decideToolCall(1, 2, caps));
        expect(decideToolCall(3, 5, caps)).toEqual(decideToolCall(3, 5, caps));
    });

    describe("cap normalisation (malformed budgets degrade to a refusal)", () => {
        it("floors a fractional cap to the integer at or below it", () => {
            // 2.9 -> 2: the third call (usedForFinding 2) is refused.
            const fractional: ToolCallCaps = {
                maxToolCallsPerFinding: 2.9,
                maxTotalToolCalls: 10.9,
            };
            expectAllowed(decideToolCall(1, 0, fractional));
            const refused = expectRefused(decideToolCall(2, 0, fractional));
            expect(refused.reason).toBe("per-finding-cap-exceeded");
        });

        it("treats a non-positive or non-finite cap as 0, refusing the first call", () => {
            const badValues = [-1, 0, Number.NaN, Number.POSITIVE_INFINITY];
            for (const value of badValues) {
                const bad: ToolCallCaps = {
                    maxToolCallsPerFinding: value,
                    maxTotalToolCalls: 20,
                };
                const decision = expectRefused(decideToolCall(0, 0, bad));
                expect(decision.reason).toBe("per-finding-cap-exceeded");
            }
        });
    });
});

/* -------------------------------------------------------------------------- */
/* Defaults and budget wiring                                                 */
/* -------------------------------------------------------------------------- */

describe("DEFAULT_TOOL_CALL_CAPS", () => {
    it("documents the assumed default cap (router 'low' tier / misrouted floor)", () => {
        expect(DEFAULT_TOOL_CALL_CAPS).toEqual({
            maxToolCallsPerFinding: 3,
            maxTotalToolCalls: 20,
        });
    });
});

describe("capsFromRunBudget", () => {
    // Build a real RunBudget via the production path rather than a hand literal.
    const config: RouterConfig = {generatedPatterns: []};

    it("projects exactly the two cap fields out of a full RunBudget", () => {
        const budget = computeRunBudget("medium", false, config);
        expect(capsFromRunBudget(budget)).toEqual({
            maxToolCallsPerFinding: budget.maxToolCallsPerFinding,
            maxTotalToolCalls: budget.maxTotalToolCalls,
        });
    });

    it("scales with risk tier: a higher tier grants at least as much headroom", () => {
        const low = capsFromRunBudget(computeRunBudget("low", false, config));
        const high = capsFromRunBudget(computeRunBudget("high", false, config));
        expect(high.maxToolCallsPerFinding).toBeGreaterThanOrEqual(
            low.maxToolCallsPerFinding,
        );
        expect(high.maxTotalToolCalls).toBeGreaterThanOrEqual(
            low.maxTotalToolCalls,
        );
    });
});

/* -------------------------------------------------------------------------- */
/* InvestigationCap: the stateful guard                                       */
/* -------------------------------------------------------------------------- */

describe("InvestigationCap", () => {
    it("defaults to DEFAULT_TOOL_CALL_CAPS when constructed without caps", () => {
        const guard = new InvestigationCap();
        expect(guard.getCaps()).toEqual(DEFAULT_TOOL_CALL_CAPS);
    });

    it("allows calls up to the per-finding cap, then refuses the next one", () => {
        const guard = new InvestigationCap(caps);
        for (let i = 0; i < 3; i++) {
            expectAllowed(guard.request("f1"));
        }
        expect(guard.usedForFinding("f1")).toBe(3);

        const refused = expectRefused(guard.request("f1"));
        expect(refused.reason).toBe("per-finding-cap-exceeded");
    });

    it("does not mutate any accounting when a call is refused", () => {
        const guard = new InvestigationCap(caps);
        guard.request("f1");
        guard.request("f1");
        guard.request("f1"); // f1 now at its cap of 3
        const before = guard.snapshot();

        expectRefused(guard.request("f1"));

        const after = guard.snapshot();
        expect(after).toEqual(before);
        expect(guard.usedForFinding("f1")).toBe(3);
        expect(guard.getUsedTotal()).toBe(3);
    });

    it("counts findings independently: one finding at its cap does not block another", () => {
        const guard = new InvestigationCap(caps);
        guard.request("f1");
        guard.request("f1");
        guard.request("f1");
        expectRefused(guard.request("f1")); // f1 exhausted

        // f2 is untouched and still has its full per-finding cap.
        expect(guard.usedForFinding("f2")).toBe(0);
        const allowed = expectAllowed(guard.request("f2"));
        expect(allowed.remainingForFinding).toBe(3);
        expect(guard.usedForFinding("f2")).toBe(1);
    });

    it("enforces the shared run-total pool across findings under their own caps", () => {
        // maxTotalToolCalls = 5; spread across findings so none hits its own cap.
        const guard = new InvestigationCap(caps);
        expectAllowed(guard.request("a"));
        expectAllowed(guard.request("b"));
        expectAllowed(guard.request("c"));
        expectAllowed(guard.request("d"));
        expectAllowed(guard.request("e")); // 5th call -> run total now 5

        // Every finding is under its per-finding cap (each spent 1), but the
        // run-wide pool is exhausted.
        const refused = expectRefused(guard.request("f"));
        expect(refused.reason).toBe("run-total-cap-exceeded");
        expect(guard.getUsedTotal()).toBe(5);
    });

    it("reports per-finding-cap-exceeded first when a finding is at both limits", () => {
        // Per-finding cap 2, run total 2: two calls on one finding hit both.
        const guard = new InvestigationCap({
            maxToolCallsPerFinding: 2,
            maxTotalToolCalls: 2,
        });
        guard.request("f1");
        guard.request("f1");
        const refused = expectRefused(guard.request("f1"));
        expect(refused.reason).toBe("per-finding-cap-exceeded");
    });

    it("check() previews headroom without consuming; request() consumes", () => {
        const guard = new InvestigationCap(caps);

        const preview = expectAllowed(guard.check("f1"));
        expect(preview.remainingForFinding).toBe(3);
        expect(guard.usedForFinding("f1")).toBe(0); // check did not mutate
        expect(guard.getUsedTotal()).toBe(0);

        expectAllowed(guard.request("f1"));
        expect(guard.usedForFinding("f1")).toBe(1); // request did mutate
        expect(guard.getUsedTotal()).toBe(1);
    });

    it("builds a guard from a RunBudget whose caps match that budget", () => {
        const budget = computeRunBudget("high", false, {generatedPatterns: []});
        const guard = InvestigationCap.fromRunBudget(budget);
        expect(guard.getCaps()).toEqual(capsFromRunBudget(budget));
    });

    it("normalises malformed caps at construction (negative per-finding => refuse first call)", () => {
        const guard = new InvestigationCap({
            maxToolCallsPerFinding: -1,
            maxTotalToolCalls: 20,
        });
        expect(guard.getCaps().maxToolCallsPerFinding).toBe(0);
        const refused = expectRefused(guard.request("f1"));
        expect(refused.reason).toBe("per-finding-cap-exceeded");
        expect(guard.getUsedTotal()).toBe(0);
    });

    it("is deterministic: the same request sequence yields identical verdicts", () => {
        const sequence = ["f1", "f1", "f2", "f1", "f1", "f2", "f2", "f3"];
        const run = () => {
            const guard = new InvestigationCap(caps);
            return sequence.map((id) => guard.request(id));
        };
        expect(run()).toEqual(run());
    });

    describe("snapshot()", () => {
        it("reports caps, run total, and per-finding counts in insertion order", () => {
            const guard = new InvestigationCap(caps);
            guard.request("alpha");
            guard.request("beta");
            guard.request("alpha");

            const snap = guard.snapshot();
            expect(snap.caps).toEqual(caps);
            expect(snap.usedTotal).toBe(3);
            expect(snap.perFinding).toEqual({alpha: 2, beta: 1});
            expect(Object.keys(snap.perFinding)).toEqual(["alpha", "beta"]);
        });

        it("returns copies: mutating a snapshot or getCaps() cannot corrupt the guard", () => {
            const guard = new InvestigationCap(caps);
            guard.request("f1");

            const snap = guard.snapshot();
            snap.usedTotal = 999;
            snap.perFinding.f1 = 999;
            snap.caps.maxToolCallsPerFinding = 999;

            const returnedCaps = guard.getCaps();
            returnedCaps.maxTotalToolCalls = 999;

            const fresh = guard.snapshot();
            expect(fresh.usedTotal).toBe(1);
            expect(fresh.perFinding).toEqual({f1: 1});
            expect(fresh.caps).toEqual(caps);
        });
    });
});
