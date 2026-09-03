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
 * Alongside catch rates it reports a per-spec **blocking rate** (catch rate
 * scores detection only): `./aggregate-severity` holds that metric's
 * vocabulary and the argument for it. Report-only, like every row here.
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

import {renderAggregateMarkdown} from "./aggregate-render";
import {caughtBlocking, SEVERITY_BAND_METRIC} from "./aggregate-severity";

// The markdown renderer lives in ./aggregate-render, re-exported so the CLI
// and every existing consumer keep one import surface.
export {renderAggregateMarkdown};

/* -------------------------------------------------------------------------- */
/* The report subset this module consumes (structural, version-tolerant)      */
/* -------------------------------------------------------------------------- */

/** One case-run as it appears in a report's `arms.<arm>.runs[]`. */
export type SampleRun = {
    caseId: string;
    expectedVerdict: string;
    verdict: string;
    caughtSpecKeys: string[];
    /**
     * Caught spec key -> whether the matching candidate blocked. Sparse on
     * purpose: an absent key means the report recorded no label, which is no
     * evidence rather than "non-blocking". See `./aggregate-severity`.
     */
    caughtSpecBlocking: Record<string, boolean>;
    /** Missed spec key -> drop bucket ("" for a true miss). */
    missedSpecs: {specKey: string; droppedBy?: string}[];
    unmatchedPosted: number;
    posted: number;
    /**
     * Findings the provenance gate anchor-snapped (0 for reports predating
     * the field). The anchor-fidelity observable: a prompt fix that anchors
     * correctly at the source drives this to zero.
     */
    snapped: number;
};

/** One arm-run: a single pass of one arm over its cases. */
export type ArmSample = {
    arm: "baseline" | "candidate";
    reviewMdSha: string;
    runs: SampleRun[];
    /** Cases never dispatched (budget skips); asymmetric samples bias bands. */
    skippedCount: number;
    usd: number;
    judgeMeanQuality?: number;
};

/** One report artifact, reduced to what aggregation needs. */
export type ReportSample = {
    source: string;
    baseRef: string;
    /**
     * Ruler provenance, when the report carries it (reports predating the
     * stamps parse with both undefined): the matcher configuration and a
     * content hash of the loaded corpus. Rates are only comparable across
     * runs whose ruler matches; the aggregate warns on a mixed pool.
     */
    matcher?: string;
    corpusSha?: string;
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
            // Only entries carrying the flag: a legacy report contributes no
            // severity samples rather than a run of `false`.
            caughtSpecBlocking: Object.fromEntries(
                caught
                    .filter(isRecord)
                    .filter((c) => typeof c["blocking"] === "boolean")
                    .map((c): [string, boolean] => [
                        asString(c["specKey"]),
                        c["blocking"] === true,
                    ])
                    .filter(([key]) => key !== ""),
            ),
            missedSpecs,
            unmatchedPosted: unmatched,
            posted: asNumber(match["postedCount"]),
            snapped: Array.isArray(result["snappedByProvenance"])
                ? result["snappedByProvenance"].length
                : 0,
        };
    });
    const judge = raw["judge"];
    return {
        arm,
        reviewMdSha,
        runs,
        skippedCount: Array.isArray(raw["skippedCases"])
            ? raw["skippedCases"].length
            : 0,
        usd: asNumber(raw["usd"]),
        ...(isRecord(judge) && typeof judge["meanQuality"] === "number"
            ? {judgeMeanQuality: judge["meanQuality"]}
            : {}),
    };
};

/**
 * Extract the arm samples one report artifact contributes: one pair for a
 * single-run report, its finished repeats for `--repeats n` (so the `partial`
 * check sits below the repeats branch), none for a no-reviewable-delta report
 * or a mid-run checkpoint (`partial`, whose arms scored different case sets).
 */
