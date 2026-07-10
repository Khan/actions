/**
 * Repeat aggregation over live A/B report artifacts (the tuning memo's
 * "repeat-aggregation report", rev-2 item 3). One live run resolves nothing
 * smaller than ~40 recall points (7-9 specs per arm), so any real measurement
 * pools repeats: this module reads N `live-ab-report.json` payloads (from N
 * dispatches of the same arm pair, or one `--repeats n` dispatch) and emits
 * per-case pass rates per arm with binomial (Wilson) intervals, plus the
 * pooled recall/verdict/noise rows. Every number in the memo's rev-2
 * cumulative section was computed by hand from the report JSONs; this makes
 * it one command.
 *
 * The core is deterministic (parsed JSON in, aggregate out) and unit-tested;
 * the CLI at the bottom is a thin shell that also accepts GitHub Actions run
 * ids (downloaded via `gh run download`).
 *
 * When every pooled report ran IDENTICAL arms (`--force-arms` wobble
 * controls, or the scheduled drift run on main), the two arms are 2N samples
 * of the same prompt, and the aggregate additionally reports per-metric
 * noise-floor bands (min/max/mean across arm-samples); the memo's "buy the
 * noise floor" item, rendered as data instead of prose.
 *
 * CLI:
 *
 *   pnpm dlx tsx workflows/review/eval/aggregate.ts <report.json | run-id>...
 *     [--out <path>]   JSON aggregate path (default out/live-ab-aggregate.json)
 *
 * A run id (all digits) is fetched with `gh run download <id> -n
 * live-ab-report`; local paths are read as-is. A source that cannot be
 * parsed is reported and skipped, never fatal: partial aggregation beats no
 * report (the plan's standing degrade rule).
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname} from "node:path";

/* -------------------------------------------------------------------------- */
/* The report subset this module consumes (structural, version-tolerant)      */
/* -------------------------------------------------------------------------- */

/** One case-run as it appears in a report's `arms.<arm>.runs[]`. */
export type SampleRun = {
    caseId: string;
    expectedVerdict: string;
    verdict: string;
    caughtSpecKeys: string[];
    /** Missed spec key -> drop bucket ("" for a true miss). */
    missedSpecs: {specKey: string; droppedBy?: string}[];
    unmatchedPosted: number;
    posted: number;
};

/** One arm-run: a single pass of one arm over its cases. */
export type ArmSample = {
    arm: "baseline" | "candidate";
    reviewMdSha: string;
    runs: SampleRun[];
    usd: number;
    judgeMeanQuality?: number;
};

