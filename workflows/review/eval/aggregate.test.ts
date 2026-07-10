import {describe, it, expect} from "vitest";

import {
    aggregateSamples,
    computeNoiseFloor,
    extractSamples,
    rateStat,
    renderAggregateMarkdown,
    wilsonInterval,
    type ArmSample,
    type ReportSample,
    type SampleRun,
} from "./aggregate";

/* -------------------------------------------------------------------------- */
/* Fixture builders: the report-JSON subset the extractor consumes            */
/* -------------------------------------------------------------------------- */

/** One raw `arms.<arm>.runs[]` entry as live-ab.ts serializes it. */
const rawRun = (
    caseId: string,
    over: {
        verdict?: string;
        expected?: string;
        caught?: string[];
        missedDetail?: {specKey: string; droppedBy?: string}[];
        unmatched?: string[];
        posted?: number;
    } = {},
) => ({
    corpusCase: {
        id: caseId,
        expected: {verdict: over.expected ?? "REQUEST_CHANGES"},
    },
    result: {verdict: {event: over.verdict ?? "REQUEST_CHANGES"}},
    match: {
        caseId,
        caught: (over.caught ?? []).map((specKey) => ({
            specKey,
            findingId: `${caseId}:f`,
            via: "deterministic",
        })),
        missed: (over.missedDetail ?? []).map((d) => d.specKey),
        missedDetail: over.missedDetail ?? [],
        falseFlags: [],
        unmatchedFindingIds: over.unmatched ?? [],
        postedCount: over.posted ?? (over.caught ?? []).length,
    },
});

const rawReport = (over: {
    baselineRuns?: unknown[];
    candidateRuns?: unknown[];
    baselineSha?: string;
    candidateSha?: string;
    baselineJudge?: number;
    candidateJudge?: number;
}) => ({
    baseRef: "origin/main",
    reviewMdSha: {
        baseline: over.baselineSha ?? "a".repeat(64),
        candidate: over.candidateSha ?? "b".repeat(64),
    },
    arms: {
        baseline: {
            arm: "baseline",
            runs: over.baselineRuns ?? [],
            usd: 1.5,
            ...(over.baselineJudge !== undefined
                ? {judge: {meanQuality: over.baselineJudge, verdictCounts: {}}}
                : {}),
        },
        candidate: {
            arm: "candidate",
            runs: over.candidateRuns ?? [],
            usd: 2.5,
            ...(over.candidateJudge !== undefined
                ? {judge: {meanQuality: over.candidateJudge, verdictCounts: {}}}
                : {}),
        },
    },
    regressions: {lost: [], gained: []},
    adversarialFailures: [],
    gateRetries: [],
});

describe("wilsonInterval", () => {
    it("brackets the point estimate and stays inside [0,1]", () => {
        const interval = wilsonInterval(5, 6);
        expect(interval.lo).toBeGreaterThan(0.4);
        expect(interval.lo).toBeLessThan(5 / 6);
        expect(interval.hi).toBeGreaterThan(5 / 6);
        expect(interval.hi).toBeLessThanOrEqual(1);
    });

    it("is exactly [0,1] at n=0 and never collapses at 0/n or n/n", () => {
        expect(wilsonInterval(0, 0)).toEqual({lo: 0, hi: 1});
        const zero = wilsonInterval(0, 10);
        expect(zero.lo).toBe(0);
        expect(zero.hi).toBeGreaterThan(0.2);
        const full = wilsonInterval(10, 10);
        expect(full.hi).toBe(1);
        expect(full.lo).toBeLessThan(1);
    });

    it("narrows as repeats accumulate (the whole point of pooling)", () => {
        const single = wilsonInterval(6, 8);
        const pooled = wilsonInterval(60, 80);
        expect(pooled.hi - pooled.lo).toBeLessThan((single.hi - single.lo) / 2);
    });
});

