/**
 * The live A/B runner (`live-ab-plan.md` Phase 3b): run the model sub-agents
 * from TWO versions of `review.md` (the merge-base "baseline" and the working
 * tree "candidate") over the same live-enabled corpus, score both arms, and
 * emit a delta report.
 *
 * Everything else is the candidate's for both arms (corpus, `lib/`, runner,
 * metrics, judge): the A/B isolates the model-behavior seam, which is what a
 * prompt/model change moves. Report-only by design, with ONE exception: the
 * candidate arm must handle every adversarial-injection case outright (the
 * playbook's standing rule), or the process exits non-zero. A no-partial-credit
 * gate scored on one model run inherits the model's run-to-run variance, so a
 * gate flip is retried best-of-three on the flipped cases only (~one case of
 * spend per attempt, recorded in the report) before it fails the run.
 *
 * CLI (requires ANTHROPIC_API_KEY):
 *
 *   pnpm dlx tsx workflows/review/eval/live-ab.ts
 *     [--base-ref <ref>]      baseline review.md source (default: merge-base
 *                             of HEAD and origin/main)
 *     [--cases <id,id,...>]   subset of live cases (default: every live case)
 *     [--smoke-only]          only live cases also tagged smoke (the per-PR
 *                             default in CI; a full-eval label lifts it)
 *     [--max-usd <n>]         total hard budget across both arms (default 40)
 *     [--no-judge]            skip judge quality scoring
 *     [--stage-root <dir>]    staging root (default: a fresh temp dir)
 *     [--out <path>]          JSON report path (default out/live-ab-report.json)
 *     [--force-arms]          run both arms even when review.md is
 *                             byte-identical (a deliberate wobble control);
 *                             without it, identical arms short-circuit to a
 *                             "no reviewable delta" report at zero cost.
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname} from "node:path";

import {extractAgents} from "./agent-extract";
import {SMOKE_TAG, loadLiveCorpus, type CorpusCase} from "./corpus/loader";
import {aggregate, buildCorpusRequests} from "./judge";
import {liveJudgeModel} from "./judge-live-model";
import {
    computeLiveMetrics,
    matchCase,
    type LiveCaseRun,
    type LiveMetricsReport,
} from "./live-match";
import {produceLive, type PerAgentReport} from "./live-producer";
import {sdkRunner} from "./live-runner";
import {runCase} from "./runner";
import type {CaseVerification, RecordedFinding} from "./corpus/loader";

export type ArmId = "baseline" | "candidate";

/** What an arm's producer must return per case (the produceLive subset). */
export type ArmProduceResult = {
    findings: RecordedFinding[];
    validation: CaseVerification[];
    perAgent: PerAgentReport[];
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
    }[];
    judge?: {meanQuality: number; verdictCounts: Record<string, number>};
    /** Fixed-format note when judge scoring failed; metrics still stand. */
    judgeError?: string;
};

/* -------------------------------------------------------------------------- */
/* One arm                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run one arm over the cases under a hard budget. The budget is enforced
 * between cases: once spend plus the running per-case average would cross it,
 * the remaining cases are recorded as skipped and the arm still reports (a
 * run that dies at a cap with nothing emitted is the failure mode the plan
 * forbids).
 */
export const runArm = async (
    arm: ArmId,
    cases: CorpusCase[],
    produce: ArmProduce,
    options: {maxUsd: number},
): Promise<ArmRunReport> => {
    const started = Date.now();
    const runs: LiveCaseRun[] = [];
    const perCase: ArmRunReport["perCase"] = [];
    const skippedCases: string[] = [];
    let usd = 0;
    let stopped = false;

    for (const corpusCase of cases) {
        // The running per-case average estimates the next case's cost; once
        // spend plus that estimate crosses the cap, dispatch stops FOR GOOD
        // (spend never goes back down, so re-checking later cases would only
        // let a low average sneak one past the cap).
        const average = runs.length === 0 ? 0 : usd / runs.length;
        if (stopped || usd + average > options.maxUsd) {
            stopped = true;
            skippedCases.push(corpusCase.id);
            continue;
        }
        const produced = await produce(corpusCase);
        const caseUsd = produced.perAgent.reduce((sum, a) => sum + a.usd, 0);
        usd += caseUsd;

        const result = runCase(corpusCase, {
            produceFindings: () => produced.findings,
            validation: produced.validation,
        });
        const match = await matchCase(corpusCase, result);
        runs.push({corpusCase, result, match});
        perCase.push({
            caseId: corpusCase.id,
            usd: caseUsd,
            verdict: result.verdict.event,
            expected: corpusCase.expected.verdict,
            caught: match.caught.length,
            missed: match.missed,
            failedAgents: produced.perAgent
                .filter((a) => a.failed !== undefined)
                .map((a) => `${a.name}: ${a.failed}`),
        });
    }

    return {
        arm,
        runs,
        metrics: computeLiveMetrics(runs),
        skippedCases,
        usd,
        wallMs: Date.now() - started,
        perCase,
    };
};

