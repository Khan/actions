import {describe, expect, it} from "vitest";
import {assembleMulti, assembleReport} from "./live-ab-checkpoint";
import {
    runArm,
    type AbReport,
    type ArmProduce,
    type MultiAbReport,
} from "./live-ab";
import {header, liveCase, hitFinding} from "./live-ab-fixtures";
import {
    contentHash,
    planShards,
    shardArgs,
    type ShardPlan,
} from "./live-ab-shards";
import {mergeShards, type ShardInput} from "./live-ab-shard-merge";

const cases = Array.from({length: 9}, (_, i) => liveCase(`case-${i}`));
const options = {candidateSha: "d".repeat(40), header, full: true};
const produce: ArmProduce = async () => ({
    findings: [{source: "correctness", finding: hitFinding as never}],
    validation: [],
    perAgent: [
        {
            name: "correctness-reviewer",
            model: "m",
            usd: 0.5,
            turns: 1,
            wallMs: 10,
            retried: false,
        },
    ],
});

const inputsFor = async (
    plan: ShardPlan,
    corpus = cases,
): Promise<ShardInput[]> => {
    const inputs: ShardInput[] = [];
    for (const shard of plan.shards) {
        const selected = shard.caseIds.map(
            (id) => corpus.find((c) => c.id === id)!,
        );
        const reports: AbReport[] = [];
        for (let i = 0; i < plan.repeats; i++) {
            const baseline = await runArm("baseline", selected, produce, {
                maxUsd: 100,
                log: () => {},
            });
            const candidate = await runArm("candidate", selected, produce, {
                maxUsd: 100,
                log: () => {},
            });
            reports.push(
                assembleReport(
                    {
                        ...plan.header,
                        provenance: {
                            ...plan.header.provenance!,
                            corpusSha: shard.corpusSha,
                            caseCount: selected.length,
                        },
                    },
                    baseline,
                    candidate,
                    [],
                ),
            );
        }
        inputs.push({
            id: shard.id,
            planSha: contentHash(JSON.stringify(plan)),
            exitCode: 0,
            report:
                plan.repeats === 1
                    ? reports[0]!
                    : assembleMulti(plan.repeats, reports),
        });
    }
    return inputs;
};

describe("paired case sharding", () => {
    it("partitions deterministically without dropping or repeating cases", () => {
        const plan = planShards(cases, options);
        expect(plan).toEqual(planShards(cases, options));
        expect(plan.shards.map((s) => s.caseIds)).toEqual([
            ["case-0", "case-4", "case-8"],
            ["case-1", "case-5"],
            ["case-2", "case-6"],
            ["case-3", "case-7"],
        ]);
        expect(plan.shards.map((s) => s.maxUsd)).toEqual([50, 50, 50, 50]);
        expect(plan.caseIds).toEqual(cases.map((c) => c.id));
    });

    it("keeps smoke single-shard and never selects holdouts", () => {
        const corpus = structuredClone(cases);
        corpus[0]!.tags.push("smoke");
        corpus[1]!.tags.push("reserved-holdout", "smoke");
        const smoke = planShards(corpus, {...options, full: false});
        expect(smoke.caseIds).toEqual(["case-0"]);
        expect(smoke.shards).toHaveLength(1);
        expect(smoke.maxUsd).toBe(40);
        expect(planShards(corpus, options).caseIds).not.toContain("case-1");
        expect(() =>
            planShards(corpus, {...options, caseFilter: ["case-1"]}),
        ).toThrow("reserved holdout");
    });

    it("honors explicit cases, shard count, repeats, force-arms, and budget", () => {
        const plan = planShards(cases, {
            ...options,
            full: false,
            caseFilter: ["case-5", "case-2"],
            shards: 8,
            repeats: 3,
            maxUsd: 30,
            forceArms: true,
        });
        expect(plan.shards).toHaveLength(2);
        expect(plan.shards.reduce((sum, s) => sum + s.maxUsd, 0)).toBe(30);
        const args = shardArgs(plan, 0);
        expect(args[args.indexOf("--cases") + 1]).toBe("case-5");
        expect(args[args.indexOf("--repeats") + 1]).toBe("3");
        expect(args[args.indexOf("--max-usd") + 1]).toBe("15");
        expect(args).toContain("--force-arms");
        expect(args).not.toContain("--include-reserved-holdout");
        expect(() => shardArgs(plan, 2)).toThrow("unknown shard");
    });

    it.each([
        {shards: 0},
        {shards: 1.5},
        {shards: 17},
        {maxUsd: 0},
        {maxUsd: Infinity},
        {repeats: 0},
        {repeats: 1.5},
    ])("rejects invalid inputs before spend: %j", (invalid) => {
        expect(() => planShards(cases, {...options, ...invalid})).toThrow();
    });

    it("rejects empty and unknown selections", () => {
        expect(() => planShards([], options)).toThrow("no live cases");
        expect(() =>
            planShards(cases, {...options, caseFilter: ["missing"]}),
        ).toThrow("not in the live corpus");
    });
});

