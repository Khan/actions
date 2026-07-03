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
 * the spec asks for exactly one thing: "the smoke set runs under vitest so the
 * repo's existing `pnpm test` CI job gates it on Khan/actions -- the smoke test
 * IS the CI entry point", green on baseline. This file is that entry point.
 *
 * It is a *consumer* of the two coder artifacts in this slice, not a
 * re-implementation of them:
 *   - the smoke corpus (the spec, `corpus/smoke/*.json`) loaded via the shared
 *     loader (`loadSmokeCorpus`), and
 *   - the shared no-post runner (the spec, `runner.ts`) that replays the real,
 *     deterministic review path over each case with zero GitHub writes.
 *
 * The assertions are DATA-DRIVEN off each case's own `expected` block, so the
 * gate never drifts from the corpus: adding a case (or the full suite
 * growing the corpus) extends the gate automatically, and the numbers below are
 * derived from the loaded set rather than hard-coded. On top of the per-case
 * checks it pins the two properties the recall/precision rebalance must not
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

describe("smoke corpus  loads via the shared loader", () => {
    const cases = loadSmokeCorpus();

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

describe("no-post runner  performs no GitHub write", () => {
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

describe("gate properties the wave-2 rebalance (the rebalance) must not regress", () => {
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

/**
 * TASK-10-3 — verify the wave-2 recall/precision rebalance against this same
 * slice-9 smoke set.
 *
 * The rebalance (slice-10) is a set of *prompt* edits to the reviewer sub-agents
 * (review.md edits 8–13: coverage-first, blocking-requires-a-concrete-failing-
 * scenario, drop-only-the-refuted / downgrade-the-uncertain, confirm-before-you-
 * claim, cite-exact-lines, and the edit-13 posting bar — inline ≥ medium
 * confidence, low-confidence collapsed). None of those edits touch the
 * deterministic review path this runner replays, so the smoke set stays green by
 * construction; the point of this block is to pin *why* it cannot regress the two
 * properties task-10-3 names, in terms of the rebalance's own mechanism rather
 * than re-asserting the generic slice-9 gate above.
 *
 * The load-bearing invariants, read off the corpus + the deterministic run:
 *   - Recall: every must-catch finding is `blocking` AND ≥ medium confidence, so
 *     neither edit-13's confidence posting bar nor edit-10's downgrade/refuter
 *     pass (both of which act only on non-blocking, low-confidence advisories)
 *     can demote or drop it — must-catch recall is structurally pinned at 100%.
 *   - Precision: the rebalance only ever *removes* or *collapses* advisory noise,
 *     so it cannot manufacture a NEW blocking finding on a clean PR — clean
 *     false-block stays at 0.
 *   - The collapse/downgrade path is actually exercised: the corpus carries at
 *     least one low-confidence advisory that the rebalance targets, and it is
 *     never a must-catch, so trimming it is safe.
 */
describe("wave-2 rebalance verification against the smoke set (task-10-3)", () => {
    /**
     * Reference threshold for edit-13's "inline ≥ medium confidence" posting
     * bar. Kept local to the test as a *documentation* of the rebalance intent —
     * the deterministic runner does not (and must not) implement a confidence
     * gate; this is the bar the recall invariant is proven safe against.
     */
    const MEDIUM_CONFIDENCE = 0.5;

    /** Every must-catch finding across the smoke set, paired with its case. */
    const mustCatchFindings = RUNS.flatMap(({corpusCase, result}) =>
        (corpusCase.expected.mustCatch ?? []).map((id) => {
            const candidate = result.allCandidates.find((c) => c.id === id);
            return {caseId: corpusCase.id, id, candidate};
        }),
    );

    it("has must-catch repros to protect (recall check is not vacuous)", () => {
        expect(mustCatchFindings.length).toBeGreaterThan(0);
    });

    it("every must-catch finding exists as a recorded candidate", () => {
        // Guards the two invariants below from passing vacuously on a typo'd id.
        for (const {caseId, id, candidate} of mustCatchFindings) {
            expect(
                candidate,
                `${caseId}:${id} missing from candidates`,
            ).toBeDefined();
        }
    });

    it("no recall regression: every must-catch finding is blocking AND ≥ medium confidence", () => {
        // This is the structural reason the rebalance cannot drop a must-catch:
        // edit-13's posting bar and edit-10's downgrade/refuter pass only touch
        // non-blocking, low-confidence advisories. If a future must-catch repro
        // were added as advisory or below the bar, this fails LOUDLY here rather
        // than silently regressing recall once the prompt bar tightens.
        const unprotected: string[] = [];
        for (const {caseId, id, candidate} of mustCatchFindings) {
            if (candidate === undefined) {
                continue; // reported by the existence test above
            }
            const {severity, confidence} = candidate.finding;
            if (severity !== "blocking" || confidence < MEDIUM_CONFIDENCE) {
                unprotected.push(
                    `${caseId}:${id} (severity=${severity}, confidence=${confidence})`,
                );
            }
        }
        expect(unprotected).toEqual([]);

        // And they are in fact still posted by the deterministic path today.
        for (const {corpusCase, result} of RUNS) {
            const posted = postedIds(result);
            for (const id of corpusCase.expected.mustCatch ?? []) {
                expect(posted.has(id)).toBe(true);
            }
        }
    });

    it("no new false-block: clean cases carry no blocking finding for the rebalance to surface", () => {
        // Precision side: the rebalance can only trim advisory noise, never add a
        // blocking finding. So a clean PR stays APPROVE iff it had no blocking
        // finding to begin with — assert that precondition holds on the corpus,
        // then that the run indeed approves with nothing blocking posted.
        for (const {corpusCase, result} of RUNS) {
            if (corpusCase.category !== "clean") {
                continue;
            }
            const blockingCandidates = result.allCandidates.filter(
                (c) => c.finding.severity === "blocking",
            );
            expect(
                blockingCandidates.map((c) => c.id),
                `${corpusCase.id} unexpectedly carries a blocking finding`,
            ).toEqual([]);
            expect(result.verdict.event).toBe("APPROVE");
            expect(result.postedCandidates.some((c) => c.blocking)).toBe(false);
        }
    });

    it("exercises the downgrade/collapse path: a low-confidence advisory exists and is never a must-catch", () => {
        // Edit-10 ("downgrade the uncertain") / edit-13 (collapse low-confidence)
        // must have something to act on for the safety argument to be non-vacuous.
        const mustCatchIds = new Set(mustCatchFindings.map((f) => f.id));
        const lowConfidenceAdvisories = RUNS.flatMap(({result}) =>
            result.allCandidates.filter(
                (c) =>
                    c.finding.severity === "advisory" &&
                    c.finding.confidence < MEDIUM_CONFIDENCE,
            ),
        );
        expect(lowConfidenceAdvisories.length).toBeGreaterThan(0);
        for (const candidate of lowConfidenceAdvisories) {
            expect(mustCatchIds.has(candidate.id)).toBe(false);
        }
    });
});
