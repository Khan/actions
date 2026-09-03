/**
 * Report assembly and the per-case checkpoint writer for the live A/B (split
 * out of `live-ab.ts`, which keeps the arm execution and CLI). Everything
 * here is pure over report shapes plus two file writes, so a test can drive
 * it with `runArm` and a stub producer and read the files back.
 */

import {mkdirSync, renameSync, writeFileSync} from "node:fs";
import {basename, dirname, join} from "node:path";

import {aggregateSamples, extractSamples} from "./aggregate";
import {
    adversarialGateFailures,
    diffRegressions,
    majorityGateFailures,
} from "./live-ab-gates";
import {
    renderMarkdownReport,
    renderMultiMarkdownReport,
    type AbReport,
    type ArmId,
    type ArmRunReport,
    type GateRetry,
    type MultiAbReport,
    type RunHeader,
} from "./live-ab-report";
import {computeLiveMetrics} from "./live-match";
import type {RateCard} from "./pricing";

/** The single-run report over two arms. `gateRetries` is empty until the
 * best-of-three has run, so a checkpoint never has any. */
export const assembleReport = (
    header: RunHeader,
    baseline: ArmRunReport,
    candidate: ArmRunReport,
    gateRetries: GateRetry[],
): AbReport => {
    const flakes = new Set(
        gateRetries.filter((r) => r.settledPass).map((r) => r.caseId),
    );
    return {
        ...header,
        arms: {baseline, candidate},
        regressions: diffRegressions(baseline, candidate),
        adversarialFailures: adversarialGateFailures(candidate).filter(
            (failure) => !flakes.has(failure.slice(0, failure.indexOf(":"))),
        ),
        gateRetries,
    };
};

/**
 * The `--repeats n` report over the repeats so far. Partial until every
 * repeat is in and finished: `aggregate.ts` skips a partial repeat when
 * pooling, and the gate is decided over the finished repeats only.
 */
export const assembleMulti = (
    repeatCount: number,
    reports: AbReport[],
): MultiAbReport => {
    const finished = reports.filter((r) => r.partial !== true);
    const gate = majorityGateFailures(
        finished.map((report) => report.arms.candidate),
    );
    return {
        repeatCount,
        repeats: reports,
        // The repeat reports are already the artifact shape aggregate.ts
        // pools, so the one-dispatch powered run and the N-dispatch drift
        // pool go through the identical code path.
        aggregate: aggregateSamples(
            reports.flatMap((report, i) =>
                extractSamples(`repeat-${i + 1}`, report),
            ),
        ),
        gate,
        adversarialFailures: gate
            .filter((g) => g.confirmed)
            .map(
                (g) =>
                    `${g.caseId}: failed ${g.failedRepeats}/${g.repeats} repeats`,
            ),
        ...(finished.length < repeatCount ? {partial: true as const} : {}),
    };
};

/** An arm that has not started: the candidate's stand-in while the baseline
 * arm is still running, so a checkpoint has the full two-arm shape. */
const emptyArm = (arm: ArmId): ArmRunReport => ({
    arm,
    runs: [],
    metrics: computeLiveMetrics([]),
    skippedCases: [],
    usd: 0,
    wallMs: 0,
    perCase: [],
});

/**
 * The report writer. Checkpoints after every scored case: a live run carries
 * tens of dollars of spend over an hour or more, and a cancellation or
 * timeout on case n must not forfeit cases 1..n-1 (a run that dies with
 * nothing emitted is the failure mode the plan forbids). Run 33802457289
 * was cancelled 45 minutes in by a stray label event and left no file for
 * the always() upload to carry. Every checkpoint is marked `partial` in the
 * JSON and the markdown header, and `finish` replaces it with the full report.
 */
export const createCheckpointer = (options: {
    outPath: string;
    repeats: number;
    header: RunHeader;
    /** Khan's rate card (pricing.ts); every render prices with it. */
    khanRates?: RateCard;
}): {
    header: RunHeader;
    /** `runArm`'s `onCase` for the baseline arm of the current repeat. */
    baselineCase: (soFar: ArmRunReport) => void;
    /** `runArm`'s `onCase` for the candidate arm, given the finished
     * baseline arm it pairs with. */
    candidateCase: (baseline: ArmRunReport) => (soFar: ArmRunReport) => void;
    /** A repeat's arms, retries, and judge are all in. */
    repeatDone: (report: AbReport) => void;
    /** Write the final report and return it for stdout and the exit code. */
    finish: () => {
        payload: AbReport | MultiAbReport;
        markdown: string;
        candidateRunCount: number;
    };
} => {
    const {outPath, repeats, header} = options;
    const render = {khanRates: options.khanRates};
    const finished: AbReport[] = [];
    // Stage and rename: a cancel that lands mid-write must not truncate the
    // very file the checkpoint exists to preserve (rename is atomic on the
    // same filesystem). The staging file is a dotfile beside its target so
    // CI's `live-ab-report.*` artifact glob never picks up a torn one.
    const put = (path: string, text: string): void => {
        const staging = join(dirname(path), `.${basename(path)}.tmp`);
        writeFileSync(staging, text);
        renameSync(staging, path);
    };
    const write = (payload: AbReport | MultiAbReport, markdown: string) => {
        mkdirSync(dirname(outPath), {recursive: true});
        put(outPath, JSON.stringify(payload, null, 2));
        // A sibling .md rides along for CI's sticky PR comment.
        put(outPath.replace(/\.json$/, ".md"), `${markdown}\n`);
    };
    const single = (report: AbReport): void => {
        write(report, renderMarkdownReport(report, render));
    };
    const multi = (reports: AbReport[]): MultiAbReport => {
        const report = assembleMulti(repeats, reports);
        write(report, renderMultiMarkdownReport(report, render));
        return report;
    };
    const checkpoint = (inProgress: AbReport): void => {
        if (repeats === 1) {
            single(inProgress);
        } else {
            multi([...finished, inProgress]);
        }
    };
    return {
        header,
        baselineCase: (soFar) =>
            checkpoint({
                ...assembleReport(header, soFar, emptyArm("candidate"), []),
                partial: true,
            }),
        candidateCase: (baseline) => (soFar) =>
            checkpoint({
                ...assembleReport(header, baseline, soFar, []),
                partial: true,
            }),
        repeatDone: (report) => {
            finished.push(report);
            // The per-case checkpoints cover the arms mid-repeat. This one
            // carries the judge scores the finished repeat just gained.
            if (repeats > 1) {
                multi(finished);
            }
        },
        finish: () => {
            const candidateRunCount = finished.reduce(
                (sum, report) => sum + report.arms.candidate.runs.length,
                0,
            );
            const [only] = finished;
            if (repeats === 1 && only !== undefined) {
                single(only);
                return {
                    payload: only,
                    markdown: renderMarkdownReport(only, render),
                    candidateRunCount,
                };
            }
            const report = multi(finished);
            return {
                payload: report,
                markdown: renderMultiMarkdownReport(report, render),
                candidateRunCount,
            };
        },
    };
};
