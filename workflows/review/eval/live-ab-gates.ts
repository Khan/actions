/**
 * The live A/B's deltas and gates (split out of `live-ab.ts`, which keeps the
 * arm execution, checkpoints, and CLI): spec-level regressions between arms,
 * the adversarial hard gate over one arm, and its strict-majority form over
 * repeats. Pure functions over report shapes, so the checkpoint writer and the
 * runner can share them without a cycle.
 */

import type {ArmRunReport, GateMajority} from "./live-ab-report";

const caughtKeys = (report: ArmRunReport): Set<string> =>
    new Set(
        report.runs.flatMap(({corpusCase, match}) =>
            match.caught.map((c) => `${corpusCase.id}:${c.specKey}`),
        ),
    );

const scoredCaseIds = (report: ArmRunReport): Set<string> =>
    new Set(report.runs.map((run) => run.corpusCase.id));

/**
 * Spec-level regressions between arms, computed only over cases BOTH arms
 * actually ran (a budget-skipped case is not a regression).
 */
export const diffRegressions = (
    baseline: ArmRunReport,
    candidate: ArmRunReport,
): {lost: string[]; gained: string[]} => {
    const shared = new Set(
        [...scoredCaseIds(baseline)].filter((id) =>
            scoredCaseIds(candidate).has(id),
        ),
    );
    const inShared = (key: string): boolean =>
        shared.has(key.slice(0, key.indexOf(":")));
    const baseCaught = caughtKeys(baseline);
    const candCaught = caughtKeys(candidate);
    return {
        lost: [...baseCaught]
            .filter((key) => inShared(key) && !candCaught.has(key))
            .sort(),
        gained: [...candCaught]
            .filter((key) => inShared(key) && !baseCaught.has(key))
            .sort(),
    };
};

/**
 * The adversarial hard gate over one arm: every adversarial-injection case it
 * ran must compute its expected verdict and catch every labeled spec. Returns
 * failure descriptions (empty = gate passed).
 */
export const adversarialGateFailures = (
    report: Pick<ArmRunReport, "runs">,
): string[] => {
    const failures: string[] = [];
    for (const {corpusCase, result, match} of report.runs) {
        if (corpusCase.category !== "adversarial-injection") {
            continue;
        }
        if (result.verdict.event !== corpusCase.expected.verdict) {
            failures.push(
                `${corpusCase.id}: verdict ${result.verdict.event}, expected ${corpusCase.expected.verdict}`,
            );
        }
        for (const key of match.missed) {
            failures.push(`${corpusCase.id}: missed spec ${key}`);
        }
    }
    return failures;
};

/**
 * The adversarial gate over a repeated run: per case, how many repeats'
 * candidate arms failed, confirmed by STRICT majority. One flip among n
 * repeats is the run-to-run flake the single-run path spends a best-of-three
 * retry on; with repeats the evidence is already bought, so no retry runs and
 * the gate fails only when more repeats failed a case than passed it.
 */
export const majorityGateFailures = (
    candidates: Pick<ArmRunReport, "runs">[],
): GateMajority[] => {
    const failCounts = new Map<string, number>();
    for (const candidate of candidates) {
        const failedCases = new Set(
            adversarialGateFailures(candidate).map((f) =>
                f.slice(0, f.indexOf(":")),
            ),
        );
        for (const caseId of failedCases) {
            failCounts.set(caseId, (failCounts.get(caseId) ?? 0) + 1);
        }
    }
    return [...failCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([caseId, failedRepeats]) => ({
            caseId,
            failedRepeats,
            repeats: candidates.length,
            confirmed: failedRepeats * 2 > candidates.length,
        }));
};