describe("extractSamples", () => {
    it("reduces a single-run report to one sample pair", () => {
        const raw = rawReport({
            baselineRuns: [rawRun("case-1", {caught: ["spec-1"]})],
            candidateRuns: [
                rawRun("case-1", {
                    missedDetail: [
                        {specKey: "spec-1", droppedBy: "provenance"},
                    ],
                    posted: 2,
                    unmatched: ["x"],
                }),
            ],
        });
        const samples = extractSamples("r1", raw);
        expect(samples.length).toBe(1);
        const sample = samples[0]!;
        expect(sample.baseline.runs[0]?.caughtSpecKeys).toEqual(["spec-1"]);
        expect(sample.candidate.runs[0]?.missedSpecs).toEqual([
            {specKey: "spec-1", droppedBy: "provenance"},
        ]);
        expect(sample.candidate.runs[0]?.unmatchedPosted).toBe(1);
        expect(sample.candidate.runs[0]?.posted).toBe(2);
        expect(sample.baseline.usd).toBe(1.5);
    });

    it("flattens a --repeats artifact into one sample per repeat", () => {
        const single = rawReport({
            baselineRuns: [rawRun("case-1", {caught: ["spec-1"]})],
            candidateRuns: [rawRun("case-1", {caught: ["spec-1"]})],
        });
        const samples = extractSamples("r", {repeats: [single, single]});
        expect(samples.length).toBe(2);
        expect(samples.map((s) => s.source)).toEqual(["r#1", "r#2"]);
    });

    it("contributes nothing for a no-reviewable-delta report", () => {
        expect(
            extractSamples("r", {noReviewableDelta: true, baseRef: "x"}),
        ).toEqual([]);
    });

    it("throws a shape error a caller can record and skip", () => {
        expect(() => extractSamples("r", {arms: {}})).toThrow(/baseline\.runs/);
    });

    it("falls back to `missed` keys when a report predates missedDetail", () => {
        const raw = rawReport({
            baselineRuns: [rawRun("case-1")],
            candidateRuns: [rawRun("case-1")],
        });
        const run = (raw.arms.baseline.runs as Record<string, unknown>[])[0]!;
        (run["match"] as Record<string, unknown>)["missed"] = ["spec-old"];
        (run["match"] as Record<string, unknown>)["missedDetail"] = undefined;
        const samples = extractSamples("r1", raw);
        expect(samples[0]?.baseline.runs[0]?.missedSpecs).toEqual([
            {specKey: "spec-old"},
        ]);
    });
});

