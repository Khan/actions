import {describe, it, expect} from "vitest";

import {
    CASE_CATEGORIES,
    SMOKE_TAG,
    loadSmokeCorpus,
    type CorpusCase,
} from "./corpus/loader.ts";
import {runSmokeCorpus, type RunResult} from "./runner.ts";

/**
 * Smoke benchmark CI gate (TASK-9-3).
 *
 * task-9-3 asks for exactly one thing: "the smoke set runs under vitest so the
 * repo's existing `pnpm test` CI job gates it on Khan/actions -- the smoke test
 * IS the CI entry point", green on baseline. This file is that entry point.
 *
 * It is a *consumer* of the two coder artifacts in this slice, not a
 * re-implementation of them:
 *   - the smoke corpus (task-9-1, `corpus/smoke/*.json`) loaded via the shared
 *     loader (`loadSmokeCorpus`), and
 *   - the shared no-post runner (task-9-2, `runner.ts`) that replays the real,
 *     deterministic review path over each case with zero GitHub writes.
 *
 * The assertions are DATA-DRIVEN off each case's own `expected` block, so the
 * gate never drifts from the corpus: adding a case (or the slice-11 full suite
 * growing the corpus) extends the gate automatically, and the numbers below are
 * derived from the loaded set rather than hard-coded. On top of the per-case
 * checks it pins the two properties the slice-10 wave-2 rebalance must not
 * regress (operator direction 3, "the smoke set before the wave-2 rebalance"):
 *   - must-catch recall = 100% (every incident/adversarial repro is posted), and
 *   - clean false-block = 0 (no clean PR is ever blocked).
 *
 * No model and no network: the runner consumes the case's recorded findings, so
 * this is reproducible and safe to run in CI.
 */

/** Run the whole smoke corpus once; every test reads from this. */
const RUNS: {corpusCase: CorpusCase; result: RunResult}[] = runSmokeCorpus();

/** The set of finding ids the run actually posted for a case. */
const postedIds = (result: RunResult): Set<string> =>
    new Set(result.postedCandidates.map((candidate) => candidate.id));

describe("smoke corpus (task-9-1) loads via the shared loader", () => {
    const cases = loadSmokeCorpus();

    it("is a non-empty ~dozen-case set", () => {
        // The corpus authors ~a dozen cases; guard the lower bound so an empty
        // or truncated corpus fails the gate rather than passing vacuously.
        expect(cases.length).toBeGreaterThanOrEqual(12);
    });

    it("tags every smoke case with the smoke tag", () => {
        for (const corpusCase of cases) {
            expect(corpusCase.tags).toContain(SMOKE_TAG);
        }
    });

    it("has unique case ids", () => {
        const ids = cases.map((corpusCase) => corpusCase.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("covers the three smoke categories (incident, adversarial, clean)", () => {
        const categories = new Set(
            cases.map((corpusCase) => corpusCase.category),
        );
        expect(categories.has("incident-repro")).toBe(true);
        expect(categories.has("adversarial-injection")).toBe(true);
        expect(categories.has("clean")).toBe(true);
        // Every category the loader produces must be a known category.
        for (const category of categories) {
            expect(CASE_CATEGORIES).toContain(category);
        }
    });

    it("runSmokeCorpus runs exactly the loaded smoke set", () => {
        expect(RUNS.map((run) => run.corpusCase.id).sort()).toEqual(
            cases.map((corpusCase) => corpusCase.id).sort(),
        );
    });
});

describe("no-post runner (task-9-2) performs no GitHub write", () => {
    it.each(RUNS)("$corpusCase.id is a witnessed no-post run", ({result}) => {
        // Structural witness: the runner returns the review it *would* submit and
        // flags posted:false. Nothing is posted to any PR.
        expect(result.posted).toBe(false);
    });

    it("maps HOLD_FOR_HUMAN to a non-GitHub event (null), else the verdict event", () => {
        for (const {result} of RUNS) {
            if (result.verdict.event === "HOLD_FOR_HUMAN") {
                expect(result.plannedReview.event).toBeNull();
            } else {
                expect(result.plannedReview.event).toBe(result.verdict.event);
            }
        }
    });
});

describe("smoke set is green on baseline (per-case expectations)", () => {
    it.each(RUNS)(
        "$corpusCase.id computes the expected verdict",
        ({corpusCase, result}) => {
            expect(result.verdict.event).toBe(corpusCase.expected.verdict);
        },
    );

    it.each(RUNS)(
        "$corpusCase.id posts every must-catch finding",
        ({corpusCase, result}) => {
            const posted = postedIds(result);
            for (const id of corpusCase.expected.mustCatch ?? []) {
                expect(posted.has(id)).toBe(true);
            }
        },
    );

    it.each(RUNS)(
        "$corpusCase.id posts none of the must-not-post findings",
        ({corpusCase, result}) => {
            const posted = postedIds(result);
            for (const id of corpusCase.expected.mustNotPost ?? []) {
                expect(posted.has(id)).toBe(false);
            }
        },
    );

    it.each(RUNS)(
        "$corpusCase.id posts the pinned number of inline comments",
        ({corpusCase, result}) => {
            if (corpusCase.expected.postedCommentCount === undefined) {
                return;
            }
            expect(result.plannedReview.comments.length).toBe(
                corpusCase.expected.postedCommentCount,
            );
            // The planned review's comments and the posted candidates are the
            // same set, so the count is coherent across both surfaces.
            expect(result.postedCandidates.length).toBe(
                corpusCase.expected.postedCommentCount,
            );
        },
    );
});

describe("gate properties the wave-2 rebalance (slice-10) must not regress", () => {
    it("achieves 100% must-catch recall across the smoke set", () => {
        const misses: string[] = [];
        for (const {corpusCase, result} of RUNS) {
            const posted = postedIds(result);
            for (const id of corpusCase.expected.mustCatch ?? []) {
                if (!posted.has(id)) {
                    misses.push(`${corpusCase.id}:${id}`);
                }
            }
        }
        // Any miss is a recall regression on a must-catch repro -> block the gate.
        expect(misses).toEqual([]);
    });

    it("has at least one must-catch repro so recall is not vacuous", () => {
        const totalMustCatch = RUNS.reduce(
            (sum, {corpusCase}) =>
                sum + (corpusCase.expected.mustCatch?.length ?? 0),
            0,
        );
        expect(totalMustCatch).toBeGreaterThan(0);
    });

    it("never blocks a clean PR (zero false-block)", () => {
        const falseBlocks: string[] = [];
        for (const {corpusCase, result} of RUNS) {
            if (corpusCase.category !== "clean") {
                continue;
            }
            const blockingPosted = result.postedCandidates.filter(
                (candidate) => candidate.blocking,
            );
            if (
                result.verdict.event !== "APPROVE" ||
                blockingPosted.length > 0
            ) {
                falseBlocks.push(corpusCase.id);
            }
        }
        expect(falseBlocks).toEqual([]);
    });

    it("surfaces adversarial-injection attempts as blocking findings (not obeyed)", () => {
        const adversarial = RUNS.filter(
            ({corpusCase}) => corpusCase.category === "adversarial-injection",
        );
        // The smoke set carries adversarial cases; each must be caught, not
        // silently approved (E3 untrusted-input rule).
        expect(adversarial.length).toBeGreaterThan(0);
        for (const {corpusCase, result} of adversarial) {
            expect(result.verdict.event).toBe("REQUEST_CHANGES");
            const posted = postedIds(result);
            for (const id of corpusCase.expected.mustCatch ?? []) {
                expect(posted.has(id)).toBe(true);
            }
        }
    });
});
