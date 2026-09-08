import type {ArmRunReport} from "./live-ab-report";

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

export const valueSummary = (
    value: UsefulCoverageComparison | undefined,
): string[] =>
    value === undefined
        ? []
        : [
              `Paired useful defects: ${value.gained} gained, ${
                  value.lost
              } lost, ${
                  value.net
              } net. Paired dispatch cost delta: $${value.usdDelta.toFixed(
                  2,
              )}.`,
              `Inline coverage displaced: ${value.paired.reduce(
                  (n, c) => n + c.inlineDisplaced.length,
                  0,
              )} defect(s). Unpaired cases: ${
                  value.unpaired.join(", ") || "none"
              }. See the JSON value block for the per-case trade.`,
          ];
