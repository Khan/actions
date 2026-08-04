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
import type {MergeVia} from "../lib/dedup";
import type {LiveCaseRun, LiveMetricsReport} from "./live-match";
import type {
    LiveDedupReport,
    LiveReconciliation,
    PerAgentReport,
} from "./live-producer";
import type {RereviewCaseScore, RereviewMetricsReport} from "./rereview-match";

export type ArmId = "baseline" | "candidate";

/** What an arm's producer must return per case (the produceLive subset). */
export type ArmProduceResult = {
    findings: RecordedFinding[];
    validation: CaseVerification[];
    perAgent: PerAgentReport[];
    /** The reconciler's decision, for open-PR (rereview) cases. */
    reconciliation?: LiveReconciliation;
    /** What the cross-source merge did (absent only for a stub producer). */
    dedup?: LiveDedupReport;
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
        /**
         * Findings the provenance gate anchor-snapped this run. The direct
         * observable for anchor fidelity: a prompt change that fixes
         * anchoring at the source (line-number-annotated diffs) shows up
         * here as candidate-arm snaps falling to zero.
         */
        snapped: number;
        /**
         * The cross-source merge, per case: `candidates` is the pre-merge claim
         * count, `merged` the claims it absorbed, and `clusterMerged` how many
         * of those copies tier 2 (the `claim-clusterer`) is what absorbed,
         * counted per copy since a `both` group absorbed some of its members on
         * the text floor. `rejected` counts proposed MEMBERS the merge rules
         * turned down, so one bad proposal naming three ids counts three.
         *
         * Read the duplicate rate from these, never from the posted set: merges
         * happen upstream of every drop the pipeline applies afterwards, and in
         * production autofix later satisfies surviving duplicates with one edit
         * and hides them. `clustererAbsent` marks the arm that never had tier 2
         * at all.
         */
        dedup?: {
            candidates: number;
            merged: number;
            clusterMerged: number;
            rejected: number;
            clustererAbsent: boolean;
            /**
             * The clusterer was dispatched on this case and returned nothing
             * usable. Reported separately because the failure and a clusterer
             * that ran and proposed nothing are the same zero in every other
             * column, and only one of them is a measurement.
             */
            clustererFailed?: true;
            /**
             * The clusterer's own spend and wall-clock on this case, absent
             * when it never ran. Tier 2 is a serial dispatch on nearly every
             * multi-finding review and absorbs a fraction of a group per run,
             * so its merge count alone cannot answer whether it earns its
             * place; these price the count.
             */
            clustererUsd?: number;
            clustererWallMs?: number;
            /**
             * The merged groups themselves, so a suspicious merge is
             * diagnosable from the artifact instead of from a repeat run: the
             * survivor, the claim ids absorbed into it, which tier found the
             * group, and (for a tier-2 group) the code element the clusterer
             * grounded the identity in.
             */
            groups: {
                survivor: string;
                absorbed: {id: string; via?: "clusterer"}[];
                via: MergeVia;
                evidence?: string;
            }[];
        };
        /** `<agent>: <reason>` per failed agent (diagnosable from the report). */
        failedAgents: string[];
        /**
         * The raw final text of each failed agent's last attempt, truncated.
         * The reason string alone cannot tell a prose answer from a refusal
         * from a truncated contract, which is what made runs 30592964392 and
         * 30596474354 cost ~$10 each to learn nothing new.
         */
        failedAgentOutputs?: {agent: string; output: string}[];
        /**
         * Tool calls per agent. The harness-parity signal: read it alongside
         * recall, because a loop that investigates less will otherwise read as
         * a weaker model.
         */
        toolCalls?: {agent: string; count: number}[];
        /**
         * Reviewers the case enabled that this arm's `review.md` does not
         * define, so the arm never had the dimension. Expected on the baseline
         * arm of a new-reviewer A/B, and reported so a missing dimension is
         * never read as a reviewer that ran and stayed quiet.
         */
        absentAgents?: string[];
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
    // Identical review.md in both arms only happens under `--force-arms`
    // (the runner short-circuits otherwise): a wobble control or the weekly
    // drift run, not an A/B. Say so up front; a report headed
    // "baseline vs candidate" over one prompt invites reading noise as a
    // result.
    const identicalArms =
        first !== undefined &&
        first.reviewMdSha.baseline === first.reviewMdSha.candidate;
    const lines = [
        identicalArms
            ? `## Review wobble control: ${report.repeatCount} repeats (identical arms)`
            : `## Review live A/B: ${report.repeatCount} repeats`,
        "",
        ...(first !== undefined
            ? [
                  identicalArms
                      ? `Both arms ran the same review.md (${first.reviewMdSha.baseline.slice(
                            0,
                            12,
                        )}, base \`${first.baseRef}\`): every between-arm ` +
                        `delta below is run-to-run wobble, not a prompt effect.`
                      : `Baseline: \`${
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
    const asymmetry = armAsymmetryLines(
        report.repeats.map((repeat) => repeat.arms),
    );
    if (asymmetry.length > 0) {
        lines.push(
            ASYMMETRY_HEADING,
            "",
            ...asymmetry.map((a) => `- ${a}`),
            "",
        );
    }
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

/**
 * Arm asymmetry is a caveat on the delta, not a failure: a reviewer only the
 * candidate arm defines makes its dimension pure gain by construction, which
 * the reader has to know before crediting the delta to a prompt change. Shared
 * by both renderers, and deduplicated, since a repeated run reports the same
 * absence once per repeat.
 */
const armAsymmetryLines = (
    pairs: readonly {baseline: ArmRunReport; candidate: ArmRunReport}[],
): string[] => [
    ...new Set(
        pairs.flatMap(({baseline, candidate}) =>
            (
                [
                    ["baseline", baseline],
                    ["candidate", candidate],
                ] as const
            ).flatMap(([arm, report]) =>
                report.perCase.flatMap((c) =>
                    (c.absentAgents ?? []).map(
                        (agent) =>
                            `${c.caseId}: \`${agent}\` is not defined in the ${arm} arm's review.md, so that arm ran without the dimension`,
                    ),
                ),
            ),
        ),
    ),
];

