import {describe, it, expect} from "vitest";

import {
    CASE_CATEGORIES,
    SMOKE_TAG,
    loadSmokeCorpus,
    type CorpusCase,
} from "./corpus/loader.ts";
import {runSmokeCorpus, type RunResult} from "./runner.ts";

/**
 * Smoke benchmark CI gate.
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
 * regress (the smoke set predates the rebalance):
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
            // The planned review's comments are the posted candidates plus
            // (at most) the one collapsed pre-existing note, so the count is
            // coherent across both surfaces.
            expect(
                result.postedCandidates.length +
                    (result.preExistingNote === null ? 0 : 1),
            ).toBe(corpusCase.expected.postedCommentCount);
        },
    );
});

describe("gate properties the rebalance must not regress", () => {
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
        // silently approved (untrusted-input rule).
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
 * Verify the recall/precision rebalance against this same
 * smoke set.
 *
 * The rebalance is a set of *prompt* edits to the reviewer sub-agents
 * (review.md edits 8–13: coverage-first, blocking-requires-a-concrete-failing-
 * scenario, the three-state validation gate (refuted drops, plausible
 * downgrades, only confirmed blocks), confirm-before-you-claim,
 * cite-exact-lines, and the edit-13 posting bar — inline ≥ medium
 * confidence, low-confidence collapsed). The gate's *apply rules* are also
 * replayed deterministically by the runner (stage 3b) over each case's recorded
 * `validation` block; the point of this block is to pin *why* the rebalance
 * cannot regress the two properties it names, in terms of the
 * rebalance's own mechanism rather than re-asserting the generic smoke gate
 * above.
 *
 * The load-bearing invariants, read off the corpus + the deterministic run:
 *   - Recall: every must-catch finding is `blocking`, ≥ medium confidence, AND
 *     never recorded as `plausible`/`refuted` in a case's validation block, so
 *     neither edit-13's confidence posting bar nor the gate's downgrade path
 *     can demote or drop it — must-catch recall is structurally pinned at 100%.
 *   - Precision: a clean case's blocking findings (the audit-seeded false
 *     blocks) are always neutralized by the recorded validation, so a clean PR
 *     stays APPROVE — clean false-block stays at 0.
 *   - The collapse/downgrade path is actually exercised: the corpus carries at
 *     least one low-confidence advisory that the rebalance targets, and it is
 *     never a must-catch, so trimming it is safe.
 */
