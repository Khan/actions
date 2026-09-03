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
 *     [--cases <id,id,...>]   EXACT selection of live cases: bypasses
 *                             --smoke-only, and an id matching no live case
 *                             fails the run before any model spend
 *     [--smoke-only]          only live cases also tagged smoke (the per-PR
 *                             default in CI; a full-eval label lifts it);
 *                             scopes unscoped runs only — ignored when
 *                             --cases names the selection
 *     [--max-usd <n>]         total hard budget across both arms (default 40)
 *     [--no-judge]            skip judge quality scoring
 *     [--no-match-arbiter]    deterministic spec matching only (skip the
 *                             capped Haiku fallback arbiter on unmatched
 *                             specs; see match-arbiter.ts)
 *     [--stage-root <dir>]    staging root (default: a fresh temp dir)
 *     [--transcripts-dir <d>] where per-agent transcripts go (default
 *                             <tmpdir>/review-transcripts, outside the
 *                             staging root; see transcripts.ts)
 *     [--out <path>]          JSON report path (default out/live-ab-report.json)
 *     [--re-review-mode <m>]  re-review mode for the CANDIDATE arm on open-PR
 *                             (rereview) cases: full|scoped|flip-gated|fast.
 *                             The baseline always runs full, so the report
 *                             prices the mode dial (recall and dollars, same
 *                             prompt, mode the only difference). Default full.
 *     [--force-arms]          run both arms even when review.md is
 *                             byte-identical (a deliberate wobble control);
 *                             without it, identical arms short-circuit to a
 *                             "no reviewable delta" report at zero cost.
 *     [--repeats <n>]         run every selected case n times per arm in this
 *                             one dispatch and report pooled per-case pass
 *                             rates with binomial intervals (aggregate.ts)
 *                             instead of single-run percentages; the memo's
 *                             "targeted repeats" powered run (e.g. --cases
 *                             <the two anchor-fragile cases> --repeats 10).
 *                             The adversarial gate is decided by strict
 *                             majority across repeats (the repeat structure
 *                             replaces the single-run best-of-three retry).
 *                             Default 1 (single-run behavior, unchanged).
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname} from "node:path";

import {extractAgents} from "./agent-extract";
import {SMOKE_TAG, loadLiveCorpus, type CorpusCase} from "./corpus/loader";
import {aggregate, buildCorpusRequests, type JudgeModel} from "./judge";
import {liveJudge} from "./judge-live-model";
import {assembleReport, createCheckpointer} from "./live-ab-checkpoint";
import {
    adversarialGateFailures,
    diffRegressions,
    majorityGateFailures,
} from "./live-ab-gates";
import {readOverlayRates, type ModelTokens} from "../lib/pricing";
import {
    renderMarkdownReport,
    renderMultiMarkdownReport,
    type AbReport,
    type ArmId,
    type ArmProduce,
    type ArmRunReport,
    type GateRetry,
    type GateRetryAttempt,
} from "./live-ab-report";
import {
    caseLine,
    stderrLog,
    withDispatchProgress,
    type ProgressLog,
} from "./live-ab-progress";
import {
    computeLiveMetrics,
    matchCase,
    noiseCount,
    type LiveCaseRun,
    type MatchOptions,
} from "./live-match";
import {produceLive} from "./live-producer";
import {DEFAULT_TRANSCRIPTS_DIR, sdkRunner} from "./live-runner";
import {haikuMatchArbiter} from "./match-arbiter";
import {
    computeRereviewMetrics,
    scoreRereview,
    type RereviewCaseScore,
} from "./rereview-match";
import {runCase} from "./runner";
import {reviewMdHasAnchorSnap} from "../lib/provenance";
import {CLUSTERER} from "../lib/dispatch-cluster";
import type {ReReviewMode} from "../lib/routing-config";

// The report shapes and renderers live in ./live-ab-report, the deltas and
// gates in ./live-ab-gates, and the checkpoint writer in ./live-ab-checkpoint,
// re-exported so existing consumers keep one import surface for the runner.
export {renderMarkdownReport, renderMultiMarkdownReport};
export {adversarialGateFailures, diffRegressions, majorityGateFailures};
export {
    assembleReport,
    assembleMulti,
    createCheckpointer,
} from "./live-ab-checkpoint";
export type {
    AbReport,
    RunHeader,
    ArmId,
    ArmProduce,
    ArmProduceResult,
    ArmRunReport,
    GateMajority,
    GateRetry,
    GateRetryAttempt,
    MultiAbReport,
} from "./live-ab-report";

