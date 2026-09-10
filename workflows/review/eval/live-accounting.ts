import type {CorpusCase} from "./corpus/loader";
import type {ArmProduceResult, ArmRunReport} from "./live-ab-report";
import type {CaseMatchReport} from "./live-match";
import type {RunOptions, RunResult} from "./runner";

export const scoringOptions = (
    corpusCase: CorpusCase,
    produced: ArmProduceResult,
): RunOptions => ({
    ...(produced.execution === undefined
        ? {}
        : {routing: produced.execution.routing}),
    posting: {
        depth: produced.execution?.depth ?? "full",
        nonBlockingInlineBudget:
            corpusCase.routerConfig?.["nonBlockingInlineBudget"],
        blockingOnly:
            corpusCase.routerConfig?.["reReviewBlockingOnly"] === true,
        blockingMedium:
            corpusCase.routerConfig?.["reReviewBlockingMedium"] === true,
    },
    unavailableReviewers: produced.perAgent
        .filter((a) => a.failed !== undefined || a.shed || a.absent)
        .map((a) => a.name),
});

export const accountLiveRun = (
    produced: ArmProduceResult,
    result: RunResult,
    match: CaseMatchReport,
) => {
    const byId = new Map(result.postedCandidates.map((c) => [c.id, c]));
    const inline = new Set(result.posting?.inlineIds ?? []);
    const useful = [...match.caught, ...match.legitimateUnspecced];
    // Both populations count finders only. Statuses below still cover every
    // modeled stage, so a validator/reconciler/clusterer failure stays incomplete.
    const planned =
        produced.execution === undefined
            ? []
            : [
                  ...produced.execution.roster.finders,
                  ...produced.execution.roster.shed.map((a) => a.name),
              ];
    return {
        coverage: {
            // This stamp covers modeled stages, not full workflow fidelity.
            omittedStages: produced.execution?.roster.triage
                ? ["pattern-triage"]
                : [],
            ...produced.execution,
            planned,
            dispatched: produced.perAgent
                .filter((a) => planned.includes(a.name) && !a.absent && !a.shed)
                .map((a) => a.name),
            shed: produced.perAgent.filter((a) => a.shed).map((a) => a.name),
            absent: produced.perAgent
                .filter((a) => a.absent)
                .map((a) => a.name),
            failed: produced.perAgent
                .filter((a) => a.failed !== undefined)
                .map((a) => a.name),
            complete:
                produced.execution !== undefined &&
                !produced.perAgent.some(
                    (a) => a.shed || a.absent || a.failed !== undefined,
                ),
        },
        posting: result.posting,
        usefulDefects: useful.map((hit) => {
            const ids = [
                hit.findingId,
                ...match.duplicates
                    .filter((d) => d.specKey === hit.specKey)
                    .map((d) => d.findingId),
            ];
            return {
                key: hit.specKey,
                findingIds: ids,
                postedSources: [
                    ...new Set(ids.flatMap((id) => byId.get(id)?.source ?? [])),
                ],
                // Merge attribution is a proposal, not independently validated credit.
                mergedProposalSources: [
                    ...new Set(
                        (produced.dedup?.merges ?? [])
                            .filter((m) => ids.includes(m.survivor))
                            .flatMap((m) => m.merged.map((c) => c.source)),
                    ),
                ],
                inline: ids.some((id) => inline.has(id)),
                collapsed: ids.some((id) => !inline.has(id)),
            };
        }),
    };
};

export type LiveAccounting = ReturnType<typeof accountLiveRun>;

export const coverageNote = (arm: ArmRunReport): string => {
    const incomplete = arm.perCase.filter(
        (c) => c.accounting?.coverage.complete !== true,
    );
    return (
        `${arm.arm}: ${incomplete.length}/${arm.perCase.length} scored cases have incomplete or unrecorded modeled-reviewer coverage` +
        incomplete
            .map(
                (c) =>
                    ` [${c.caseId}: shed ${
                        (c.accounting?.coverage.shed ?? []).join(",") || "none"
                    }, absent ${
                        (c.accounting?.coverage.absent ?? []).join(",") ||
                        "none"
                    }, failed ${
                        (c.accounting?.coverage.failed ?? []).join(",") ||
                        "none"
                    }]`,
            )
            .join("") +
        `. Skipped cases (not scored): ${arm.skippedCases.length} (${
            arm.skippedCases.join(", ") || "none"
        }).`
    );
};