describe("aggregateSamples", () => {
    const run = (over: Parameters<typeof sampleRun>[1] = {}): SampleRun =>
        sampleRun("case-1", over);
    const sampleRun = (
        caseId: string,
        over: Partial<SampleRun> = {},
    ): SampleRun => ({
        caseId,
        expectedVerdict: "REQUEST_CHANGES",
        verdict: "REQUEST_CHANGES",
        caughtSpecKeys: [],
        missedSpecs: [],
        unmatchedPosted: 0,
        posted: 0,
        ...over,
    });
    const arm = (
        armId: "baseline" | "candidate",
        runs: SampleRun[],
        over: Partial<ArmSample> = {},
    ): ArmSample => ({
        arm: armId,
        reviewMdSha: armId === "baseline" ? "a".repeat(64) : "b".repeat(64),
        runs,
        usd: 1,
        ...over,
    });
    const sample = (
        baselineRuns: SampleRun[],
        candidateRuns: SampleRun[],
        source = "r",
    ): ReportSample => ({
        source,
        baseRef: "origin/main",
        baseline: arm("baseline", baselineRuns),
        candidate: arm("candidate", candidateRuns),
    });

    it("pools per-case catch and verdict rates across repeats", () => {
        // Three repeats: baseline catches 2/3, flips the verdict once.
        const samples = [
            sample(
                [run({caughtSpecKeys: ["spec-1"]})],
                [run({caughtSpecKeys: ["spec-1"]})],
                "r1",
            ),
            sample(
                [
                    run({
                        missedSpecs: [{specKey: "spec-1"}],
                        verdict: "APPROVE",
                    }),
                ],
                [run({caughtSpecKeys: ["spec-1"]})],
                "r2",
            ),
            sample(
                [run({caughtSpecKeys: ["spec-1"]})],
                [
                    run({
                        missedSpecs: [
                            {specKey: "spec-1", droppedBy: "provenance"},
                        ],
                    }),
                ],
                "r3",
            ),
        ];
        const report = aggregateSamples(samples);
        expect(report.samples).toBe(3);

        const base = report.arms.baseline.cases[0]!;
        expect(base.runs).toBe(3);
        expect(base.specs[0]?.caught.numerator).toBe(2);
        expect(base.specs[0]?.caught.denominator).toBe(3);
        expect(base.specs[0]?.trueMisses).toBe(1);
        expect(base.specs[0]?.droppedBy).toEqual({});
        expect(base.verdictOk.numerator).toBe(2);

        const cand = report.arms.candidate.cases[0]!;
        expect(cand.specs[0]?.caught.numerator).toBe(2);
        expect(cand.specs[0]?.trueMisses).toBe(0);
        expect(cand.specs[0]?.droppedBy).toEqual({provenance: 1});
        expect(cand.verdictOk.numerator).toBe(3);

        // Pooled rows: recall over specs, agreement over case-runs.
        expect(report.arms.baseline.pooled.recall.numerator).toBe(2);
        expect(report.arms.baseline.pooled.recall.denominator).toBe(3);
        expect(report.arms.candidate.pooled.trueMisses).toBe(0);
        expect(report.arms.candidate.pooled.foundButDropped).toEqual({
            provenance: 1,
        });
        expect(report.arms.baseline.pooled.usd).toBe(3);
    });

    it("keeps cases the pools do not share and counts their runs honestly", () => {
        // r2 ran a second case (e.g. full corpus vs smoke): its case shows
        // one run, not three, and the shared case still shows two.
        const samples = [
            sample([sampleRun("case-1")], [sampleRun("case-1")], "r1"),
            sample(
                [sampleRun("case-1"), sampleRun("case-2")],
                [sampleRun("case-1"), sampleRun("case-2")],
                "r2",
            ),
        ];
        const report = aggregateSamples(samples);
        const byId = Object.fromEntries(
            report.arms.baseline.cases.map((c) => [c.caseId, c.runs]),
        );
        expect(byId).toEqual({"case-1": 2, "case-2": 1});
    });

    it("flags multi-sha pools and carries skipped sources", () => {
        const mixed = [
            sample([run()], [run()], "r1"),
            {
                ...sample([run()], [run()], "r2"),
                candidate: arm("candidate", [run()], {
                    reviewMdSha: "c".repeat(64),
                }),
            },
        ];
        const report = aggregateSamples(mixed, [
            {source: "r3", reason: "no reviewable delta"},
        ]);
        expect(report.arms.candidate.reviewMdShas.length).toBe(2);
        const markdown = renderAggregateMarkdown(report);
        expect(markdown).toContain("WARNING: pooled runs carry more than one");
        expect(markdown).toContain("r3 (no reviewable delta)");
    });

    it("emits the noise floor iff every sample ran identical arms", () => {
        const identical: ReportSample = {
            source: "r1",
            baseRef: "origin/main",
            baseline: arm("baseline", [run({caughtSpecKeys: ["spec-1"]})], {
                reviewMdSha: "a".repeat(64),
            }),
            candidate: arm(
                "candidate",
                [run({missedSpecs: [{specKey: "spec-1"}]})],
                {reviewMdSha: "a".repeat(64)},
            ),
        };
        const report = aggregateSamples([identical]);
        expect(report.noiseFloor).toBeDefined();
        expect(report.noiseFloor?.armSamples).toBe(2);
        // Recall wobbled 0% to 100% across the two arm-samples.
        expect(report.noiseFloor?.bands["must-catch recall"]).toEqual({
            min: 0,
            max: 1,
            mean: 0.5,
        });

        const differing = sample([run()], [run()]);
        expect(aggregateSamples([differing]).noiseFloor).toBeUndefined();
        expect(aggregateSamples([]).noiseFloor).toBeUndefined();
    });
});