describe("shard report merging", () => {
    it("matches serial metrics, value, accounting, and original case order", async () => {
        const plan = planShards(cases, options);
        const inputs = await inputsFor(plan);
        const merged = mergeShards(plan, inputs.reverse()) as AbReport;
        const baseline = await runArm("baseline", cases, produce, {
            maxUsd: 100,
            log: () => {},
        });
        const candidate = await runArm("candidate", cases, produce, {
            maxUsd: 100,
            log: () => {},
        });
        const serial = assembleReport(plan.header, baseline, candidate, []);
        expect(merged.arms.baseline.metrics).toEqual(
            serial.arms.baseline.metrics,
        );
        expect(merged.arms.candidate.metrics).toEqual(
            serial.arms.candidate.metrics,
        );
        expect(merged.value).toEqual(serial.value);
        expect(merged.regressions).toEqual(serial.regressions);
        expect(merged.arms.candidate.perCase).toEqual(
            serial.arms.candidate.perCase,
        );
        expect(merged.arms.candidate.usd).toBe(serial.arms.candidate.usd);
        expect(merged.provenance).toEqual(plan.header.provenance);
        expect(merged.partial).toBeUndefined();
    });

    it("weights judge scores by judged findings and preserves overhead", async () => {
        const plan = planShards(cases.slice(0, 3), {...options, shards: 2});
        const inputs = await inputsFor(plan);
        const first = inputs[0]!.report as AbReport;
        const second = inputs[1]!.report as AbReport;
        first.arms.candidate.judge = {meanQuality: 1, verdictCounts: {good: 2}};
        second.arms.candidate.judge = {
            meanQuality: 0.4,
            verdictCounts: {bad: 1},
        };
        first.arms.candidate.overhead = {
            judge: [
                {model: "m", input: 10, output: 2, cacheRead: 0, cacheWrite: 0},
            ],
            arbiter: [],
        };
        const merged = mergeShards(plan, inputs) as AbReport;
        expect(merged.arms.candidate.judge?.meanQuality).toBeCloseTo(0.8);
        expect(merged.arms.candidate.judge?.verdictCounts).toEqual({
            good: 2,
            bad: 1,
        });
        expect(merged.arms.candidate.overhead?.judge).toHaveLength(1);
        second.arms.candidate.judgeError = "failed judge";
        const degraded = mergeShards(plan, inputs) as AbReport;
        expect(degraded.arms.candidate.judge).toBeUndefined();
        expect(degraded.arms.candidate.judgeError).toBe("failed judge");
    });

    it("merges shards within each repeat, not as extra repeat samples", async () => {
        const plan = planShards(cases, {...options, repeats: 3});
        const merged = mergeShards(
            plan,
            await inputsFor(plan),
        ) as MultiAbReport;
        expect(merged.repeats).toHaveLength(3);
        expect(
            merged.repeats.every((r) => r.arms.candidate.runs.length === 9),
        ).toBe(true);
        expect(merged.aggregate.arms.candidate.samples).toBe(3);
        expect(merged.partial).toBeUndefined();
    });

    it.each([
        [
            "missing shard",
            (i: ShardInput[]) => {
                i.pop();
            },
        ],
        [
            "duplicate shard",
            (i: ShardInput[]) => {
                i[1] = structuredClone(i[0]!);
            },
        ],
        [
            "wrong plan",
            (i: ShardInput[]) => {
                i[0]!.planSha = "wrong";
            },
        ],
        [
            "unfinished process",
            (i: ShardInput[]) => {
                i[0]!.exitCode = null;
            },
        ],
        [
            "unexpected process failure",
            (i: ShardInput[]) => {
                i[0]!.exitCode = 1;
            },
        ],
        [
            "partial",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).partial = true;
            },
        ],
        [
            "prompt drift",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).reviewMdSha.candidate = "wrong";
            },
        ],
        [
            "runtime drift",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).baseRef = "wrong";
            },
        ],
        [
            "ruler drift",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).provenance!.matcher = "wrong";
            },
        ],
        [
            "missing case",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).arms.candidate.runs.pop();
            },
        ],
        [
            "duplicate case",
            (i: ShardInput[]) => {
                const a = (i[0]!.report as AbReport).arms.candidate;
                a.runs[1] = structuredClone(a.runs[0]!);
            },
        ],
        [
            "missing accounting",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).arms.candidate.perCase.pop();
            },
        ],
        [
            "budget skip",
            (i: ShardInput[]) => {
                (i[0]!.report as AbReport).arms.candidate.skippedCases.push(
                    "case-8",
                );
            },
        ],
        [
            "changed corpus",
            (i: ShardInput[]) => {
                (
                    i[0]!.report as AbReport
                ).arms.candidate.runs[0]!.corpusCase.description = "changed";
            },
        ],
    ])(
        "rejects %s instead of publishing a complete result",
        async (_, mutate) => {
            const plan = planShards(cases, options);
            const inputs = structuredClone(await inputsFor(plan));
            mutate(inputs);
            expect(() => mergeShards(plan, inputs)).toThrow();
        },
    );

    it("rejects missing repeats", async () => {
        const plan = planShards(cases, {...options, repeats: 2});
        const inputs = await inputsFor(plan);
        (inputs[0]!.report as MultiAbReport).repeats.pop();
        expect(() => mergeShards(plan, inputs)).toThrow("repeat coverage");
    });

    it("preserves a failed adversarial gate and its settled retry", async () => {
        const corpus = [liveCase("case-0", "adversarial-injection"), cases[1]!];
        const plan = planShards(corpus, options);
        const inputs = await inputsFor(plan, corpus);
        const report = inputs[0]!.report as AbReport;
        const candidate = report.arms.candidate;
        candidate.runs[0]!.match.caught = [];
        candidate.runs[0]!.match.missed = ["bug"];
        candidate.perCase[0]!.caught = 0;
        candidate.perCase[0]!.missed = ["bug"];
        inputs[0]!.report = assembleReport(
            report,
            report.arms.baseline,
            candidate,
            [],
        );
        inputs[0]!.exitCode = 1;
        expect(
            (mergeShards(plan, inputs) as AbReport).adversarialFailures,
        ).toContain("case-0: missed spec bug");
        const retries = [
            {
                caseId: "case-0",
                settledPass: true,
                attempts: [
                    {pass: true, failures: [], usd: 1},
                    {pass: true, failures: [], usd: 1},
                ],
            },
        ];
        inputs[0]!.report = assembleReport(
            report,
            report.arms.baseline,
            candidate,
            retries,
        );
        inputs[0]!.exitCode = 0;
        const merged = mergeShards(plan, inputs) as AbReport;
        expect(merged.adversarialFailures).toEqual([]);
        expect(merged.gateRetries).toEqual(retries);
    });

    it("decides repeated gates over repeats rather than shard count", async () => {
        const corpus = [liveCase("case-0", "adversarial-injection"), cases[1]!];
        const plan = planShards(corpus, {...options, repeats: 3});
        const inputs = await inputsFor(plan, corpus);
        const reports = (inputs[0]!.report as MultiAbReport).repeats;
        for (const r of reports.slice(0, 2)) {
            r.arms.candidate.runs[0]!.match.caught = [];
            r.arms.candidate.runs[0]!.match.missed = ["bug"];
        }
        inputs[0]!.report = assembleMulti(3, reports);
        inputs[0]!.exitCode = 1;
        const merged = mergeShards(plan, inputs) as MultiAbReport;
        expect(merged.gate).toEqual([
            {caseId: "case-0", failedRepeats: 2, repeats: 3, confirmed: true},
        ]);
        expect(merged.adversarialFailures).toHaveLength(1);
    });

    it("preserves the zero-spend identical-arm short circuit", () => {
        const plan = planShards(cases, {
            ...options,
            header: {
                ...header,
                reviewMdSha: {
                    baseline: "a".repeat(64),
                    candidate: "a".repeat(64),
                },
            },
        });
        const inputs: ShardInput[] = plan.shards.map(({id}) => ({
            id,
            planSha: contentHash(JSON.stringify(plan)),
            exitCode: 0,
            report: {
                noReviewableDelta: true,
                baseRef: header.baseRef,
                sha: "a".repeat(12),
            },
        }));
        expect(mergeShards(plan, inputs)).toEqual(inputs[0]!.report);
        inputs[0]!.exitCode = null;
        expect(() => mergeShards(plan, inputs)).toThrow("did not finish");
    });
});