/* -------------------------------------------------------------------------- */
/* Case selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Select the cases a run scores. An explicit case list is an EXACT
 * selection: it bypasses the smoke scope (naming a non-smoke case in
 * `--cases` selects it; the smoke tag scopes only unscoped runs) and throws
 * on any id that matches no live case. A typo'd or non-live id must fail
 * the dispatch BEFORE any model spend — the alternative already happened:
 * the 2026-07-10 anchor-snap powered run named two cases, the smoke scope
 * silently dropped the non-smoke one, and the paid report covered half the
 * measurement without saying so. Requested order is preserved; duplicate
 * ids run once.
 */
export const selectCases = (
    allLive: CorpusCase[],
    options: {smokeOnly: boolean; caseFilter?: string[]},
): CorpusCase[] => {
    const {caseFilter} = options;
    if (caseFilter !== undefined) {
        const byId = new Map(allLive.map((c) => [c.id, c]));
        const unknown = caseFilter.filter((id) => !byId.has(id));
        if (unknown.length > 0) {
            throw new Error(
                `--cases: not in the live corpus: ${unknown.join(", ")} ` +
                    `(live case ids: ${allLive.map((c) => c.id).join(", ")})`,
            );
        }
        const seen = new Set<string>();
        return caseFilter.flatMap((id) => {
            if (seen.has(id)) {
                return [];
            }
            seen.add(id);
            const found = byId.get(id);
            return found === undefined ? [] : [found];
        });
    }
    return options.smokeOnly
        ? allLive.filter((c) => c.tags.includes(SMOKE_TAG))
        : [...allLive];
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
 *
 * `anchorSnap` sets the arm's provenance-gate emulation (see
 * {@link reviewMdHasAnchorSnap}): the deterministic pipeline is shared by
 * both arms, so the gate's anchor-snap fallback follows each arm's OWN
 * review.md version — the one deliberate exception to "everything but
 * review.md is the candidate's", and what lets the A/B price the snap change
 * itself (baseline pre-snap, candidate snapping).
 *
 * Every scored case prints one progress line (stderr, see
 * live-ab-progress.ts) and calls `onCase` with the arm's report so far, so
 * the caller can checkpoint: a run cancelled mid-arm must leave what it had
 * scored, not nothing.
 */
