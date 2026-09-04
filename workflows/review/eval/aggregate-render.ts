/**
 * Markdown rendering for the live A/B aggregate (split out of `aggregate.ts`,
 * which keeps the parsing, the statistics, and the CLI): the per-arm rate
 * table with intervals, the per-spec catch and blocking rows, the noise-floor
 * bands, and the skipped-source footnote. Pure over `AggregateReport`.
 */

import type {
    AggregateReport,
    ArmAggregate,
    RateStat,
    SpecAggregate,
} from "./aggregate";
import {
    isSeveritySplit,
    severityTableNote,
    SEVERITY_SPLIT_NOTE,
} from "./aggregate-severity";

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

const statCell = (stat: RateStat): string =>
    `${stat.numerator}/${stat.denominator} (${pct(stat.rate)})`;

const intervalCell = (stat: RateStat): string =>
    `${pct(stat.interval.lo)}-${pct(stat.interval.hi)}`;

const dropNote = (spec: SpecAggregate): string => {
    const parts: string[] = [];
    if (spec.trueMisses > 0) {
        parts.push(`${spec.trueMisses} true miss`);
    }
    for (const [bucket, count] of Object.entries(spec.droppedBy)) {
        parts.push(`${count} dropped at ${bucket}`);
    }
    return parts.join(", ");
};

const splitNote = (spec: SpecAggregate): string =>
    isSeveritySplit(spec.blocking.numerator, spec.blocking.denominator)
        ? SEVERITY_SPLIT_NOTE
        : "";

/**
 * The aggregate as a markdown report: the noise-floor bands first when the
 * pool was an identical-arm control (they are that pool's product), then a
 * per-case table (spec catch rates, spec blocking rates, and verdict
 * agreement, both arms, Wilson intervals) and the pooled rows.
 *
 * Every row is **report-only**. Nothing here gates a run; the adversarial hard
 * gate in `gates.ts` is still the only thing that fails a job.
 */
