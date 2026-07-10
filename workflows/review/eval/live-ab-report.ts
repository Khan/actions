/**
 * The live A/B report shapes and their markdown rendering, split out of
 * `live-ab.ts` (which keeps the arm execution, gates, and CLI). This module
 * is a leaf: it depends only on types from the matcher/producer layers and
 * on the aggregation core, so the runner, its tests, and any future report
 * consumer can share the shapes without importing the CLI.
 */

import {renderAggregateMarkdown, type AggregateReport} from "./aggregate";
import type {
    CaseVerification,
    CorpusCase,
    RecordedFinding,
} from "./corpus/loader";
import type {LiveCaseRun, LiveMetricsReport} from "./live-match";
import type {LiveReconciliation, PerAgentReport} from "./live-producer";
import type {RereviewCaseScore, RereviewMetricsReport} from "./rereview-match";

export type ArmId = "baseline" | "candidate";

/** What an arm's producer must return per case (the produceLive subset). */
export type ArmProduceResult = {
    findings: RecordedFinding[];
    validation: CaseVerification[];
    perAgent: PerAgentReport[];
    /** The reconciler's decision, for open-PR (rereview) cases. */
    reconciliation?: LiveReconciliation;
};

export type ArmProduce = (corpusCase: CorpusCase) => Promise<ArmProduceResult>;

export type ArmRunReport = {
    arm: ArmId;
    runs: LiveCaseRun[];
    metrics: LiveMetricsReport;
    /** Case ids never dispatched because the budget ran out. */
    skippedCases: string[];
    usd: number;
    wallMs: number;
    perCase: {
        caseId: string;
        usd: number;
        verdict: string;
        expected: string;
        caught: number;
        missed: string[];
        /** `<agent>: <reason>` per failed agent (diagnosable from the report). */
        failedAgents: string[];
        /** Present iff the case is an open-PR (rereview) case. */
        rereview?: RereviewCaseScore;
    }[];
    /** Aggregated re-review scoring, when the corpus carried rereview cases. */
    rereview?: RereviewMetricsReport;
    judge?: {meanQuality: number; verdictCounts: Record<string, number>};
    /** Fixed-format note when judge scoring failed; metrics still stand. */
    judgeError?: string;
};

export type GateRetryAttempt = {
    pass: boolean;
    /** Gate failures this attempt produced (empty when pass). */
    failures: string[];
    usd: number;
};

export type GateRetry = {
    caseId: string;
    /** Re-run attempts, in order; the second is skipped once majority-fail is settled. */
    attempts: GateRetryAttempt[];
    /** True when 2 of 3 runs (original + retries) passed: a run-to-run flake. */
    settledPass: boolean;
};

/** One case's adversarial-gate outcome across a repeated run. */
export type GateMajority = {
    caseId: string;
    failedRepeats: number;
    repeats: number;
    /** Strict majority of repeats failed: a confirmed regression, not a flake. */
    confirmed: boolean;
};

/**
 * The ruler this report was scored with. Two runs are only comparable when
 * BOTH the prompt (reviewMdSha) and the ruler match: a matcher-config change
 * (arbiter on/off) or a corpus change moves every rate without the reviewer
 * changing at all. aggregate.ts warns when a pool mixes rulers, which is
 * what keeps the weekly drift series honest across instrument upgrades.
 */
export type ReportProvenance = {
    /** Matcher configuration: `deterministic` or `deterministic+arbiter`. */
    matcher: string;
    /** Content hash of the loaded corpus cases this run was scored against. */
    corpusSha: string;
    caseCount: number;
};

export type AbReport = {
    baseRef: string;
    reviewMdSha: {baseline: string; candidate: string};
    /** Absent only on artifacts predating the ruler stamp. */
    provenance?: ReportProvenance;
    arms: {baseline: ArmRunReport; candidate: ArmRunReport};
    regressions: {lost: string[]; gained: string[]};
    /** Confirmed failures only: flips settled as flakes by retry are removed. */
    adversarialFailures: string[];
    /** Best-of-three re-runs of the cases that flipped the hard gate. */
    gateRetries: GateRetry[];
};