const ASYMMETRY_HEADING =
    "### Arm asymmetry (expected when the PR adds a reviewer)";

/** Total anchor-snaps across an arm's case runs (see `perCase.snapped`). */
const snappedTotal = (arm: ArmRunReport): number =>
    arm.perCase.reduce((sum, c) => sum + c.snapped, 0);

/**
 * The arm's cross-source merge rate: claims absorbed over claims produced,
 * with tier 2's share and any rejected cluster MEMBER in parentheses (one
 * proposal naming three ids that all fail is three). `tier 1 only`
 * marks an arm whose review.md defines no `claim-clusterer` — the expected
 * shape of the baseline in the A/B that graduates it, and the reason a zero in
 * the clusterer column there is asymmetry, not a negative result.
 *
 * Tier 2's share carries its PRICE beside it, because the two numbers are only
 * meaningful together: the dispatch precondition is satisfied by most
 * multi-finding reviews, so the steady state is a serial Sonnet call on nearly
 * every run, and "4 merges" is a graduation argument only next to what those
 * four merges cost. Tier 1 is free by comparison (pure text arithmetic), so no
 * price is shown for it.
 *
 * A dispatched clusterer that returned nothing usable is called out rather than
 * folded into the zero: the arm paid for it and measured nothing, which is not
 * the same claim as "tier 2 found no duplicates here".
 */