export const runArm = async (
    arm: ArmId,
    cases: CorpusCase[],
    produce: ArmProduce,
    options: {
        maxUsd: number;
        match?: MatchOptions;
        anchorSnap?: boolean;
        /** Progress sink, stderr by default. */
        log?: ProgressLog;
        /** Progress label, the arm id by default (a repeat passes
         * `baseline-r2` and the like). */
        label?: string;
        /** Called after every scored case with the arm's report so far. */
        onCase?: (soFar: ArmRunReport) => void | Promise<void>;
    },
): Promise<ArmRunReport> => {
    const started = Date.now();
    const runs: LiveCaseRun[] = [];
    const perCase: ArmRunReport["perCase"] = [];
    const skippedCases: string[] = [];
    const scoredRereviews: {caseId: string; score: RereviewCaseScore}[] = [];
    let usd = 0;
    let stopped = false;
    const log = options.log ?? stderrLog;
    const label = options.label ?? arm;
    const snapshot = (): ArmRunReport => ({
        arm,
        runs,
        metrics: computeLiveMetrics(runs),
        skippedCases,
        usd,
        wallMs: Date.now() - started,
        perCase,
        ...(scoredRereviews.length > 0
            ? {rereview: computeRereviewMetrics(scoredRereviews)}
            : {}),
    });

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
            ...(options.anchorSnap !== undefined
                ? {anchorSnap: options.anchorSnap}
                : {}),
        });
        const match = await matchCase(corpusCase, result, options.match);
        runs.push({corpusCase, result, match});

        // Open-PR (rereview) cases: score the reconciler's decision and the
        // fresh findings' duplicate rate against the case's ground truth.
        let rereviewScore: RereviewCaseScore | undefined;
        const rereview = corpusCase.live?.rereview;
        if (rereview !== undefined) {
            rereviewScore = scoreRereview(
                rereview,
                produced.reconciliation,
                produced.findings.map((recorded) => recorded.finding),
            );
            scoredRereviews.push({
                caseId: corpusCase.id,
                score: rereviewScore,
            });
        }

        const clusterer = produced.perAgent.find(
            (agent) => agent.name === CLUSTERER,
        );
        perCase.push({
            caseId: corpusCase.id,
            usd: caseUsd,
            verdict: result.verdict.event,
            expected: corpusCase.expected.verdict,
            caught: match.caught.length,
            missed: match.missed,
            posted: match.postedCount,
            noise: noiseCount(match),
            duplicates: match.duplicates.length,
            legitimateUnspecced: match.legitimateUnspecced.length,
            snapped: result.snappedByProvenance.length,
            ...(produced.dedup === undefined
                ? {}
                : {
                      dedup: {
                          candidates: produced.dedup.candidates,
                          merged: produced.dedup.merges.reduce(
                              (sum, merge) => sum + merge.merged.length,
                              0,
                          ),
                          // Counted per absorbed copy, not per group: a `both`
                          // group merged some of its members on the text floor
                          // and only the rest on the clusterer's word, and
                          // crediting the whole group to tier 2 would overstate
                          // the delta this arm is asked to justify.
                          clusterMerged: produced.dedup.merges.reduce(
                              (sum, merge) =>
                                  sum +
                                  merge.merged.filter(
                                      (copy) => copy.via === "clusterer",
                                  ).length,
                              0,
                          ),
                          rejected: produced.dedup.rejected.length,
                          clustererAbsent: produced.dedup.clustererAbsent,
                          // A dispatched clusterer that returned nothing
                          // usable, kept apart from one that ran and proposed
                          // nothing: both are zero merges, and only one of
                          // them is a result.
                          ...(produced.dedup.clustererFailed
                              ? {clustererFailed: true as const}
                              : {}),
                          // What tier 2 COST, beside what it merged. The
                          // clusterer is a serial step on nearly every
                          // multi-finding run while absorbing a fraction of a
                          // group per run, so a merge count alone cannot say
                          // whether it is worth dispatching; these two make the
                          // graduation decision a price per merge rather than a
                          // count. Read off the clusterer's own per-agent
                          // entry, so a run where it was skipped or absent
                          // contributes zero rather than nothing.
                          ...(clusterer === undefined
                              ? {}
                              : {
                                    clustererUsd: clusterer.usd,
                                    clustererWallMs: clusterer.wallMs,
                                }),
                          // The groups themselves, not just the count: the
                          // powered run that graduated tier 2 could see THAT 4
                          // claims merged but not WHICH, so auditing a
                          // suspicious merge meant paying for the run again.
                          // A false merge is the failure mode here, and it is
                          // only diagnosable from the ids and the evidence the
                          // clusterer grounded them in.
                          groups: produced.dedup.merges.map((merge) => ({
                              survivor: merge.survivor,
                              absorbed: merge.merged.map((copy) => ({
                                  id: copy.id,
                                  ...(copy.via !== undefined
                                      ? {via: copy.via}
                                      : {}),
                              })),
                              via: merge.via,
                              ...(merge.evidence !== undefined
                                  ? {evidence: merge.evidence}
                                  : {}),
                          })),
                      },
                  }),
            failedAgents: produced.perAgent
                .filter((a) => a.failed !== undefined)
                .map((a) => `${a.name}: ${a.failed}`),
            failedAgentOutputs: produced.perAgent
                .filter((a) => a.rawOutput !== undefined)
                .map((a) => ({agent: a.name, output: a.rawOutput as string})),
            toolCalls: produced.perAgent
                .filter((a) => a.toolCalls !== undefined)
                .map((a) => ({agent: a.name, count: a.toolCalls as number})),
            // The billed model, not the pin: a refusal fallback spent its
            // dollars on the model it fell back to. The tokens are what the
            // report prices at Khan's rate (pricing.ts). Absent reviewers
            // (a placeholder per dimension this arm's review.md lacks) never
            // dispatched, so they are not a cost and must not read as a
            // dispatch whose meter failed.
            agentCosts: produced.perAgent
                .filter((a) => a.absent !== true)
                .map((a) => ({
                    agent: a.name,
                    model: a.fellBackTo ?? a.model,
                    usd: a.usd,
                    ...(a.usage === undefined ? {} : {usage: a.usage}),
                })),
            deniedReads: produced.perAgent
                .filter((a) => (a.deniedReads ?? 0) > 0)
                .map((a) => ({agent: a.name, count: a.deniedReads as number})),
            deniedTools: produced.perAgent
                .filter((a) => (a.deniedTools ?? 0) > 0)
                .map((a) => ({agent: a.name, count: a.deniedTools as number})),
            absentAgents: produced.perAgent
                .filter((a) => a.absent === true)
                .map((a) => a.name),
            ...(rereviewScore !== undefined ? {rereview: rereviewScore} : {}),
        });
        log(
            caseLine(
                {arm: label},
                {
                    caseId: corpusCase.id,
                    verdict: result.verdict.event,
                    expected: corpusCase.expected.verdict,
                    caught: match.caught.map((c) => c.specKey),
                    missed: match.missed,
                    usd: caseUsd,
                },
                {usdSoFar: usd, done: runs.length, total: cases.length},
            ),
        );
        if (options.onCase !== undefined) {
            await options.onCase(snapshot());
        }
    }

    return snapshot();
};

