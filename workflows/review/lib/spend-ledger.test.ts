import {describe, it, expect} from "vitest";

import {
    CEILING_USD,
    LANDING_RESERVE_USD,
    createSpendLedger,
    decideSpend,
} from "./spend-ledger";

/**
 * The spend ceiling. Everything here is a property of the arithmetic and the
 * abort wiring, so it is all testable without a model: the ledger's whole job
 * is to decide at which dollar work stops and to say so out loud.
 */

const ledger = (overrides = {}) =>
    createSpendLedger({
        ceilingUsd: 10,
        landingReserveUsd: 2,
        env: {},
        warn: () => {},
        ...overrides,
    });

describe("decideSpend", () => {
    it("allows work while spend is under the dispatch budget", () => {
        // Budget is ceiling minus reserve: $8 of a $10 ceiling.
        const decision = decideSpend(7.99, 10, 2);
        expect(decision.allowed).toBe(true);
        expect(decision.crossed).toBe(false);
        // Cents, not exact binary floats: the ledger's contract is dollars.
        expect(decision.remainingUsd).toBeCloseTo(0.01, 6);
    });

    it("crosses exactly at the dispatch budget, not at the ceiling", () => {
        // The reserve is the point: at $8 the run stops STARTING work while
        // $2 remains to validate and post what it already has.
        expect(decideSpend(8, 10, 2).crossed).toBe(true);
        expect(decideSpend(8, 10, 2).allowed).toBe(false);
    });

    it("clamps remaining at zero rather than reporting negative headroom", () => {
        expect(decideSpend(12, 10, 2).remainingUsd).toBe(0);
    });

    it("treats a reserve larger than the ceiling as a zero budget", () => {
        // Misconfiguration degrades to "shed everything", not to "spend
        // everything": the ceiling is the thing being protected.
        expect(decideSpend(0, 1, 5)).toEqual({
            allowed: false,
            crossed: true,
            remainingUsd: 0,
        });
    });
});

