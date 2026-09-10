import type {ArmRunReport, MultiAbReport} from "./live-ab-report";
import {coverageNote} from "./live-accounting";

/** Pair cases, not raw comment counts. Unmatched output isn't a proven FP. */
export const compareUsefulCoverage = (
    baseline: ArmRunReport,
    candidate: ArmRunReport,
) => {
    const paired = baseline.perCase.flatMap((base) => {
        const cand = candidate.perCase.find((c) => c.caseId === base.caseId);
        if (cand?.accounting === undefined || base.accounting === undefined) {
            return [];
        }
        const before = base.accounting.usefulDefects;
        const after = cand.accounting.usefulDefects;
        const beforeKeys = new Set(before.map((d) => d.key));
        const afterKeys = new Set(after.map((d) => d.key));
        return [
            {
                caseId: base.caseId,
                gained: after
                    .filter((d) => !beforeKeys.has(d.key))
                    .map((d) => d.key),
                lost: before
                    .filter((d) => !afterKeys.has(d.key))
                    .map((d) => d.key),
                shared: before
                    .filter((d) => afterKeys.has(d.key))
                    .map((d) => d.key),
                inlineDisplaced: before
                    .filter(
                        (d) =>
                            d.inline &&
                            !after.some((a) => a.key === d.key && a.inline),
                    )
                    .map((d) => d.key),
                baselineShed: base.accounting.coverage.shed,
                candidateShed: cand.accounting.coverage.shed,
                completeCoverage:
                    base.accounting.coverage.complete &&
                    cand.accounting.coverage.complete,
                usdDelta: cand.usd - base.usd,
            },
        ];
    });
    const gained = paired.reduce((n, c) => n + c.gained.length, 0);
    const lost = paired.reduce((n, c) => n + c.lost.length, 0);
    const usdDelta = paired.reduce((n, c) => n + c.usdDelta, 0);
    return {
        paired,
        unpaired: [
            ...new Set([
                ...baseline.perCase.map((c) => c.caseId),
                ...candidate.perCase.map((c) => c.caseId),
                ...baseline.skippedCases,
                ...candidate.skippedCases,
            ]),
        ].filter((id) => !paired.some((c) => c.caseId === id)),
        gained,
        lost,
        net: gained - lost,
        usdDelta,
        usdPerNetUsefulCatch: gained > lost ? usdDelta / (gained - lost) : null,
    };
};

export type UsefulCoverageComparison = ReturnType<typeof compareUsefulCoverage>;

const valueTotalsSummary = (
    value: Pick<
        UsefulCoverageComparison,
        "gained" | "lost" | "net" | "usdDelta" | "usdPerNetUsefulCatch"
    >,
): string[] => [
    `Paired useful defects: ${value.gained} gained, ${value.lost} lost, ${
        value.net
    } net. Paired dispatch cost delta (list price): $${value.usdDelta.toFixed(
        2,
    )}.`,
    `Dispatch cost per net useful catch (list price): ${
        value.usdPerNetUsefulCatch === null
            ? "n/a (net gain is not positive)"
            : `$${value.usdPerNetUsefulCatch.toFixed(2)}`
    }.`,
];

export const valueSummary = (
    value: UsefulCoverageComparison | undefined,
): string[] =>
    value === undefined
        ? ["Useful-catch value unavailable (no value accounting)."]
        : [
              `Useful-catch pairing: ${value.paired.length} paired cases, ${value.unpaired.length} unpaired cases.`,
              ...valueTotalsSummary(value),
              `Inline coverage displaced: ${value.paired.reduce(
                  (n, c) => n + c.inlineDisplaced.length,
                  0,
              )} defect(s). Unpaired cases: ${
                  value.unpaired.join(", ") || "none"
              }. See the JSON value block for the per-case trade.`,
          ];

/** Pool finished repeat observations, never partial checkpoints or missing values. */
export const repeatedValueSummary = (report: MultiAbReport): string[] => {
    const finished = report.repeats.filter((r) => r.partial !== true);
    const values = finished.flatMap((r) =>
        r.value === undefined ? [] : [r.value],
    );
    const gained = values.reduce((n, v) => n + v.gained, 0);
    const lost = values.reduce((n, v) => n + v.lost, 0);
    const net = gained - lost;
    const usdDelta = values.reduce((n, v) => n + v.usdDelta, 0);
    const paired = values.flatMap((v) => v.paired);
    return [
        `Useful-catch value pooled over ${values.length}/${
            finished.length
        } finished repeats with value accounting (${
            report.repeatCount
        } planned repeats): ${paired.length} paired case-runs, ${values.reduce(
            (n, v) => n + v.unpaired.length,
            0,
        )} unpaired case-runs.`,
        "Counts sum repeat observations, not distinct defects across repeats.",
        ...(values.length === 0
            ? [
                  "Useful-catch value unavailable (no finished repeat has value accounting).",
              ]
            : [
                  ...valueTotalsSummary({
                      gained,
                      lost,
                      net,
                      usdDelta,
                      usdPerNetUsefulCatch: net > 0 ? usdDelta / net : null,
                  }),
                  `Inline coverage displaced in the pool: ${paired.reduce(
                      (n, c) => n + c.inlineDisplaced.length,
                      0,
                  )} defect observations.`,
              ]),
        ...report.repeats.flatMap((repeat, i) => [
            "",
            `Repeat ${i + 1} (${
                repeat.partial === true
                    ? "in progress, excluded from pool"
                    : "finished"
            }):`,
            ...valueSummary(repeat.value),
            coverageNote(repeat.arms.baseline),
            coverageNote(repeat.arms.candidate),
        ]),
        "Coverage gaps are not clean passes. Budget shedding leaves a missing coverage dimension. Inspect each repeat's JSON value and per-case accounting for the tradeoff.",
        "",
    ];
};