const mergedTotal = (arm: ArmRunReport): string => {
    const dedup = arm.perCase.flatMap((c) => (c.dedup ? [c.dedup] : []));
    if (dedup.length === 0) {
        return "n/a";
    }
    const sum = (pick: (d: typeof dedup[number]) => number): number =>
        dedup.reduce((total, d) => total + pick(d), 0);
    const absent = dedup.every((d) => d.clustererAbsent);
    const clustererUsd = sum((d) => d.clustererUsd ?? 0);
    const clustererWallMs = sum((d) => d.clustererWallMs ?? 0);
    const clustererFailures = sum((d) => (d.clustererFailed === true ? 1 : 0));
    const notes = [
        absent
            ? "tier 1 only"
            : `${sum(
                  (d) => d.clusterMerged,
              )} by clusterer at $${clustererUsd.toFixed(2)} / ${Math.round(
                  clustererWallMs / 1000,
              )}s`,
        ...(sum((d) => d.rejected) > 0
            ? [`${sum((d) => d.rejected)} proposed member(s) rejected`]
            : []),
        // A dispatched clusterer that returned nothing usable. Without this
        // the row reads "0 by clusterer at $0.32" — the arm paid, produced no
        // measurement, and the number that graduates the tier records it as a
        // negative result.
        ...(clustererFailures > 0
            ? [`${clustererFailures} clusterer failure(s)`]
            : []),
    ];
    return `${sum((d) => d.merged)} / ${sum((d) => d.candidates)} (${notes.join(
        ", ",
    )})`;
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
    // See renderMultiMarkdownReport: identical shas imply `--force-arms`.
    const identicalArms =
        report.reviewMdSha.baseline === report.reviewMdSha.candidate;
    const [armALabel, armBLabel] = identicalArms
        ? ["Arm A", "Arm B"]
        : ["Baseline", "Candidate"];
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
        identicalArms
            ? "## Review wobble control (identical arms)"
            : "## Review live A/B",
        "",
        identicalArms
            ? `Both arms ran the same review.md (${report.reviewMdSha.baseline.slice(
                  0,
                  12,
              )}, base \`${report.baseRef}\`): every between-arm delta ` +
              `below is run-to-run wobble, not a prompt effect.`
            : `Baseline: \`${
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
        `| Metric | ${armALabel} | ${armBLabel} | Delta |`,
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
        row(
            "Findings anchor-snapped",
            String(snappedTotal(baseline)),
            String(snappedTotal(candidate)),
        ),
        row(
            "Cross-source claims merged (of candidates)",
            mergedTotal(baseline),
            mergedTotal(candidate),
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
    // The raw final text of each failed agent, inline in the markdown. A
    // failure reason alone ("no parseable JSON object") sent two eval runs
    // chasing the wrong hypothesis; the text says immediately whether the
    // model answered in prose, refused, or was cut off mid-contract.
    const failedOutputs = [
        ...baseline.perCase.map((c) => ["baseline", c] as const),
        ...candidate.perCase.map((c) => ["candidate", c] as const),
    ].flatMap(([arm, c]) =>
        (c.failedAgentOutputs ?? []).map(
            (f) =>
                // Four backticks: a contract-parse failure is frequently a
                // code-fenced reply, and a triple-backtick payload would close
                // a triple-backtick fence early, breaking the <details>
                // pairing for every section after it.
                `<details><summary>${arm} / ${c.caseId} / ${f.agent}</summary>\n\n` +
                "````\n" +
                f.output +
                "\n````\n\n</details>",
        ),
    );
    const failedAgents = [...baseline.perCase, ...candidate.perCase].flatMap(
        (c) => c.failedAgents.map((agent) => `${c.caseId}: ${agent} failed`),
    );
    if (failedOutputs.length > 0) {
        lines.push(
            "### Raw output of each failed agent",
            "",
            ...failedOutputs,
            "",
        );
    }
    if (failedAgents.length > 0) {
        lines.push(
            "### Agent failures",
            "",
            ...failedAgents.map((f) => `- ${f}`),
            "",
        );
    }
    const asymmetry = armAsymmetryLines([{baseline, candidate}]);
    if (asymmetry.length > 0) {
        lines.push(
            ASYMMETRY_HEADING,
            "",
            ...asymmetry.map((a) => `- ${a}`),
            "",
        );
    }
    lines.push(STABILITY_FOOTER, "", NOISE_FLOOR_FOOTER, "");
    return lines.join("\n");
};