/** One report artifact, reduced to what aggregation needs. */
export type ReportSample = {
    source: string;
    baseRef: string;
    baseline: ArmSample;
    candidate: ArmSample;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string =>
    typeof value === "string" ? value : "";

const asNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Parse one arm out of a raw report; throws a descriptive error on shape. */
const parseArm = (
    raw: unknown,
    arm: "baseline" | "candidate",
    reviewMdSha: string,
): ArmSample => {
    if (!isRecord(raw) || !Array.isArray(raw["runs"])) {
        throw new Error(`arms.${arm}.runs: missing or not an array`);
    }
    const runs = raw["runs"].map((run, i): SampleRun => {
        if (!isRecord(run)) {
            throw new Error(`arms.${arm}.runs[${i}]: not an object`);
        }
        const corpusCase = run["corpusCase"];
        const result = run["result"];
        const match = run["match"];
        if (!isRecord(corpusCase) || !isRecord(result) || !isRecord(match)) {
            throw new Error(
                `arms.${arm}.runs[${i}]: missing corpusCase/result/match`,
            );
        }
        const expected = isRecord(corpusCase["expected"])
            ? corpusCase["expected"]
            : {};
        const verdict = isRecord(result["verdict"]) ? result["verdict"] : {};
        const caught = Array.isArray(match["caught"]) ? match["caught"] : [];
        const missedDetail = Array.isArray(match["missedDetail"])
            ? match["missedDetail"]
            : [];
        // Older reports carry `missed` only; missedDetail supersedes it.
        const missed = Array.isArray(match["missed"]) ? match["missed"] : [];
        const detailKeys = new Set(
            missedDetail
                .filter(isRecord)
                .map((d) => asString(d["specKey"]))
                .filter((k) => k !== ""),
        );
        const missedSpecs = [
            ...missedDetail.filter(isRecord).map((d) => {
                const droppedBy = asString(d["droppedBy"]);
                return {
                    specKey: asString(d["specKey"]),
                    ...(droppedBy !== "" ? {droppedBy} : {}),
                };
            }),
            ...missed
                .filter(
                    (k): k is string =>
                        typeof k === "string" && !detailKeys.has(k),
                )
                .map((specKey) => ({specKey})),
        ];
        const unmatched = Array.isArray(match["unmatchedFindingIds"])
            ? match["unmatchedFindingIds"].length
            : 0;
        return {
            caseId: asString(corpusCase["id"]),
            expectedVerdict: asString(expected["verdict"]),
            verdict: asString(verdict["event"]),
            caughtSpecKeys: caught
                .filter(isRecord)
                .map((c) => asString(c["specKey"]))
                .filter((k) => k !== ""),
            missedSpecs,
            unmatchedPosted: unmatched,
            posted: asNumber(match["postedCount"]),
        };
    });
    const judge = raw["judge"];
    return {
        arm,
        reviewMdSha,
        runs,
        usd: asNumber(raw["usd"]),
        ...(isRecord(judge) && typeof judge["meanQuality"] === "number"
            ? {judgeMeanQuality: judge["meanQuality"]}
            : {}),
    };
};

/**
 * Extract the arm samples one report artifact contributes. A single-run
 * report contributes one sample pair; a `--repeats n` report contributes n; a
 * no-reviewable-delta report contributes none (recorded as skipped upstream).
 */
export const extractSamples = (
    source: string,
    raw: unknown,
): ReportSample[] => {
    if (!isRecord(raw)) {
        throw new Error("report: not a JSON object");
    }
    if (raw["noReviewableDelta"] === true) {
        return [];
    }
    // A --repeats artifact nests single-run reports under `repeats`.
    if (Array.isArray(raw["repeats"])) {
        return raw["repeats"].flatMap((repeat, i) =>
            extractSamples(`${source}#${i + 1}`, repeat),
        );
    }
    const arms = raw["arms"];
    const shas = raw["reviewMdSha"];
    if (!isRecord(arms)) {
        throw new Error("report: missing arms");
    }
    const sha = (key: string): string =>
        isRecord(shas) ? asString(shas[key]) : "";
    return [
        {
            source,
            baseRef: asString(raw["baseRef"]),
            baseline: parseArm(arms["baseline"], "baseline", sha("baseline")),
            candidate: parseArm(
                arms["candidate"],
                "candidate",
                sha("candidate"),
            ),
        },
    ];
};

/* -------------------------------------------------------------------------- */
/* Binomial interval                                                          */
/* -------------------------------------------------------------------------- */

export type RateStat = {
    numerator: number;
    denominator: number;
    rate: number;
    /** 95% Wilson score interval; [0,1] when the denominator is 0. */
    interval: {lo: number; hi: number};
};

/**
 * The Wilson score interval (95%, z=1.96): the standard binomial interval
 * that stays sane at the small n these runs live at (a 5/6 pass rate reads
 * 44-97%, not the Wald interval's overconfident nonsense).
 */
export const wilsonInterval = (
    successes: number,
    n: number,
): {lo: number; hi: number} => {
    if (n === 0) {
        return {lo: 0, hi: 1};
    }
    const z = 1.96;
    const p = successes / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
    return {lo: Math.max(0, center - half), hi: Math.min(1, center + half)};
};

export const rateStat = (numerator: number, denominator: number): RateStat => ({
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : numerator / denominator,
    interval: wilsonInterval(numerator, denominator),
});

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

export type SpecAggregate = {
    specKey: string;
    caught: RateStat;
    trueMisses: number;
    /** Drop bucket -> count, for found-but-dropped misses. */
    droppedBy: Record<string, number>;
};

export type CaseAggregate = {
    caseId: string;
    /** Arm-runs that scored this case (repeats the case appeared in). */
    runs: number;
    specs: SpecAggregate[];
    verdictOk: RateStat;
};

export type ArmAggregate = {
    arm: "baseline" | "candidate";
    /** Distinct review.md shas pooled (more than one is a pooling warning). */
    reviewMdShas: string[];
    samples: number;
    cases: CaseAggregate[];
    pooled: {
        recall: RateStat;
        verdictAgreement: RateStat;
        noise: RateStat;
        trueMisses: number;
        foundButDropped: Record<string, number>;
        usd: number;
    };
    /** Mean of per-sample judge means, when any sample carried one. */
    judgeMeanQuality?: number;
};

/**
 * Per-metric wobble bands over identical-arm samples (the noise floor).
 * Each band is computed across the 2N arm-samples of the same prompt.
 */
export type NoiseFloor = {
    armSamples: number;
    /** metric -> {min, max, mean} of the per-arm-sample rate. */
    bands: Record<string, {min: number; max: number; mean: number}>;
};

export type AggregateReport = {
    sources: string[];
    /** Sources that contributed nothing, with the reason. */
    skippedSources: {source: string; reason: string}[];
    samples: number;
    baseRefs: string[];
    arms: {baseline: ArmAggregate; candidate: ArmAggregate};
    /** Set iff every sample ran byte-identical arms. */
    noiseFloor?: NoiseFloor;
};

const aggregateArm = (
    arm: "baseline" | "candidate",
    samples: ArmSample[],
): ArmAggregate => {
    const byCase = new Map<
        string,
        {
            runs: number;
            verdictOk: number;
            specs: Map<
                string,
                {caught: number; seen: number; dropped: Map<string, number>}
            >;
        }
    >();
    let specCaught = 0;
    let specTotal = 0;
    let verdictOk = 0;
    let caseRuns = 0;
    let unmatched = 0;
    let posted = 0;
    let usd = 0;
    const judgeMeans: number[] = [];

    for (const sample of samples) {
        usd += sample.usd;
        if (sample.judgeMeanQuality !== undefined) {
            judgeMeans.push(sample.judgeMeanQuality);
        }
        for (const run of sample.runs) {
            const entry = byCase.get(run.caseId) ?? {
                runs: 0,
                verdictOk: 0,
                specs: new Map(),
            };
            entry.runs += 1;
            caseRuns += 1;
            if (run.verdict === run.expectedVerdict) {
                entry.verdictOk += 1;
                verdictOk += 1;
            }
            unmatched += run.unmatchedPosted;
            posted += run.posted;
            const spec = (key: string) => {
                const s = entry.specs.get(key) ?? {
                    caught: 0,
                    seen: 0,
                    dropped: new Map<string, number>(),
                };
                entry.specs.set(key, s);
                return s;
            };
            for (const key of run.caughtSpecKeys) {
                const s = spec(key);
                s.caught += 1;
                s.seen += 1;
                specCaught += 1;
                specTotal += 1;
            }
            for (const miss of run.missedSpecs) {
                const s = spec(miss.specKey);
                s.seen += 1;
                specTotal += 1;
                if (miss.droppedBy !== undefined) {
                    s.dropped.set(
                        miss.droppedBy,
                        (s.dropped.get(miss.droppedBy) ?? 0) + 1,
                    );
                }
            }
            byCase.set(run.caseId, entry);
        }
    }

    const cases: CaseAggregate[] = [...byCase.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([caseId, entry]) => ({
            caseId,
            runs: entry.runs,
            specs: [...entry.specs.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([specKey, s]) => {
                    const droppedBy = Object.fromEntries(
                        [...s.dropped.entries()].sort(([a], [b]) =>
                            a.localeCompare(b),
                        ),
                    );
                    const droppedCount = [...s.dropped.values()].reduce(
                        (sum, n) => sum + n,
                        0,
                    );
                    return {
                        specKey,
                        caught: rateStat(s.caught, s.seen),
                        trueMisses: s.seen - s.caught - droppedCount,
                        droppedBy,
                    };
                }),
            verdictOk: rateStat(entry.verdictOk, entry.runs),
        }));

    const foundButDropped: Record<string, number> = {};
    let trueMisses = 0;
    for (const c of cases) {
        for (const s of c.specs) {
            trueMisses += s.trueMisses;
            for (const [bucket, count] of Object.entries(s.droppedBy)) {
                foundButDropped[bucket] =
                    (foundButDropped[bucket] ?? 0) + count;
            }
        }
    }

    return {
        arm,
        reviewMdShas: [...new Set(samples.map((s) => s.reviewMdSha))].sort(),
        samples: samples.length,
        cases,
        pooled: {
            recall: rateStat(specCaught, specTotal),
            verdictAgreement: rateStat(verdictOk, caseRuns),
            noise: rateStat(unmatched, posted),
            trueMisses,
            foundButDropped,
            usd,
        },
        ...(judgeMeans.length > 0
            ? {
                  judgeMeanQuality:
                      judgeMeans.reduce((sum, m) => sum + m, 0) /
                      judgeMeans.length,
              }
            : {}),
    };
};

/** Per-arm-sample metric rates, for the noise-floor bands. */
const sampleRates = (sample: ArmSample): Record<string, number> => {
    let caught = 0;
    let specs = 0;
    let verdictOk = 0;
    let unmatched = 0;
    let posted = 0;
    for (const run of sample.runs) {
        caught += run.caughtSpecKeys.length;
        specs += run.caughtSpecKeys.length + run.missedSpecs.length;
        if (run.verdict === run.expectedVerdict) {
            verdictOk += 1;
        }
        unmatched += run.unmatchedPosted;
        posted += run.posted;
    }
    return {
        "must-catch recall": specs === 0 ? 0 : caught / specs,
        "verdict agreement":
            sample.runs.length === 0 ? 0 : verdictOk / sample.runs.length,
        "noise (unmatched posted)": posted === 0 ? 0 : unmatched / posted,
        ...(sample.judgeMeanQuality !== undefined
            ? {"judge mean quality": sample.judgeMeanQuality}
            : {}),
    };
};

/** Noise-floor bands across arm-samples (call only on identical-arm pools). */
export const computeNoiseFloor = (armSamples: ArmSample[]): NoiseFloor => {
    const bands: Record<string, {min: number; max: number; mean: number}> = {};
    const values = new Map<string, number[]>();
    for (const sample of armSamples) {
        for (const [metric, value] of Object.entries(sampleRates(sample))) {
            values.set(metric, [...(values.get(metric) ?? []), value]);
        }
    }
    for (const [metric, list] of values) {
        bands[metric] = {
            min: Math.min(...list),
            max: Math.max(...list),
            mean: list.reduce((sum, v) => sum + v, 0) / list.length,
        };
    }
    return {armSamples: armSamples.length, bands};
};

/**
 * Pool report samples into the aggregate. Sources that failed to parse are
 * carried in `skippedSources`; identical-arm pools additionally get the
 * noise-floor bands.
 */
export const aggregateSamples = (
    samples: ReportSample[],
    skippedSources: {source: string; reason: string}[] = [],
): AggregateReport => {
    const identicalArms =
        samples.length > 0 &&
        samples.every(
            (s) =>
                s.baseline.reviewMdSha !== "" &&
                s.baseline.reviewMdSha === s.candidate.reviewMdSha,
        );
    return {
        sources: [...new Set(samples.map((s) => s.source))],
        skippedSources,
        samples: samples.length,
        baseRefs: [...new Set(samples.map((s) => s.baseRef))].sort(),
        arms: {
            baseline: aggregateArm(
                "baseline",
                samples.map((s) => s.baseline),
            ),
            candidate: aggregateArm(
                "candidate",
                samples.map((s) => s.candidate),
            ),
        },
        ...(identicalArms
            ? {
                  noiseFloor: computeNoiseFloor(
                      samples.flatMap((s) => [s.baseline, s.candidate]),
                  ),
              }
            : {}),
    };
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

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

/**
 * The aggregate as a markdown report: a per-case table (spec catch rates and
 * verdict agreement, both arms, Wilson intervals), the pooled rows, and the
 * noise-floor bands when the pool was an identical-arm control.
 */
export const renderAggregateMarkdown = (report: AggregateReport): string => {
    const {baseline, candidate} = report.arms;
    const lines = [
        "## Review live A/B: repeat aggregation",
        "",
        `Pooled ${report.samples} run(s) per arm from: ${report.sources.join(
            ", ",
        )}.`,
        `Baseline review.md ${baseline.reviewMdShas
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
    if (report.skippedSources.length > 0) {
        lines.push(
            "Skipped sources (not pooled): " +
                report.skippedSources
                    .map((s) => `${s.source} (${s.reason})`)
                    .join("; "),
            "",
        );
    }

    lines.push(
        "| Case / spec | Baseline | 95% CI | Candidate | 95% CI | Miss classes |",
        "| --- | --- | --- | --- | --- | --- |",
    );
    const caseIds = [
        ...new Set([
            ...baseline.cases.map((c) => c.caseId),
            ...candidate.cases.map((c) => c.caseId),
        ]),
    ].sort();
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
            const notes = [
                ...(b && dropNote(b) !== "" ? [`base: ${dropNote(b)}`] : []),
                ...(c && dropNote(c) !== "" ? [`cand: ${dropNote(c)}`] : []),
            ];
            lines.push(
                `| ${caseId}:${specKey} | ${b ? statCell(b.caught) : "n/a"} | ${
                    b ? intervalCell(b.caught) : ""
                } | ${c ? statCell(c.caught) : "n/a"} | ${
                    c ? intervalCell(c.caught) : ""
                } | ${notes.join("; ")} |`,
            );
        }
        lines.push(
            `| ${caseId} (verdict) | ${
                base ? statCell(base.verdictOk) : "n/a"
            } | ${base ? intervalCell(base.verdictOk) : ""} | ${
                cand ? statCell(cand.verdictOk) : "n/a"
            } | ${cand ? intervalCell(cand.verdictOk) : ""} |  |`,
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
        "| Metric | Baseline | 95% CI | Candidate | 95% CI |",
        "| --- | --- | --- | --- | --- |",
        pooledRow("Must-catch recall", (a) => a.pooled.recall),
        pooledRow("Verdict agreement", (a) => a.pooled.verdictAgreement),
        pooledRow("Noise (unmatched posted)", (a) => a.pooled.noise),
        `| Misses (true / dropped) | ${dropSummary(
            baseline,
        )} |  | ${dropSummary(candidate)} |  |`,
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

    if (report.noiseFloor !== undefined) {
        lines.push(
            "### Noise floor (identical arms: every sample ran the same prompt)",
            "",
            `Bands across ${report.noiseFloor.armSamples} arm-samples of one review.md; ` +
                "any A/B delta inside a band is indistinguishable from " +
                "run-to-run wobble.",
            "",
            "| Metric | Min | Mean | Max | Spread |",
            "| --- | --- | --- | --- | --- |",
            ...Object.entries(report.noiseFloor.bands).map(
                ([metric, band]) =>
                    `| ${metric} | ${pct(band.min)} | ${pct(band.mean)} | ${pct(
                        band.max,
                    )} | ${pct(band.max - band.min)} |`,
            ),
            "",
        );
    }
    return lines.join("\n");
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const argValue = (argv: string[], flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
};

/** Resolve one CLI source (path or run id) to a parsed report payload. */
const readSource = (source: string): unknown => {
    if (/^\d+$/.test(source)) {
        const dir = mkdtempSync(`${tmpdir()}/live-ab-agg-`);
        execFileSync(
            "gh",
            ["run", "download", source, "-n", "live-ab-report", "-D", dir],
            {stdio: ["ignore", "inherit", "inherit"]},
        );
        return JSON.parse(readFileSync(`${dir}/live-ab-report.json`, "utf8"));
    }
    return JSON.parse(readFileSync(source, "utf8"));
};

const main = (): void => {
    const argv = process.argv.slice(2);
    const outPath = argValue(argv, "--out") ?? "out/live-ab-aggregate.json";
    const sources = argv.filter(
        (arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--out",
    );
    if (sources.length === 0) {
        throw new Error(
            "usage: aggregate.ts <report.json | run-id>... [--out <path>]",
        );
    }
    const samples: ReportSample[] = [];
    const skipped: {source: string; reason: string}[] = [];
    for (const source of sources) {
        try {
            const raw = readSource(source);
            const extracted = extractSamples(source, raw);
            if (extracted.length === 0) {
                skipped.push({source, reason: "no reviewable delta"});
            }
            samples.push(...extracted);
        } catch (error) {
            skipped.push({
                source,
                reason: String(error instanceof Error ? error.message : error),
            });
        }
    }
    const report = aggregateSamples(samples, skipped);
    const markdown = renderAggregateMarkdown(report);
    mkdirSync(dirname(outPath), {recursive: true});
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    writeFileSync(outPath.replace(/\.json$/, ".md"), `${markdown}\n`);
    console.log(markdown);
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath !== undefined && summaryPath !== "") {
        writeFileSync(summaryPath, `${markdown}\n`, {flag: "a"});
    }
    if (samples.length === 0) {
        console.error("no report contributed any samples");
        process.exit(1);
    }
};

// CLI entry point (mirrors live-ab.ts): run when executed, not imported.
if (process.argv[1]?.endsWith("aggregate.ts")) {
    try {
        main();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