/* -------------------------------------------------------------------------- */
/* Deltas and gates                                                           */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Gate-flip retry                                                            */
/* -------------------------------------------------------------------------- */

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

/**
 * Best-of-three retry over the cases that flipped the adversarial hard gate,
 * and ONLY those cases (the tuning memo's flake policy: retry the flip, not
 * the run). The original failing run counts as one fail, so a majority pass
 * needs both retries to pass; a first-retry fail settles the majority and the
 * second attempt is skipped. Retried runs never replace the original in the
 * arm's metrics (that would bias recall optimistically); they only decide
 * whether the gate treats the flip as a flake.
 */
export const retryGateFlips = async (
    candidate: ArmRunReport,
    cases: CorpusCase[],
    produceForAttempt: (attempt: number) => ArmProduce,
): Promise<GateRetry[]> => {
    const failures = adversarialGateFailures(candidate);
    const failingIds = [
        ...new Set(failures.map((f) => f.slice(0, f.indexOf(":")))),
    ];
    const retries: GateRetry[] = [];
    for (const caseId of failingIds) {
        const corpusCase = cases.find((c) => c.id === caseId);
        if (corpusCase === undefined) {
            continue;
        }
        const attempts: GateRetryAttempt[] = [];
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const produced = await produceForAttempt(attempt)(corpusCase);
            const usd = produced.perAgent.reduce((sum, a) => sum + a.usd, 0);
            const result = runCase(corpusCase, {
                produceFindings: () => produced.findings,
                validation: produced.validation,
            });
            const match = await matchCase(corpusCase, result);
            const attemptFailures = adversarialGateFailures({
                runs: [{corpusCase, result, match}],
            });
            attempts.push({
                pass: attemptFailures.length === 0,
                failures: attemptFailures,
                usd,
            });
            if (attemptFailures.length > 0) {
                break;
            }
        }
        retries.push({
            caseId,
            attempts,
            settledPass: attempts.length === 2 && attempts.every((a) => a.pass),
        });
    }
    return retries;
};

/* -------------------------------------------------------------------------- */
/* Report rendering                                                           */
/* -------------------------------------------------------------------------- */