describe("rebalance verification against the smoke set", () => {
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

    it("no recall regression: every must-catch finding is blocking, ≥ medium confidence, and never verified below confirmed", () => {
        // This is the structural reason the rebalance cannot drop a must-catch:
        // edit-13's posting bar and the gate's downgrade path only touch
        // non-blocking, low-confidence, or unconfirmed claims. If a future
        // must-catch repro were added as advisory, below the bar, or recorded
        // with a plausible/refuted verification, this fails LOUDLY here rather
        // than silently regressing recall once the prompt bar tightens.
        const unprotected: string[] = [];
        const nonConfirmed = new Map(
            RUNS.flatMap(({corpusCase}) =>
                (corpusCase.validation ?? [])
                    .filter((v) => v.verification !== "confirmed")
                    .map(
                        (v) =>
                            [
                                `${corpusCase.id}:${v.id}`,
                                v.verification,
                            ] as const,
                    ),
            ),
        );
        for (const {caseId, id, candidate} of mustCatchFindings) {
            if (candidate === undefined) {
                continue; // reported by the existence test above
            }
            const {severity, confidence} = candidate.finding;
            const verification = nonConfirmed.get(`${caseId}:${id}`);
            if (
                severity !== "blocking" ||
                confidence < MEDIUM_CONFIDENCE ||
                verification !== undefined
            ) {
                unprotected.push(
                    `${caseId}:${id} (severity=${severity}, confidence=${confidence}, verification=${
                        verification ?? "confirmed"
                    })`,
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

    it("no new false-block: a clean case's blocking findings never survive validation", () => {
        // Precision side: a clean PR stays APPROVE. A clean case either carries
        // no blocking finding at all, or carries a production-derived WRONG
        // blocking finding (the audit-seeded false-block cases) that the
        // recorded three-state validation must strip: refuted drops it,
        // plausible downgrades it — only a confirmed claim may keep a blocking
        // label, and a clean case never confirms one.
        for (const {corpusCase, result} of RUNS) {
            if (corpusCase.category !== "clean") {
                continue;
            }
            const verifications = new Map(
                (corpusCase.validation ?? []).map((v) => [
                    v.id,
                    v.verification,
                ]),
            );
            for (const candidate of result.allCandidates) {
                if (candidate.finding.severity !== "blocking") {
                    continue;
                }
                const verification = verifications.get(candidate.id);
                expect(
                    verification === "refuted" || verification === "plausible",
                    `${corpusCase.id}:${candidate.id} blocking finding with no neutralizing verification`,
                ).toBe(true);
            }
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

/**
 * The three-state validation gate, replayed over audit-seeded production cases.
 *
 * The false-block cases in the corpus are derived from a 2026-07-07 audit of
 * every blocking review the bot posted on Khan/frontend since the validator
 * shipped (90 PRs, 319 blocking claims, 12 confirmed false blocks): a
 * mechanically-refutable contrast claim that recurred across four PRs, a
 * misread convention rule, an author-disputed trace-depth miss, a wrong
 * API-contract assumption, and an author-intent judgment call. Each case
 * records the verification the validator should have returned; the runner's
 * stage 3b applies the gate's rules deterministically. This block pins the gate
 * semantics themselves: refuted drops, plausible posts non-blocking, and ONLY a
 * confirmed claim may carry a blocking label into the verdict.
 */
describe("three-state validation gate (audit-seeded false blocks)", () => {
    const validatedRuns = RUNS.filter(
        ({corpusCase}) => (corpusCase.validation ?? []).length > 0,
    );

    it("exercises all three verification states (gate checks are not vacuous)", () => {
        expect(validatedRuns.length).toBeGreaterThan(0);
        const states = new Set(
            validatedRuns.flatMap(({corpusCase}) =>
                (corpusCase.validation ?? []).map((v) => v.verification),
            ),
        );
        expect(states.has("refuted")).toBe(true);
        expect(states.has("plausible")).toBe(true);
        expect(states.has("confirmed")).toBe(true);
    });

    it("only a confirmed claim carries a blocking label into the verdict", () => {
        for (const {corpusCase, result} of validatedRuns) {
            const verifications = new Map(
                (corpusCase.validation ?? []).map((v) => [
                    v.id,
                    v.verification,
                ]),
            );
            for (const candidate of result.postedCandidates) {
                if (!candidate.blocking) {
                    continue;
                }
                // Absent verification defaults to confirmed (untouched claim).
                const verification =
                    verifications.get(candidate.id) ?? "confirmed";
                expect(
                    verification,
                    `${corpusCase.id}:${candidate.id} blocks without a confirmed verification`,
                ).toBe("confirmed");
            }
        }
    });

    it("refuted claims are dropped; plausible claims post as non-blocking", () => {
        for (const {corpusCase, result} of validatedRuns) {
            const posted = postedIds(result);
            const droppedIds = new Set(
                result.droppedByValidation.map((c) => c.id),
            );
            for (const verification of corpusCase.validation ?? []) {
                if (verification.verification === "refuted") {
                    expect(
                        droppedIds.has(verification.id),
                        `${corpusCase.id}:${verification.id} refuted but not dropped`,
                    ).toBe(true);
                    expect(posted.has(verification.id)).toBe(false);
                } else if (verification.verification === "plausible") {
                    const candidate = result.postedCandidates.find(
                        (c) => c.id === verification.id,
                    );
                    expect(
                        candidate,
                        `${corpusCase.id}:${verification.id} plausible but not posted`,
                    ).toBeDefined();
                    expect(candidate?.blocking).toBe(false);
                }
            }
        }
    });
});
