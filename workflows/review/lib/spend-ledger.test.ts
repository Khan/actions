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
        expect(led.recordTurn("correctness-reviewer", 3)).toBe("continue");
        expect(led.recordTurn("correctness-reviewer", 2)).toBe("continue");
        expect(led.spentUsd()).toBe(5);
        expect(led.report().crossed).toBe(false);
        expect(led.report().sheds).toEqual([]);
        expect(led.signal.aborted).toBe(false);
    });

    it("aborts in-flight agents on the turn that crosses", () => {
        const led = ledger();
        expect(led.recordTurn("skill-auditor", 7)).toBe("continue");
        expect(led.recordTurn("skill-auditor", 2)).toBe("abort");
        // The abort is what stops work already running, and it carries the
        // arithmetic so the log says why rather than just that.
        expect(led.signal.aborted).toBe(true);
        expect(String(led.signal.reason)).toMatch(
            /spend ceiling reached: \$9\.00 of \$10\.00.*budget \$8\.00.*reserve \$2\.00/,
        );
    });

    it("refuses a new dispatch once crossed, and discloses it as a shed", () => {
        const led = ledger();
        led.recordTurn("correctness-reviewer", 9);
        expect(led.mayDispatch("data-migrations")).toBe(false);
        const report = led.report();
        expect(report.sheds).toEqual([
            {agent: "correctness-reviewer", atUsd: 9, kind: "aborted"},
            {agent: "data-migrations", atUsd: 9, kind: "refused"},
        ]);
    });

    it("records overshoot so the worst case is measurable, not estimated", () => {
        const led = ledger();
        // One expensive turn lands past the budget in a single step; the
        // ledger cannot prevent that, only measure it.
        led.recordTurn("correctness-reviewer", 11);
        expect(led.report().overshootUsd).toBe(3);
    });

    it("aborts once, then keeps accumulating sheds without re-aborting", () => {
        const led = ledger();
        led.recordTurn("a", 9);
        const firstReason = led.signal.reason;
        led.recordTurn("b", 5);
        expect(led.signal.reason).toBe(firstReason);
        expect(led.report().sheds).toHaveLength(2);
        expect(led.report().spentUsd).toBe(14);
    });

    it("measures without enforcing under the proxy-only rollback, loudly", () => {
        const warnings: string[] = [];
        const led = ledger({
            env: {REVIEW_SPEND_ENFORCEMENT: "proxy-only"},
            warn: (m: string) => warnings.push(m),
        });
        expect(led.recordTurn("correctness-reviewer", 9)).toBe("continue");
        expect(led.mayDispatch("data-migrations")).toBe(true);
        expect(led.signal.aborted).toBe(false);
        // Still measured and still disclosed, so a rolled-back run is not a
        // blind run.
        const report = led.report();
        expect(report.enforcement).toBe("proxy-only");
        expect(report.crossed).toBe(true);
        expect(report.sheds).toHaveLength(2);
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
        led.recordTurn("a", 5);
        led.recordTurn("a", -100);
        expect(led.spentUsd()).toBe(5);
    });
});