export type AbReport = {
    baseRef: string;
    reviewMdSha: {baseline: string; candidate: string};
    arms: {baseline: ArmRunReport; candidate: ArmRunReport};
    regressions: {lost: string[]; gained: string[]};
    /** Confirmed failures only: flips settled as flakes by retry are removed. */
    adversarialFailures: string[];
    /** Best-of-three re-runs of the cases that flipped the hard gate. */
    gateRetries: GateRetry[];
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
    lines.push(STABILITY_FOOTER, "");
    return lines.join("\n");
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

const sha256 = (text: string): string =>
    createHash("sha256").update(text).digest("hex");

const judgeArm = async (report: ArmRunReport): Promise<void> => {
    const requests = buildCorpusRequests(
        report.runs.map(({corpusCase, result}) => ({corpusCase, result})),
    );
    if (requests.length === 0) {
        return;
    }
    const scores = await liveJudgeModel(requests);
    const judged = aggregate(requests, scores);
    // Only the quality aggregates are meaningful here: judge-vs-ground-truth
    // disagreement keys on recorded ids, which a live arm does not use.
    report.judge = {
        meanQuality: judged.meanQuality,
        verdictCounts: judged.verdictCounts,
    };
};

const main = async (): Promise<void> => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new Error("ANTHROPIC_API_KEY is required for a live A/B run.");
    }
    const baseRef =
        argValue("--base-ref") ??
        execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
            encoding: "utf8",
        }).trim();
    const maxUsd = Number(argValue("--max-usd") ?? "40");
    const outPath = argValue("--out") ?? "out/live-ab-report.json";
    const stageRoot =
        argValue("--stage-root") ?? mkdtempSync(`${tmpdir()}/review-ab-`);
    const caseFilter = argValue("--cases")?.split(",");
    const withJudge = !process.argv.includes("--no-judge");

    const reviewMdPath = "workflows/review/review.md";
    const baselineMd = execFileSync(
        "git",
        ["show", `${baseRef}:${reviewMdPath}`],
        {encoding: "utf8", maxBuffer: 64 * 1024 * 1024},
    );
    const candidateMd = readFileSync(reviewMdPath, "utf8");
    if (baselineMd === candidateMd && !process.argv.includes("--force-arms")) {
        // Pre-flight identity short-circuit (the tuning memo's first item):
        // byte-identical review.md means byte-identical extracted prompts and
        // orchestrator body, so both arms would do the same thing and the run
        // is pure spend. Post the no-delta verdict and run nothing.
        // `--force-arms` bypasses this for deliberate wobble controls (two
        // identical arms run to measure run-to-run variance).
        const sha = createHash("sha256")
            .update(candidateMd)
            .digest("hex")
            .slice(0, 12);
        const markdown = [
            "## Review live A/B",
            "",
            `No reviewable delta: review.md is byte-identical in both arms ` +
                `(baseline \`${baseRef}\`, sha ${sha}), so the extracted ` +
                `prompts and the orchestrator body match and no arms were ` +
                `run. Pass \`--force-arms\` for a deliberate wobble control.`,
            "",
        ].join("\n");
        mkdirSync(dirname(outPath), {recursive: true});
        writeFileSync(
            outPath,
            JSON.stringify({noReviewableDelta: true, baseRef, sha}, null, 2),
        );
        writeFileSync(outPath.replace(/\.json$/, ".md"), `${markdown}\n`);
        const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
        if (summaryPath) {
            writeFileSync(summaryPath, `${markdown}\n`, {flag: "a"});
        }
        console.log(markdown);
        return;
    }

    const allCases = loadLiveCorpus().filter(
        (c) =>
            !process.argv.includes("--smoke-only") ||
            c.tags.includes(SMOKE_TAG),
    );
    const cases =
        caseFilter === undefined
            ? allCases
            : allCases.filter((c) => caseFilter.includes(c.id));
    if (cases.length === 0) {
        throw new Error("no live cases selected");
    }

    const runner = sdkRunner();
    const armProduce =
        (arm: ArmId, markdown: string): ArmProduce =>
        (corpusCase) =>
            produceLive(corpusCase, extractAgents(markdown), {
                runner,
                stageDir: `${stageRoot}/${arm}/${corpusCase.id}`,
            });

    // Sequential arms, halving the budget, so a runaway baseline cannot
    // starve the candidate.
    const baseline = await runArm(
        "baseline",
        cases,
        armProduce("baseline", baselineMd),
        {maxUsd: maxUsd / 2},
    );
    const candidate = await runArm(
        "candidate",
        cases,
        armProduce("candidate", candidateMd),
        {maxUsd: maxUsd / 2},
    );

    // Retry the flip, not the run: a hard-gate flip re-runs only the flipped
    // cases (fresh staging per attempt so re-materializing cannot collide),
    // best of three, before the gate may fail the arm. Retried runs are
    // recorded but never replace the original in the metrics.
    const gateRetries = await retryGateFlips(
        candidate,
        cases,
        (attempt): ArmProduce =>
            (corpusCase) =>
                produceLive(corpusCase, extractAgents(candidateMd), {
                    runner,
                    stageDir: `${stageRoot}/candidate-retry${attempt}/${corpusCase.id}`,
                }),
    );
    const flakes = new Set(
        gateRetries.filter((r) => r.settledPass).map((r) => r.caseId),
    );

    if (withJudge) {
        // Judge scoring is additive: a failure here must degrade to a
        // report without quality scores, never kill a run whose arms have
        // already spent their budget (the plan's standing rule).
        for (const arm of [baseline, candidate]) {
            try {
                await judgeArm(arm);
            } catch (error) {
                arm.judgeError = String(
                    error instanceof Error ? error.message : error,
                );
                console.error(
                    `judge scoring failed on the ${arm.arm} arm: ${arm.judgeError}`,
                );
            }
        }
    }

    const report: AbReport = {
        baseRef,
        reviewMdSha: {
            baseline: sha256(baselineMd),
            candidate: sha256(candidateMd),
        },
        arms: {baseline, candidate},
        regressions: diffRegressions(baseline, candidate),
        adversarialFailures: adversarialGateFailures(candidate).filter(
            (failure) => !flakes.has(failure.slice(0, failure.indexOf(":"))),
        ),
        gateRetries,
    };

    mkdirSync(dirname(outPath), {recursive: true});
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    const markdown = renderMarkdownReport(report);
    // A sibling .md rides along for CI's sticky PR comment.
    writeFileSync(outPath.replace(/\.json$/, ".md"), `${markdown}\n`);
    console.log(markdown);
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath !== undefined && summaryPath !== "") {
        writeFileSync(summaryPath, `${markdown}\n`, {flag: "a"});
    }

    if (candidate.runs.length === 0) {
        console.error("no case was scored on the candidate arm");
        process.exit(1);
    }
    if (report.adversarialFailures.length > 0) {
        console.error("adversarial hard gate FAILED on the candidate arm");
        process.exit(1);
    }
};

// CLI entry point (mirrors live-runner.ts): run when executed, not imported.
if (process.argv[1]?.endsWith("live-ab.ts")) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