describe("computeNoiseFloor", () => {
    it("bands each metric across arm-samples, judge included when present", () => {
        const mk = (caught: boolean, judge: number | undefined): ArmSample => ({
            arm: "baseline",
            reviewMdSha: "a".repeat(64),
            runs: [
                {
                    caseId: "case-1",
                    expectedVerdict: "REQUEST_CHANGES",
                    verdict: "REQUEST_CHANGES",
                    caughtSpecKeys: caught ? ["s"] : [],
                    missedSpecs: caught ? [] : [{specKey: "s"}],
                    unmatchedPosted: 1,
                    posted: 2,
                },
            ],
            usd: 1,
            ...(judge !== undefined ? {judgeMeanQuality: judge} : {}),
        });
        const floor = computeNoiseFloor([mk(true, 0.8), mk(false, 0.9)]);
        expect(floor.bands["must-catch recall"]).toEqual({
            min: 0,
            max: 1,
            mean: 0.5,
        });
        expect(floor.bands["noise (unmatched posted)"]?.mean).toBe(0.5);
        expect(floor.bands["judge mean quality"]).toEqual({
            min: 0.8,
            max: 0.9,
            mean: 0.8500000000000001,
        });
    });
});

describe("renderAggregateMarkdown", () => {
    it("renders per-spec rates with intervals, pooled rows, and miss classes", () => {
        const raw = rawReport({
            baselineRuns: [rawRun("case-1", {caught: ["spec-1"]})],
            candidateRuns: [
                rawRun("case-1", {
                    missedDetail: [
                        {specKey: "spec-1", droppedBy: "provenance"},
                    ],
                }),
            ],
            baselineJudge: 0.9,
            candidateJudge: 0.8,
        });
        const report = aggregateSamples([
            ...extractSamples("r1", raw),
            ...extractSamples("r2", raw),
        ]);
        const markdown = renderAggregateMarkdown(report);
        expect(markdown).toContain("Pooled 2 run(s) per arm");
        expect(markdown).toContain("| case-1:spec-1 | 2/2 (100%)");
        expect(markdown).toContain("cand: 2 dropped at provenance");
        expect(markdown).toContain("| case-1 (verdict) | 2/2 (100%)");
        expect(markdown).toContain("| Must-catch recall | 2/2 (100%)");
        expect(markdown).toContain("| 0/2 (0%)");
        expect(markdown).toContain(
            "| Misses (true / dropped) | 0 true / 0 dropped |  | 0 true / 2 provenance |  |",
        );
        expect(markdown).toContain("| Judge mean quality | 0.90 |  | 0.80 |");
        // No identical arms, so no noise-floor section.
        expect(markdown).not.toContain("Noise floor");
    });

    it("renders the noise-floor bands for an identical-arm pool", () => {
        const raw = rawReport({
            baselineRuns: [rawRun("case-1", {caught: ["spec-1"]})],
            candidateRuns: [rawRun("case-1", {caught: ["spec-1"]})],
            baselineSha: "a".repeat(64),
            candidateSha: "a".repeat(64),
        });
        const markdown = renderAggregateMarkdown(
            aggregateSamples(extractSamples("r1", raw)),
        );
        expect(markdown).toContain("### Noise floor");
        expect(markdown).toContain(
            "| must-catch recall | 100% | 100% | 100% | 0% |",
        );
    });
});

describe("rateStat", () => {
    it("carries numerator, denominator, rate, and interval together", () => {
        const stat = rateStat(3, 4);
        expect(stat.rate).toBe(0.75);
        expect(stat.interval.lo).toBeGreaterThan(0);
        expect(stat.interval.hi).toBeLessThanOrEqual(1);
        expect(rateStat(0, 0).rate).toBe(0);
    });
});