export const extractSamples = (
    source: string,
    raw: unknown,
): ReportSample[] => {
    if (!isRecord(raw)) {
        throw new Error("report: not a JSON object");
    }
    // A --repeats artifact nests single-run reports under `repeats`.
    if (Array.isArray(raw["repeats"])) {
        return raw["repeats"].flatMap((repeat, i) =>
            extractSamples(`${source}#${i + 1}`, repeat),
        );
    }
    // Nothing to pool: identical arms, or a checkpoint a run wrote mid-case.
    if (raw["noReviewableDelta"] === true || raw["partial"] === true) {
        return [];
    }
    const arms = raw["arms"];
    const shas = raw["reviewMdSha"];
    if (!isRecord(arms)) {
        throw new Error("report: missing arms");
    }
    const sha = (key: string): string =>
        isRecord(shas) ? asString(shas[key]) : "";
    const provenance = isRecord(raw["provenance"]) ? raw["provenance"] : {};
    const matcher = asString(provenance["matcher"]);
    const corpusSha = asString(provenance["corpusSha"]);
    return [
        {
            source,
            baseRef: asString(raw["baseRef"]),
            ...(matcher !== "" ? {matcher} : {}),
            ...(corpusSha !== "" ? {corpusSha} : {}),
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
    /**
     * Of the catches whose report recorded a label, how many were blocking.
     * Denominator is *labelled* catches, so a pre-instrumentation pool reads
     * `0/0` (the renderer omits the row) instead of 0%. Read against
     * {@link caught}: `caught 6/6, blocking 4/6` is a defect the reviewer
     * always finds and inconsistently blocks on.
     */
    blocking: RateStat;
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
        /** Total anchor-snapped findings across the arm's case-runs. */
        snapped: number;
        usd: number;
    };
    /** Mean of per-sample judge means, when any sample carried one. */
    judgeMeanQuality?: number;
};

/**
 * Per-metric wobble bands over identical-arm samples (the noise floor).
 * Each band is computed across the 2N arm-samples of the same prompt. Min
 * and max are extreme-value statistics (they only widen as samples
 * accumulate); mean plus/minus sd is the stable band to track week to week.
 */
export type NoiseFloor = {
    armSamples: number;
    /** metric -> spread of the per-arm-sample rate. */
    bands: Record<string, {min: number; max: number; mean: number; sd: number}>;
    /**
     * True when the samples did not all score the same case set (budget
     * skips, or pools mixing corpora). Asymmetric samples fold case-mix
     * variance into the bands, inflating them beyond pure run-to-run
     * wobble; the renderer surfaces this loudly because clean samples are
     * the entire point of an identical-arms run.
     */
    caseAsymmetry: boolean;
};

export type AggregateReport = {
    sources: string[];
    /** Sources that contributed nothing, with the reason. */
    skippedSources: {source: string; reason: string}[];
    samples: number;
    baseRefs: string[];
    /** Distinct ruler stamps across the pool (empty for legacy reports). */
    matchers: string[];
    corpusShas: string[];
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
                {
                    caught: number;
                    seen: number;
                    /** Catches whose report recorded a label. */
                    labeled: number;
                    /** Of those, catches that carried a blocking label. */
                    blocking: number;
                    dropped: Map<string, number>;
                }
            >;
        }
    >();
    let specCaught = 0;
    let specTotal = 0;
    let verdictOk = 0;
    let caseRuns = 0;
    let unmatched = 0;
    let posted = 0;
    let snapped = 0;
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
            snapped += run.snapped;
            const spec = (key: string) => {
                const s = entry.specs.get(key) ?? {
                    caught: 0,
                    seen: 0,
                    labeled: 0,
                    blocking: 0,
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
                // Absent (legacy report) is not evidence of non-blocking.
                const blocking = caughtBlocking(run.caughtSpecBlocking, key);
                if (blocking !== undefined) {
                    s.labeled += 1;
                    if (blocking) {
                        s.blocking += 1;
                    }
                }
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
                        blocking: rateStat(s.blocking, s.labeled),
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
            snapped,
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
    let blocking = 0;
    let labeled = 0;
    for (const run of sample.runs) {
        caught += run.caughtSpecKeys.length;
        specs += run.caughtSpecKeys.length + run.missedSpecs.length;
        if (run.verdict === run.expectedVerdict) {
            verdictOk += 1;
        }
        unmatched += run.unmatchedPosted;
        posted += run.posted;
        for (const key of run.caughtSpecKeys) {
            const specBlocking = caughtBlocking(run.caughtSpecBlocking, key);
            if (specBlocking !== undefined) {
                labeled += 1;
                if (specBlocking) {
                    blocking += 1;
                }
            }
        }
    }
    return {
        "must-catch recall": specs === 0 ? 0 : caught / specs,
        "verdict agreement":
            sample.runs.length === 0 ? 0 : verdictOk / sample.runs.length,
        "noise (unmatched posted)": posted === 0 ? 0 : unmatched / posted,
        // Omitted rather than zeroed when no catch carried a label: a 0% band
        // would read as "nothing ever blocks" (see ./aggregate-severity).
        ...(labeled > 0 ? {[SEVERITY_BAND_METRIC]: blocking / labeled} : {}),
        ...(sample.judgeMeanQuality !== undefined
            ? {"judge mean quality": sample.judgeMeanQuality}
            : {}),
    };
};

/** Noise-floor bands across arm-samples (call only on identical-arm pools). */
export const computeNoiseFloor = (armSamples: ArmSample[]): NoiseFloor => {
    const bands: NoiseFloor["bands"] = {};
    const values = new Map<string, number[]>();
    for (const sample of armSamples) {
        for (const [metric, value] of Object.entries(sampleRates(sample))) {
            values.set(metric, [...(values.get(metric) ?? []), value]);
        }
    }
    for (const [metric, list] of values) {
        const mean = list.reduce((sum, v) => sum + v, 0) / list.length;
        bands[metric] = {
            min: Math.min(...list),
            max: Math.max(...list),
            mean,
            // Population sd: the samples ARE the population being described,
            // and n is small enough that the n-1 debate is noise about noise.
            sd: Math.sqrt(
                list.reduce((sum, v) => sum + (v - mean) ** 2, 0) / list.length,
            ),
        };
    }
    // Case asymmetry: any budget skip, or samples scoring different case
    // sets (e.g. a pool mixing corpus versions), folds case-mix variance
    // into the bands.
    const caseIdSets = armSamples.map((sample) =>
        sample.runs
            .map((run) => run.caseId)
            .sort()
            .join(","),
    );
    const caseAsymmetry =
        armSamples.some((sample) => sample.skippedCount > 0) ||
        new Set(caseIdSets).size > 1;
    return {armSamples: armSamples.length, bands, caseAsymmetry};
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
        matchers: [
            ...new Set(
                samples
                    .map((s) => s.matcher)
                    .filter((m): m is string => m !== undefined),
            ),
        ].sort(),
        corpusShas: [
            ...new Set(
                samples
                    .map((s) => s.corpusSha)
                    .filter((c): c is string => c !== undefined),
            ),
        ].sort(),
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
            const partial = isRecord(raw) && raw["partial"] === true;
            if (extracted.length === 0) {
                skipped.push({
                    source,
                    reason: partial
                        ? "partial checkpoint (the run did not finish)"
                        : "no reviewable delta",
                });
            } else if (partial) {
                // A partial --repeats artifact pools its finished repeats
                // and nothing else. Say so, or the lower sample count reads
                // as a quieter week rather than a run that did not finish.
                skipped.push({
                    source,
                    reason: `partial: only ${extracted.length} finished repeat(s) pooled, the run did not finish`,
                });
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
