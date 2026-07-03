/**
 * R5 eval **metrics** (task-11-2): the five numbers that say whether the reviewer
 * this run shipped is good enough — computed over a corpus run, deterministically
 * and with no model call.
 *
 *   1. **must-catch recall** (~100% target) — of the findings a case says the
 *      reviewer MUST surface (incident repros, adversarial catches, golden
 *      human-flagged issues), what fraction actually appear in the posted set.
 *      This is the metric that protects against regressions: a dropped must-catch
 *      is a real incident the reviewer would now miss.
 *   2. **golden precision** — over the golden set (recorded human-comment PRs),
 *      of the comments the reviewer posts, what fraction match a finding a human
 *      actually flagged. Low precision here means the reviewer is noisy on
 *      exactly the PRs we have ground truth for.
 *   3. **clean false-block** (~0 target) — of the known-clean PRs, what fraction
 *      the reviewer blocked (REQUEST_CHANGES) or refused to pass. A false block on
 *      a clean PR is the failure that erodes trust fastest.
 *   4. **noise** — of every comment posted across the corpus, what fraction the
 *      case explicitly marked must-NOT-post (a candidate the scope filter or
 *      validator should have dropped, or a clean case that should stay silent).
 *   5. **calibration** — do the model's `confidence` numbers mean anything? We
 *      bucket posted findings by confidence and compare each bucket's mean
 *      confidence to its empirical correctness, reporting the expected
 *      calibration error (ECE). The slice-8 thumbs labels calibrate the same axis
 *      at runtime; here we measure it against the corpus ground truth.
 *
 * Determinism boundary (analysis R8): this module reads structured findings and
 * case expectations and emits numbers. It authors no prose about code under
 * review.
 */

import type {EvalRun} from "./run-types";

/* -------------------------------------------------------------------------- */
/* Report shapes                                                             */
/* -------------------------------------------------------------------------- */

/** A ratio metric: numerator / denominator, with `rate` = num/den (0 when den=0). */
export type RatioMetric = {
    numerator: number;
    denominator: number;
    /** numerator / denominator, or 0 when the denominator is 0. */
    rate: number;
    /** Ids that contributed to the numerator (diagnosability). */
    hits: string[];
    /** Ids in the denominator that did NOT contribute (the misses / offenders). */
    misses: string[];
};

/** One confidence bucket in the calibration curve. */
export type CalibrationBucket = {
    /** Half-open bucket bounds [lower, upper), except the last which is closed. */
    lower: number;
    upper: number;
    /** Number of labelled posted findings whose confidence fell in the bucket. */
    count: number;
    /** Mean `confidence` of the findings in the bucket. */
    meanConfidence: number;
    /** Empirical correctness (fraction that were must-catch, not must-not-post). */
    accuracy: number;
};

export type CalibrationMetric = {
    buckets: CalibrationBucket[];
    /**
     * Expected Calibration Error: the count-weighted mean gap between a bucket's
     * mean confidence and its empirical accuracy. 0 = perfectly calibrated. `null`
     * when no posted finding carried a correctness label (nothing to calibrate).
     */
    ece: number | null;
    /** Total labelled posted findings the ECE was computed over. */
    sampleSize: number;
};