export const renderAggregateMarkdown = (report: AggregateReport): string => {
    const {baseline, candidate} = report.arms;
    // `noiseFloor` is only computed for identical-arm pools (wobble controls
    // and the weekly drift run), so its presence IS the identical-arms
    // signal. Those reports relabel the arms: "baseline vs candidate" over
    // one prompt invites reading wobble as an A/B result, and the arm split
    // is arbitrary there.
    const identicalArms = report.noiseFloor !== undefined;
    const [armALabel, armBLabel] = identicalArms
        ? ["Arm A", "Arm B"]
        : ["Baseline", "Candidate"];
    const [armANote, armBNote] = identicalArms
        ? ["arm A", "arm B"]
        : ["base", "cand"];
    const lines = [
        identicalArms
            ? "## Review wobble control: repeat aggregation (identical arms)"
            : "## Review live A/B: repeat aggregation",
        "",
        `Pooled ${report.samples} run(s) per arm from: ${report.sources.join(
            ", ",
        )}.`,
        identicalArms
            ? `Every sample ran the same review.md (${baseline.reviewMdShas
                  .map((sha) => sha.slice(0, 12))
                  .join(", ")}): the arm split is arbitrary, and every ` +
              `between-arm delta below is run-to-run wobble, not a prompt ` +
              `effect.`
            : `Baseline review.md ${baseline.reviewMdShas
                  .map((sha) => sha.slice(0, 12))
                  .join(", ")}; candidate ${candidate.reviewMdShas
                  .map((sha) => sha.slice(0, 12))
                  .join(", ")}.`,
        "",
    ];
    if (baseline.reviewMdShas.length > 1 || candidate.reviewMdShas.length > 1) {
        lines.push(
            "**WARNING: pooled runs carry more than one review.md sha per " +
                "arm; these rates mix different prompts.**",
            "",
        );
    }
    if (report.matchers.length > 0 || report.corpusShas.length > 0) {
        lines.push(
            `Ruler: matcher ${report.matchers.join(", ") || "unstamped"}; ` +
                `corpus ${
                    report.corpusShas
                        .map((sha) => sha.slice(0, 12))
                        .join(", ") || "unstamped"
                }.`,
            "",
        );
    }
    if (report.matchers.length > 1 || report.corpusShas.length > 1) {
        lines.push(
            "**WARNING: pooled runs mix rulers (matcher config or corpus " +
                "content differ); rates are not comparable across them.**",
            "",
        );
    }
    if (report.skippedSources.length > 0) {
        lines.push(
            "Skipped or partial sources: " +
                report.skippedSources
                    .map((s) => `${s.source} (${s.reason})`)
                    .join("; "),
            "",
        );
    }

    // The noise-floor bands lead when present: on an identical-arm pool
    // they are the product, and everything below them is the raw material.
    if (report.noiseFloor !== undefined) {
        lines.push(
            "### Noise floor (identical arms: every sample ran the same prompt)",
            "",
            `Bands across ${report.noiseFloor.armSamples} arm-samples of one review.md; ` +
                "any A/B delta inside a band is indistinguishable from " +
                "run-to-run wobble. Min/max only widen as samples accumulate; " +
                "mean +/- sd is the band to track week to week.",
            "",
            ...(report.noiseFloor.caseAsymmetry
                ? [
                      "**WARNING: the samples did not all score the same " +
                          "case set (budget skips or mixed corpora), so " +
                          "these bands fold case-mix variance in on top of " +
                          "run-to-run wobble. Re-run with a budget that " +
                          "clears the full corpus before trusting them.**",
                      "",
                  ]
                : []),
            "| Metric | Min | Mean | Max | SD | Spread |",
            "| --- | --- | --- | --- | --- | --- |",
            ...Object.entries(report.noiseFloor.bands).map(
                ([metric, band]) =>
                    `| ${metric} | ${pct(band.min)} | ${pct(band.mean)} | ${pct(
                        band.max,
                    )} | ${pct(band.sd)} | ${pct(band.max - band.min)} |`,
            ),
            "",
        );
    }

    lines.push(
        ...severityTableNote(identicalArms),
        `| Case / spec | ${armALabel} | 95% CI | ${armBLabel} | 95% CI | Miss classes |`,
        "| --- | --- | --- | --- | --- | --- |",
    );
    const caseIds = [
        ...new Set([
            ...baseline.cases.map((c) => c.caseId),
            ...candidate.cases.map((c) => c.caseId),
        ]),
    ].sort();
    /** The four rate cells of one row: `A | A-CI | B | B-CI`. */
    const rateCells = (a: RateStat | undefined, b: RateStat | undefined) =>
        `${a ? statCell(a) : "n/a"} | ${a ? intervalCell(a) : ""} | ${
            b ? statCell(b) : "n/a"
        } | ${b ? intervalCell(b) : ""}`;
    /** The notes cell: each arm's note, prefixed with that arm's name. */
    const armNotes = (
        a: SpecAggregate | undefined,
        b: SpecAggregate | undefined,
        note: (spec: SpecAggregate) => string,
    ) =>
        [
            ...(a && note(a) !== "" ? [`${armANote}: ${note(a)}`] : []),
            ...(b && note(b) !== "" ? [`${armBNote}: ${note(b)}`] : []),
        ].join("; ");
    for (const caseId of caseIds) {
        const base = baseline.cases.find((c) => c.caseId === caseId);
        const cand = candidate.cases.find((c) => c.caseId === caseId);
        const specKeys = [
            ...new Set([
                ...(base?.specs.map((s) => s.specKey) ?? []),
                ...(cand?.specs.map((s) => s.specKey) ?? []),
            ]),
        ].sort();
        for (const specKey of specKeys) {
            const b = base?.specs.find((s) => s.specKey === specKey);
            const c = cand?.specs.find((s) => s.specKey === specKey);
            lines.push(
                `| ${caseId}:${specKey} | ${rateCells(
                    b?.caught,
                    c?.caught,
                )} | ${armNotes(b, c, dropNote)} |`,
            );
            // Severity row only when some catch carried a recorded label: a
            // pre-instrumentation pool gets no row, not a misleading 0/0.
            const labeled =
                (b?.blocking.denominator ?? 0) + (c?.blocking.denominator ?? 0);
            if (labeled > 0) {
                lines.push(
                    `| ${caseId}:${specKey} (blocking) | ${rateCells(
                        b?.blocking,
                        c?.blocking,
                    )} | ${armNotes(b, c, splitNote)} |`,
                );
            }
        }
        lines.push(
            `| ${caseId} (verdict) | ${rateCells(
                base?.verdictOk,
                cand?.verdictOk,
            )} |  |`,
        );
    }

    const pooledRow = (
        label: string,
        pick: (arm: ArmAggregate) => RateStat,
    ): string =>
        `| ${label} | ${statCell(pick(baseline))} | ${intervalCell(
            pick(baseline),
        )} | ${statCell(pick(candidate))} | ${intervalCell(pick(candidate))} |`;
    const dropSummary = (arm: ArmAggregate): string => {
        const buckets = Object.entries(arm.pooled.foundButDropped)
            .map(([bucket, count]) => `${count} ${bucket}`)
            .join(", ");
        return `${arm.pooled.trueMisses} true / ${
            buckets === "" ? "0 dropped" : buckets
        }`;
    };
    lines.push(
        "",
        "### Pooled",
        "",
        `| Metric | ${armALabel} | 95% CI | ${armBLabel} | 95% CI |`,
        "| --- | --- | --- | --- | --- |",
        pooledRow("Must-catch recall", (a) => a.pooled.recall),
        pooledRow("Verdict agreement", (a) => a.pooled.verdictAgreement),
        pooledRow("Noise (unmatched posted)", (a) => a.pooled.noise),
        `| Misses (true / dropped) | ${dropSummary(
            baseline,
        )} |  | ${dropSummary(candidate)} |  |`,
        `| Findings anchor-snapped | ${baseline.pooled.snapped} |  | ${candidate.pooled.snapped} |  |`,
        ...(baseline.judgeMeanQuality !== undefined &&
        candidate.judgeMeanQuality !== undefined
            ? [
                  `| Judge mean quality | ${baseline.judgeMeanQuality.toFixed(
                      2,
                  )} |  | ${candidate.judgeMeanQuality.toFixed(2)} |  |`,
              ]
            : []),
        `| Cost | $${baseline.pooled.usd.toFixed(
            2,
        )} |  | $${candidate.pooled.usd.toFixed(2)} |  |`,
        "",
    );

    return lines.join("\n");
};