/* -------------------------------------------------------------------------- */
/* Gate-flip retry                                                            */
/* -------------------------------------------------------------------------- */

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
    match?: MatchOptions,
    anchorSnap?: boolean,
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
            const agentCosts = produced.perAgent.map((a) => ({
                agent: a.name,
                model: a.fellBackTo ?? a.model,
                usd: a.usd,
                ...(a.usage === undefined ? {} : {usage: a.usage}),
            }));
            const result = runCase(corpusCase, {
                produceFindings: () => produced.findings,
                validation: produced.validation,
                ...(anchorSnap !== undefined ? {anchorSnap} : {}),
            });
            const matched = await matchCase(corpusCase, result, match);
            const attemptFailures = adversarialGateFailures({
                runs: [{corpusCase, result, match: matched}],
            });
            attempts.push({
                pass: attemptFailures.length === 0,
                failures: attemptFailures,
                usd,
                agentCosts,
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
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

const sha256 = (text: string): string =>
    createHash("sha256").update(text).digest("hex");

const judgeArm = async (
    report: ArmRunReport,
    judgeModel: JudgeModel,
): Promise<void> => {
    const requests = buildCorpusRequests(
        report.runs.map(({corpusCase, result}) => ({corpusCase, result})),
    );
    if (requests.length === 0) {
        return;
    }
    const scores = await judgeModel(requests);
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
    const transcriptsDir = argValue("--transcripts-dir");
    const caseFilter = argValue("--cases")
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
    const withJudge = !process.argv.includes("--no-judge");

    const reviewMdPath = "workflows/review/review.md";
    const baselineMd = execFileSync(
        "git",
        ["show", `${baseRef}:${reviewMdPath}`],
        {encoding: "utf8", maxBuffer: 64 * 1024 * 1024},
    );
    const candidateMd = readFileSync(reviewMdPath, "utf8");
    // The overlay is Khan's contract rate, not a prompt property, so the
    // working tree's review.md prices both arms.
    const khanRates = readOverlayRates(candidateMd);
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

    const cases = selectCases(loadLiveCorpus(), {
        smokeOnly: process.argv.includes("--smoke-only"),
        ...(caseFilter !== undefined ? {caseFilter} : {}),
    });
    if (cases.length === 0) {
        throw new Error("no live cases selected");
    }

    // The candidate arm's re-review mode on open-PR (rereview) cases; the
    // baseline always runs full, so a non-full flag prices the mode dial.
    const rawMode = argValue("--re-review-mode") ?? "full";
    if (!["full", "scoped", "flip-gated", "fast"].includes(rawMode)) {
        throw new Error(`unknown --re-review-mode "${rawMode}"`);
    }
    const candidateMode = rawMode as ReReviewMode;

    const repeats = Number(argValue("--repeats") ?? "1");
    if (!Number.isInteger(repeats) || repeats < 1) {
        throw new Error("--repeats must be a positive integer");
    }

    // The fallback match arbiter (Haiku, capped, same-file, audited via
    // `via: "fallback"`), on unless opted out: it only runs for specs the
    // deterministic matcher left unmatched, and an arbiter failure degrades
    // to a non-match. Both arms share the one matcher, so it never biases
    // the A/B delta.
    // The instrument's own token meter. Arms run one at a time, so a sink
    // that is swapped per arm attributes each arbiter and judge call to the
    // arm it scored. The report prices them beside the sub-agents' spend,
    // which they are otherwise invisible to (direct Messages API calls, no
    // dollars in the response).
    let arbiterSink: ModelTokens[] = [];
    let judgeSink: ModelTokens[] = [];
    const match: MatchOptions | undefined = process.argv.includes(
        "--no-match-arbiter",
    )
        ? undefined
        : {
              fallback: haikuMatchArbiter({
                  onError: (message) => console.error(message),
                  onUsage: (usage) => arbiterSink.push(usage),
              }),
          };
    const judgeModel = liveJudge({onUsage: (usage) => judgeSink.push(usage)});
    /** Close out an arm's meter: what the arbiter spent scoring it. */
    const meterArm = (arm: ArmRunReport): ArmRunReport => {
        arm.overhead = {judge: [], arbiter: arbiterSink};
        arbiterSink = [];
        return arm;
    };

    // Each arm's provenance gate emulates that arm's OWN review.md version:
    // the anchor-snap fallback is keyed on the marker the gate step carries
    // once it documents the rule. A baseline built from a pre-snap prompt
    // replays the pre-snap gate, so the snap change itself is priceable by
    // the A/B; once both prompts carry the rule, both arms snap and the A/B
    // is back to measuring prompt deltas alone.
    const armSnap = {
        baseline: reviewMdHasAnchorSnap(baselineMd),
        candidate: reviewMdHasAnchorSnap(candidateMd),
    };

    const runner = sdkRunner({
        ...(transcriptsDir !== undefined ? {transcriptsDir} : {}),
    });
    console.error(
        `transcripts under ${transcriptsDir ?? DEFAULT_TRANSCRIPTS_DIR}`,
    );
    const armProduce =
        (stage: string, markdown: string, mode: ReReviewMode): ArmProduce =>
        (corpusCase) =>
            produceLive(corpusCase, extractAgents(markdown), {
                // One stderr line per dispatch end, labeled with the arm
                // (plus repeat suffix) and case, see live-ab-progress.ts.
                runner: withDispatchProgress(runner, {
                    arm: stage,
                    caseId: corpusCase.id,
                }),
                stageDir: `${stageRoot}/${stage}/${corpusCase.id}`,
                reReviewMode: mode,
            });

    const judgeBothArms = async (
        baseline: ArmRunReport,
        candidate: ArmRunReport,
    ): Promise<void> => {
        if (!withJudge) {
            return;
        }
        // Judge scoring is additive: a failure here must degrade to a
        // report without quality scores, never kill a run whose arms have
        // already spent their budget (the plan's standing rule).
        for (const arm of [baseline, candidate]) {
            judgeSink = [];
            try {
                await judgeArm(arm, judgeModel);
            } catch (error) {
                arm.judgeError = String(
                    error instanceof Error ? error.message : error,
                );
                console.error(
                    `judge scoring failed on the ${arm.arm} arm: ${arm.judgeError}`,
                );
            } finally {
                // Committed whether or not scoring finished: a judge pass
                // that died after some calls still paid for those calls.
                if (arm.overhead !== undefined) {
                    arm.overhead.judge = judgeSink;
                }
            }
        }
    };

    // Rolling budget: each arm-run's slice is the REMAINING budget divided
    // by the arm-runs still to go. A runaway early arm still cannot starve
    // what follows (its slice is capped), but a cheap early arm donates its
    // headroom forward instead of stranding it; equal fixed slices caused
    // budget-skip asymmetry on the first noise-floor run (38/36 of 42
    // case-runs), which inflates the very bands that run existed to measure.
    const totalArmRuns = 2 * repeats;
    let armRunsDone = 0;
    let spentUsd = 0;
    const nextArmBudget = (): number =>
        Math.max(0, maxUsd - spentUsd) / (totalArmRuns - armRunsDone);
    const trackArm = (report: ArmRunReport): ArmRunReport => {
        armRunsDone += 1;
        spentUsd += report.usd;
        return report;
    };

    // The ruler stamp: which matcher and which corpus produced this
    // report's rates. Comparisons across runs are only valid when the stamp
    // matches (see ReportProvenance in live-ab-report.ts).
    // The matcher version rides on the stamp: v2 is the lens tie-break and
    // the leftover buckets (2026-09-03), so a pool mixing v1 and v2 reports
    // over one corpus warns as a mixed ruler rather than blending them.
    const provenance = {
        matcher:
            match !== undefined
                ? "deterministic-v2+arbiter"
                : "deterministic-v2",
        corpusSha: sha256(JSON.stringify(cases)),
        caseCount: cases.length,
    };

    const ckpt = createCheckpointer({
        outPath,
        repeats,
        khanRates,
        header: {
            baseRef,
            reviewMdSha: {
                baseline: sha256(baselineMd),
                candidate: sha256(candidateMd),
            },
            provenance,
        },
    });

    /**
     * One full arm pair. `suffix` isolates staging across repeats;
     * `withRetry` is the single-run best-of-three (a repeated run buys its
     * flake evidence from the repeat structure instead).
     */
    const runPair = async (
        suffix: string,
        withRetry: boolean,
    ): Promise<AbReport> => {
        const baseline = meterArm(
            trackArm(
                await runArm(
                    "baseline",
                    cases,
                    armProduce(`baseline${suffix}`, baselineMd, "full"),
                    {
                        maxUsd: nextArmBudget(),
                        anchorSnap: armSnap.baseline,
                        ...(match !== undefined ? {match} : {}),
                        label: `baseline${suffix}`,
                        onCase: ckpt.baselineCase,
                    },
                ),
            ),
        );
        const candidate = meterArm(
            trackArm(
                await runArm(
                    "candidate",
                    cases,
                    armProduce(
                        `candidate${suffix}`,
                        candidateMd,
                        candidateMode,
                    ),
                    {
                        maxUsd: nextArmBudget(),
                        anchorSnap: armSnap.candidate,
                        ...(match !== undefined ? {match} : {}),
                        label: `candidate${suffix}`,
                        onCase: ckpt.candidateCase(baseline),
                    },
                ),
            ),
        );

        // Retry the flip, not the run: a hard-gate flip re-runs only the
        // flipped cases (fresh staging per attempt so re-materializing
        // cannot collide), best of three, before the gate may fail the arm.
        // Retried runs are recorded but never replace the original in the
        // metrics.
        const gateRetries = withRetry
            ? await retryGateFlips(
                  candidate,
                  cases,
                  (attempt): ArmProduce =>
                      (corpusCase) =>
                          produceLive(corpusCase, extractAgents(candidateMd), {
                              runner: withDispatchProgress(runner, {
                                  arm: `candidate${suffix}-retry${attempt}`,
                                  caseId: corpusCase.id,
                              }),
                              stageDir: `${stageRoot}/candidate${suffix}-retry${attempt}/${corpusCase.id}`,
                          }),
                  match,
                  armSnap.candidate,
              )
            : [];
        // The retries re-match through the same arbiter, and that spend was on
        // the candidate's behalf.
        if (candidate.overhead !== undefined) {
            candidate.overhead.arbiter.push(...arbiterSink);
        }
        arbiterSink = [];

        await judgeBothArms(baseline, candidate);

        return assembleReport(ckpt.header, baseline, candidate, gateRetries);
    };

    if (repeats === 1) {
        ckpt.repeatDone(await runPair("", true));
    } else {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
            ckpt.repeatDone(await runPair(`-r${repeat}`, false));
        }
    }
    const {payload, markdown, candidateRunCount} = ckpt.finish();
    console.log(markdown);
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath !== undefined && summaryPath !== "") {
        writeFileSync(summaryPath, `${markdown}\n`, {flag: "a"});
    }

    if (candidateRunCount === 0) {
        console.error("no case was scored on the candidate arm");
        process.exit(1);
    }
    if (payload.adversarialFailures.length > 0) {
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
