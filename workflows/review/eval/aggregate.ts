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

import {
    caughtBlocking,
    isSeveritySplit,
    severityTableNote,
    SEVERITY_BAND_METRIC,
    SEVERITY_SPLIT_NOTE,
} from "./aggregate-severity";
import {
    extractSamples,
    type ArmSample,
    type ReportSample,
} from "./aggregate-extract";
import {rateStat, type RateStat} from "./wilson";

/* -------------------------------------------------------------------------- */
/* The report subset this module consumes (structural, version-tolerant)      */
/* -------------------------------------------------------------------------- */

export {
    extractSamples,
    type ArmSample,
    type ReportSample,
    type SampleRun,
} from "./aggregate-extract";

/* -------------------------------------------------------------------------- */
/* Binomial interval                                                          */
/* -------------------------------------------------------------------------- */

export {rateStat, wilsonInterval, type RateStat} from "./wilson";

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
        /** Of the noise numerator, second copies of an already-claimed defect. */
        duplicates: number;
        /** May-flag matches over posted: legitimate unspecced findings. */
        legitimateUnspecced: RateStat;
        /**
         * Case-runs whose case carries `mayFlagSpecs`, over all case-runs.
         * Only those can move a finding into the row above; the rest still
         * read the pre-audit noise definition.
         */
        auditedRuns: number;
        caseRuns: number;
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
    let duplicates = 0;
    let legitimateUnspecced = 0;
    let auditedRuns = 0;
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
            duplicates += run.duplicates;
            legitimateUnspecced += run.legitimateUnspecced;
            if (run.audited) {
                auditedRuns += 1;
            }
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
            duplicates,
            legitimateUnspecced: rateStat(legitimateUnspecced, posted),
            auditedRuns,
            caseRuns,
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

/** Distinct ruler values, with "unstamped" added iff only some are set. */
const rulerValues = (values: (string | undefined)[]): string[] => {
    const set = new Set(values.filter((v): v is string => v !== undefined));
    if (set.size > 0 && values.some((v) => v === undefined)) {
        set.add("unstamped");
    }
    return [...set].sort();
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
        // A pool that mixes stamped and unstamped reports lists "unstamped"
        // as a second ruler value, so the mixed-ruler warning fires; an
        // all-unstamped pool stays silent as before (nothing to compare).
        matchers: rulerValues(samples.map((s) => s.matcher)),
        corpusShas: rulerValues(samples.map((s) => s.corpusSha)),
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
            "Skipped sources (not pooled): " +
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
        `| of which duplicates of a claimed defect | ${baseline.pooled.duplicates} |  | ${candidate.pooled.duplicates} |  |`,
        pooledRow(
            "Legitimate unspecced (may-flag, not noise)",
            (a) => a.pooled.legitimateUnspecced,
        ),
        `| Case-runs with may-flag entries (audited) | ${baseline.pooled.auditedRuns} / ${baseline.pooled.caseRuns} |  | ${candidate.pooled.auditedRuns} / ${candidate.pooled.caseRuns} |  |`,
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