export type MetricsReport = {
    mustCatchRecall: RatioMetric;
    goldenPrecision: RatioMetric;
    cleanFalseBlock: RatioMetric;
    noise: RatioMetric;
    calibration: CalibrationMetric;
    /** Number of corpus runs the report was computed over. */
    caseCount: number;
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const ratio = (
    numerator: number,
    denominator: number,
    hits: string[],
    misses: string[],
): RatioMetric => ({
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : numerator / denominator,
    hits,
    misses,
});

/** A posted candidate is "blocked" when the run's verdict is not APPROVE. */
const wasBlocked = (run: EvalRun): boolean =>
    run.result.verdict.event !== "APPROVE";

/* -------------------------------------------------------------------------- */
/* The five metrics                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Must-catch recall: across every case declaring `expected.mustCatch`, the
 * fraction of those ids that appear in the posted set. Namespaced by case id so
 * two cases can reuse a finding id without colliding. Denominator 0 (no
 * must-catch cases) yields rate 0 with an empty report — callers reading recall
 * should check `denominator > 0`.
 */
export const mustCatchRecall = (runs: EvalRun[]): RatioMetric => {
    const caught: string[] = [];
    const missed: string[] = [];
    for (const run of runs) {
        const required = run.corpusCase.expected.mustCatch ?? [];
        if (required.length === 0) {
            continue;
        }
        const posted = new Set(run.result.postedCandidates.map((c) => c.id));
        for (const id of required) {
            const key = `${run.corpusCase.id}:${id}`;
            if (posted.has(id)) {
                caught.push(key);
            } else {
                missed.push(key);
            }
        }
    }
    return ratio(caught.length, caught.length + missed.length, caught, missed);
};

/**
 * Golden precision: over `category === "golden"` cases, of the findings the
 * reviewer posted, the fraction that match a human-flagged finding (the case's
 * `mustCatch`). Posted findings not in `mustCatch` are counted as precision
 * misses (false positives against ground truth). A golden case with an empty
 * `mustCatch` treats every posted finding as a false positive, which is correct:
 * a human left no comment, so anything posted is unmatched.
 */
export const goldenPrecision = (runs: EvalRun[]): RatioMetric => {
    const truePositives: string[] = [];
    const falsePositives: string[] = [];
    for (const run of runs) {
        if (run.corpusCase.category !== "golden") {
            continue;
        }
        const expected = new Set(run.corpusCase.expected.mustCatch ?? []);
        for (const candidate of run.result.postedCandidates) {
            const key = `${run.corpusCase.id}:${candidate.id}`;
            if (expected.has(candidate.id)) {
                truePositives.push(key);
            } else {
                falsePositives.push(key);
            }
        }
    }
    return ratio(
        truePositives.length,
        truePositives.length + falsePositives.length,
        truePositives,
        falsePositives,
    );
};

/**
 * Clean false-block rate: over `category === "clean"` cases, the fraction whose
 * run did not APPROVE (i.e. REQUEST_CHANGES or HOLD_FOR_HUMAN). Target ~0 — a
 * clean PR must pass. The denominator is the number of clean cases; the
 * numerator (and `hits`) are the clean case ids that were wrongly blocked.
 */
export const cleanFalseBlock = (runs: EvalRun[]): RatioMetric => {
    const clean = runs.filter((r) => r.corpusCase.category === "clean");
    const blocked: string[] = [];
    const passed: string[] = [];
    for (const run of clean) {
        if (wasBlocked(run)) {
            blocked.push(run.corpusCase.id);
        } else {
            passed.push(run.corpusCase.id);
        }
    }
    return ratio(blocked.length, clean.length, blocked, passed);
};

/**
 * Noise rate: of every comment posted across the whole corpus, the fraction the
 * owning case explicitly marked `mustNotPost`. These are the candidates the scope
 * filter / validator was supposed to drop; a posted must-not-post is noise the
 * reviewer should not have emitted. Denominator is total posted comments.
 */
export const noise = (runs: EvalRun[]): RatioMetric => {
    const noisy: string[] = [];
    const clean: string[] = [];
    let totalPosted = 0;
    for (const run of runs) {
        const banned = new Set(run.corpusCase.expected.mustNotPost ?? []);
        for (const candidate of run.result.postedCandidates) {
            totalPosted += 1;
            const key = `${run.corpusCase.id}:${candidate.id}`;
            if (banned.has(candidate.id)) {
                noisy.push(key);
            } else {
                clean.push(key);
            }
        }
    }
    return ratio(noisy.length, totalPosted, noisy, clean);
};

/**
 * The number of equal-width confidence buckets in the calibration curve. Five
 * buckets of width 0.2 over [0, 1] — enough resolution to see mis-calibration
 * without starving each bucket of samples on a modestly-sized corpus.
 */
export const CALIBRATION_BUCKETS = 5;

/**
 * Calibration: bucket every *labelled* posted finding by its `confidence` and
 * compare each bucket's mean confidence to its empirical correctness. A finding
 * is labelled when its id is in the owning case's `mustCatch` (correct) or
 * `mustNotPost` (incorrect); unlabelled posted findings carry no ground truth and
 * are excluded. Reports per-bucket detail plus the count-weighted ECE.
 */
export const calibration = (runs: EvalRun[]): CalibrationMetric => {
    type Sample = {confidence: number; correct: boolean};
    const samples: Sample[] = [];
    for (const run of runs) {
        const mustCatch = new Set(run.corpusCase.expected.mustCatch ?? []);
        const mustNotPost = new Set(run.corpusCase.expected.mustNotPost ?? []);
        for (const candidate of run.result.postedCandidates) {
            if (mustCatch.has(candidate.id)) {
                samples.push({
                    confidence: candidate.finding.confidence,
                    correct: true,
                });
            } else if (mustNotPost.has(candidate.id)) {
                samples.push({
                    confidence: candidate.finding.confidence,
                    correct: false,
                });
            }
        }
    }

    const width = 1 / CALIBRATION_BUCKETS;
    const buckets: CalibrationBucket[] = [];
    for (let i = 0; i < CALIBRATION_BUCKETS; i += 1) {
        const lower = i * width;
        const upper = i === CALIBRATION_BUCKETS - 1 ? 1 : (i + 1) * width;
        const inBucket = samples.filter((s) =>
            i === CALIBRATION_BUCKETS - 1
                ? s.confidence >= lower && s.confidence <= upper
                : s.confidence >= lower && s.confidence < upper,
        );
        const count = inBucket.length;
        const meanConfidence =
            count === 0
                ? 0
                : inBucket.reduce((sum, s) => sum + s.confidence, 0) / count;
        const accuracy =
            count === 0 ? 0 : inBucket.filter((s) => s.correct).length / count;
        buckets.push({lower, upper, count, meanConfidence, accuracy});
    }

    const total = samples.length;
    const ece =
        total === 0
            ? null
            : buckets.reduce(
                  (sum, b) =>
                      sum +
                      (b.count / total) *
                          Math.abs(b.meanConfidence - b.accuracy),
                  0,
              );

    return {buckets, ece, sampleSize: total};
};

/**
 * Compute all five metrics over a corpus run. This is the single entry the eval
 * suite (and the slice-11 gates) call; each metric is also exported individually
 * for focused tests and for the R15 counters that reuse them.
 */
export const computeMetrics = (runs: EvalRun[]): MetricsReport => ({
    mustCatchRecall: mustCatchRecall(runs),
    goldenPrecision: goldenPrecision(runs),
    cleanFalseBlock: cleanFalseBlock(runs),
    noise: noise(runs),
    calibration: calibration(runs),
    caseCount: runs.length,
});