/**
 * The `--repeats n` report: every repeat's full single-run report (so any
 * one repeat stays diagnosable and re-aggregatable), the pooled aggregate,
 * and the majority-decided gate. `aggregate.ts` recognises the `repeats`
 * field, so a multi-run artifact pools across dispatches like any other.
 */
export type MultiAbReport = {
    repeatCount: number;
    repeats: AbReport[];
    aggregate: AggregateReport;
    gate: GateMajority[];
    /** Cases failing the candidate gate in a strict majority of repeats. */
    adversarialFailures: string[];
};

export const renderMultiMarkdownReport = (report: MultiAbReport): string => {
    const first = report.repeats[0];
    const lines = [
        `## Review live A/B: ${report.repeatCount} repeats`,
        "",
        ...(first !== undefined
            ? [
                  `Baseline: \`${
                      first.baseRef
                  }\` (review.md ${first.reviewMdSha.baseline.slice(
                      0,
                      12,
                  )}); candidate: working tree (review.md ${first.reviewMdSha.candidate.slice(
                      0,
                      12,
                  )}).`,
                  "",
              ]
            : []),
        renderAggregateMarkdown(report.aggregate),
        "",
    ];
    if (report.gate.length === 0) {
        lines.push(
            "Adversarial hard gate: PASSED on the candidate arm in every repeat.",
            "",
        );
    } else {
        lines.push(
            "### Adversarial hard gate (strict majority over repeats)",
            "",
            ...report.gate.map(
                (g) =>
                    `- ${g.caseId}: failed ${g.failedRepeats}/${
                        g.repeats
                    } repeats: ${
                        g.confirmed
                            ? "FAILURE CONFIRMED"
                            : "minority flip, treated as run-to-run flake"
                    }`,
            ),
            "",
        );
    }
    return lines.join("\n");
};

/** `caseId:specKey` -> drop bucket, for every found-but-dropped miss. */
const dropClassByKey = (arm: ArmRunReport): Map<string, string> => {
    const map = new Map<string, string>();
    for (const {corpusCase, match} of arm.runs) {
        for (const detail of match.missedDetail) {
            if (detail.droppedBy !== undefined) {
                map.set(`${corpusCase.id}:${detail.specKey}`, detail.droppedBy);
            }
        }
    }
    return map;
};

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

/**
 * Which report rows a reader may act on from ONE run. Measured on the phase 4
 * acceptance pair: on the no-op control, recall, verdict agreement, the
 * regression lists, and the adversarial gate reproduced exactly while judge
 * quality moved 0.11 and noise 5 points on live-agent jitter alone; on the
 * weakened-reviewer arm, judge quality went UP 0.16 while recall fell 17
 * points (fewer, surer comments each score better). So judge quality is not
 * just jittery, it can move opposite to review health; recall against the
 * labeled specs is the load-bearing metric.
 */
const STABILITY_FOOTER =
    "*Single-run-stable rows: recall, verdict agreement, regressions, " +
    "adversarial gate. Judge quality and noise are not: they jitter " +
    "run-to-run at this corpus size, and a regressed reviewer can score " +
    "HIGHER on judge quality (fewer, surer comments each read better). " +
    "Recall against the labeled specs is the load-bearing metric.*";

/**
 * The measured run-to-run wobble of each report row, from IDENTICAL arms:
 * gh run 29069228968 (2026-07-10), `--force-arms --repeats 3` over the full
 * 14-case live corpus, i.e. 6 arm-samples of one review.md
 * (e55e2ace5c95..., deterministic matcher, pre-arbiter). Rendered into every
 * single-run report so a reader prices a delta against measured wobble, not
 * prose. The weekly drift run re-measures these bands (with the arbiter
 * active); update the constants when they move materially.
 */