describe("createSpendLedger", () => {
    it("keeps going while under budget and reports the spend", () => {
        const led = ledger();
        expect(led.recordSpend("correctness-reviewer", 3)).toBeUndefined();
        expect(led.recordSpend("correctness-reviewer", 2)).toBeUndefined();
        expect(led.spentUsd()).toBe(5);
        expect(led.report().crossed).toBe(false);
        expect(led.report().sheds).toEqual([]);
        expect(led.signal.aborted).toBe(false);
    });

    it("probes mid-flight spend without disturbing the accounting", () => {
        const led = ledger();
        // The probe is what an in-flight agent asks every turn. It answers
        // against settled spend plus this agent's own, and it must not record:
        // an agent that is still running has not paid yet.
        expect(led.wouldCross(7)).toBe(false);
        expect(led.wouldCross(9)).toBe(true);
        expect(led.spentUsd()).toBe(0);
        expect(led.signal.aborted).toBe(false);
        expect(led.report().sheds).toEqual([]);
    });

    it("aborts the siblings already in flight when a dispatch crosses", () => {
        const led = ledger();
        // This is the case the per-turn probe cannot cover: the agent that
        // crossed has finished, and the ones running beside it are still
        // spending. The signal is what reaches them.
        led.recordSpend("correctness-reviewer", 9);
        expect(led.signal.aborted).toBe(true);
        expect(String(led.signal.reason)).toMatch(
            /spend ceiling reached: \$9\.00 of \$10\.00.*budget \$8\.00.*reserve \$1?2?\.00/,
        );
    });

    it("refuses a new dispatch once crossed, and discloses it as a shed", () => {
        const led = ledger();
        led.recordSpend("correctness-reviewer", 9);
        expect(led.mayDispatch("data-migrations")).toBe(false);
        const report = led.report();
        // The completer is NOT shed: it ran to completion and its findings
        // are kept, so listing it as cut would contradict the record. Only
        // the refused dispatch appears.
        expect(report.sheds).toEqual([
            {agent: "data-migrations", atUsd: 9, kind: "refused"},
        ]);
    });

    it("discloses the in-flight agents the crossing actually cut", () => {
        const led = ledger();
        led.recordSpend("correctness-reviewer", 9);
        // The dispatcher reports each sibling the abort killed or the
        // per-turn probe stopped; the ledger records them as the aborted
        // sheds the disclosure names.
        led.recordAborted("security-auth");
        expect(led.report().sheds).toEqual([
            {agent: "security-auth", atUsd: 9, kind: "aborted"},
        ]);
    });

    it("records overshoot so the worst case is measurable, not estimated", () => {
        const led = ledger();
        // One expensive turn lands past the budget in a single step; the
        // ledger cannot prevent that, only measure it.
        led.recordSpend("correctness-reviewer", 11);
        expect(led.report().overshootUsd).toBe(3);
    });

    it("aborts once, then keeps accumulating spend without re-aborting", () => {
        const led = ledger();
        led.recordSpend("a", 9);
        const firstReason = led.signal.reason;
        led.recordSpend("b", 5);
        expect(led.signal.reason).toBe(firstReason);
        expect(led.report().spentUsd).toBe(14);
    });

    it("lets the landing phase spend the reserve, gated by the full ceiling", () => {
        const led = ledger(); // ceiling 10, reserve 2 (dispatch budget 8)
        led.recordSpend("correctness-reviewer", 9);
        // Crossed: the dispatch-phase signal fired and new fan-out work is
        // refused.
        expect(led.signal.aborted).toBe(true);
        expect(led.mayDispatch("data-migrations")).toBe(false);
        // Landing: the reserve funds validation. Fresh signal, gate moves to
        // the full ceiling.
        led.enterLanding();
        expect(led.signal.aborted).toBe(false);
        expect(led.mayDispatch("claim-validator")).toBe(true);
        expect(led.wouldCross(0.5)).toBe(false);
        // The full ceiling still binds: crossing it aborts the landing
        // signal and refuses further work.
        led.recordSpend("claim-validator", 1.5);
        expect(led.signal.aborted).toBe(true);
        expect(led.mayDispatch("thread-reconciler")).toBe(false);
    });

    it("measures without enforcing under the proxy-only rollback, loudly", () => {
        const warnings: string[] = [];
        const led = ledger({
            env: {REVIEW_SPEND_ENFORCEMENT: "proxy-only"},
            warn: (m: string) => warnings.push(m),
        });
        led.recordSpend("correctness-reviewer", 9);
        expect(led.mayDispatch("data-migrations")).toBe(true);
        expect(led.signal.aborted).toBe(false);
        // Still measured and still disclosed, so a rolled-back run is not a
        // blind run.
        const report = led.report();
        expect(report.enforcement).toBe("proxy-only");
        expect(report.crossed).toBe(true);
        // No sheds: every dispatch actually ran under the rollback, so a
        // shed entry would disclose a cut that never happened.
        expect(report.sheds).toHaveLength(0);
        // The bypass is never silent.
        expect(warnings.join(" ")).toContain("proxy-only");
    });

    it("says which enforcement was in force, in the record itself", () => {
        // The plan's standing rule: where enforcement granularity changes over
        // time, the artifact says which one produced it.
        expect(ledger().report().enforcement).toBe("in-code");
    });

    it("ships the derived production numbers as its defaults", () => {
        // Pinned deliberately: a silent edit to either constant changes live
        // spend behaviour, and this is the test that makes it a review
        // conversation rather than a diff nobody reads.
        expect(CEILING_USD).toBe(12.5);
        expect(LANDING_RESERVE_USD).toBe(1.5);
        const led = createSpendLedger({env: {}, warn: () => {}});
        expect(led.report().ceilingUsd).toBe(12.5);
        expect(led.report().landingReserveUsd).toBe(1.5);
    });

    it("ignores a negative turn cost rather than banking credit", () => {
        const led = ledger();
        led.recordSpend("a", 5);
        led.recordSpend("a", -100);
        expect(led.spentUsd()).toBe(5);
    });
});