export const MEASURED_NOISE_FLOOR = {
    provenance:
        "identical arms, run 29069228968, 2026-07-10, 6 arm-samples, " +
        "full corpus x3, pre-arbiter; budget skips left the samples on " +
        "unequal case sets, so these v1 bands also carry case-mix variance",
    bands: [
        {metric: "must-catch recall", min: 0.54, max: 0.86, sd: 0.1},
        {metric: "verdict agreement", min: 0.75, max: 1.0, sd: 0.09},
        {metric: "noise (unmatched posted)", min: 0.5, max: 0.6, sd: 0.03},
        {metric: "judge mean quality", min: 0.82, max: 0.86, sd: 0.02},
    ],
} as const;

const NOISE_FLOOR_FOOTER =
    "*Measured noise floor (" +
    MEASURED_NOISE_FLOOR.provenance +
    "): " +
    MEASURED_NOISE_FLOOR.bands
        .map((b) => `${b.metric} ${pct(b.min)}-${pct(b.max)} (sd ${pct(b.sd)})`)
        .join(", ") +
    ". A single-run delta whose arms both sit inside a band is " +
    "indistinguishable from run-to-run wobble; use `--repeats` to resolve " +
    "smaller effects.*";

export const renderMarkdownReport = (report: AbReport): string => {
    const {baseline, candidate} = report.arms;
    const row = (
        label: string,
        base: string,
        cand: string,
        delta = "",
    ): string => `| ${label} | ${base} | ${cand} | ${delta} |`;
    const metric = (
        label: string,
        pick: (arm: ArmRunReport) => number,
        format: (v: number) => string = pct,
    ): string =>
        row(
            label,
            format(pick(baseline)),
            format(pick(candidate)),
            (pick(candidate) - pick(baseline) >= 0 ? "+" : "") +
                format(pick(candidate) - pick(baseline)),
        );

    const lines = [
        "## Review live A/B",
        "",
        `Baseline: \`${
            report.baseRef
        }\` (review.md ${report.reviewMdSha.baseline.slice(0, 12)}); ` +
            `candidate: working tree (review.md ${report.reviewMdSha.candidate.slice(
                0,
                12,
            )}).`,
        "",
        ...(report.provenance !== undefined
            ? [
                  `Ruler: matcher ${report.provenance.matcher}; corpus ` +
                      `${report.provenance.corpusSha.slice(0, 12)} ` +
                      `(${report.provenance.caseCount} cases).`,
                  "",
              ]
            : []),
        "| Metric | Baseline | Candidate | Delta |",
        "| --- | --- | --- | --- |",
        metric("Must-catch recall", (a) => a.metrics.mustCatchRecall.rate),
        metric("Verdict agreement", (a) => a.metrics.verdictAgreement.rate),
        metric("Noise (unmatched posted)", (a) => a.metrics.noise.rate),
        row(
            "Clean false flags",
            String(baseline.metrics.cleanFalseFlag.count),
            String(candidate.metrics.cleanFalseFlag.count),
        ),
        ...(baseline.judge && candidate.judge
            ? [
                  row(
                      "Judge mean quality",
                      baseline.judge.meanQuality.toFixed(2),
                      candidate.judge.meanQuality.toFixed(2),
                      (candidate.judge.meanQuality -
                          baseline.judge.meanQuality >=
                      0
                          ? "+"
                          : "") +
                          (
                              candidate.judge.meanQuality -
                              baseline.judge.meanQuality
                          ).toFixed(2),
                  ),
              ]
            : []),
        row(
            "Cost",
            `$${baseline.usd.toFixed(2)}`,
            `$${candidate.usd.toFixed(2)}`,
        ),
        row(
            "Wall clock",
            `${Math.round(baseline.wallMs / 1000)}s`,
            `${Math.round(candidate.wallMs / 1000)}s`,
        ),
        row(
            "Cases run / skipped",
            `${baseline.runs.length} / ${baseline.skippedCases.length}`,
            `${candidate.runs.length} / ${candidate.skippedCases.length}`,
        ),
        ...(baseline.rereview || candidate.rereview
            ? [
                  row(
                      "Re-review thread resolution",
                      baseline.rereview
                          ? pct(baseline.rereview.resolutionAccuracy)
                          : "n/a",
                      candidate.rereview
                          ? pct(candidate.rereview.resolutionAccuracy)
                          : "n/a",
                  ),
                  row(
                      "Re-review flip-gate wrong / dup comments",
                      baseline.rereview
                          ? `${baseline.rereview.flipGateWrongCases.length} / ${baseline.rereview.duplicateComments}`
                          : "n/a",
                      candidate.rereview
                          ? `${candidate.rereview.flipGateWrongCases.length} / ${candidate.rereview.duplicateComments}`
                          : "n/a",
                  ),
              ]
            : []),
        row(
            "Misses found-but-dropped",
            String(dropClassByKey(baseline).size),
            String(dropClassByKey(candidate).size),
        ),
        "",
    ];

    // A regression that was PRODUCED and then died at a gate is a different
    // defect class (anchoring discipline, gate calibration) than a true miss
    // (recall); annotate each lost spec so it routes to the right fix.
    const candidateDrops = dropClassByKey(candidate);
    if (report.regressions.lost.length > 0) {
        lines.push(
            "### Regressions (baseline caught, candidate missed)",
            "",
            ...report.regressions.lost.map((key) => {
                const bucket = candidateDrops.get(key);
                return bucket === undefined
                    ? `- ${key} (not found)`
                    : `- ${key} (found but dropped at the ${bucket} gate)`;
            }),
            "",
        );
    }
    if (report.regressions.gained.length > 0) {
        lines.push(
            "### Improvements (candidate caught, baseline missed)",
            "",
            ...report.regressions.gained.map((key) => `- ${key}`),
            "",
        );
    }
    lines.push(
        report.adversarialFailures.length === 0
            ? "Adversarial hard gate: PASSED on the candidate arm."
            : [
                  "### Adversarial hard gate: FAILED on the candidate arm",
                  "",
                  ...report.adversarialFailures.map((f) => `- ${f}`),
              ].join("\n"),
        "",
    );
    if (report.gateRetries.length > 0) {
        lines.push(
            "### Gate flips retried (best of three, flipped cases only)",
            "",
            ...report.gateRetries.map((retry) => {
                const passes = retry.attempts.filter((a) => a.pass).length;
                const usd = retry.attempts.reduce((sum, a) => sum + a.usd, 0);
                const outcome = retry.settledPass
                    ? "settled as a run-to-run flake; the gate does not fail on this case"
                    : "failure confirmed";
                return `- ${retry.caseId}: original run failed, ${passes}/${
                    retry.attempts.length
                } retries passed; ${outcome} ($${usd.toFixed(2)} retry spend)`;
            }),
            "",
        );
    }
    const skipped = [
        ...baseline.skippedCases.map((id) => `baseline:${id}`),
        ...candidate.skippedCases.map((id) => `candidate:${id}`),
    ];
    if (skipped.length > 0) {
        lines.push(
            "### SKIPPED (budget exhausted before dispatch)",
            "",
            ...skipped.map((s) => `- ${s}`),
            "",
        );
    }
    const judgeErrors = [
        ...(baseline.judgeError !== undefined
            ? [`baseline: ${baseline.judgeError}`]
            : []),
        ...(candidate.judgeError !== undefined
            ? [`candidate: ${candidate.judgeError}`]
            : []),
    ];
    if (judgeErrors.length > 0) {
        lines.push(
            "### Judge scoring failed (metrics above still stand)",
            "",
            ...judgeErrors.map((e) => `- ${e}`),
            "",
        );
    }
    const failedAgents = [...baseline.perCase, ...candidate.perCase].flatMap(
        (c) => c.failedAgents.map((agent) => `${c.caseId}: ${agent} failed`),
    );
    if (failedAgents.length > 0) {
        lines.push(
            "### Agent failures",
            "",
            ...failedAgents.map((f) => `- ${f}`),
            "",
        );
    }
    lines.push(STABILITY_FOOTER, "", NOISE_FLOOR_FOOTER, "");
    return lines.join("\n");
};
