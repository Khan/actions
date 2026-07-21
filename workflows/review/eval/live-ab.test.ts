import {describe, it, expect} from "vitest";

import {aggregateSamples, extractSamples} from "./aggregate";
import {parseCase, type CorpusCase} from "./corpus/loader";
import {
    adversarialGateFailures,
    diffRegressions,
    majorityGateFailures,
    renderMarkdownReport,
    renderMultiMarkdownReport,
    retryGateFlips,
    runArm,
    selectCases,
    type AbReport,
    type ArmProduce,
    type ArmRunReport,
    type MultiAbReport,
} from "./live-ab";

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

const liveCase = (id: string, over: Record<string, unknown> = {}): CorpusCase =>
    parseCase(
        {
            id,
            tags: ["live"],
            category: "incident-repro",
            description: "ab fixture",
            changedFiles: [{path: "src/a.ts", status: "modified"}],
            expected: {verdict: "REQUEST_CHANGES"},
            diff: DIFF,
            live: {
                prContext: {
                    title: "t",
                    description: "",
                    author: "a",
                    baseBranch: "main",
                },
                mustCatchSpecs: [
                    {
                        key: "bug",
                        path: "src/a.ts",
                        lineStart: 1,
                        lineEnd: 2,
                        mechanism: ["constant changed"],
                    },
                ],
            },
            ...over,
        },
        `test://${id}`,
    );

const hitFinding = {
    schema_version: 2,
    id: "live-hit",
    lens: "correctness",
    anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
    severity: "blocking",
    confidence: 0.8,
    evidence_trace: ["e"],
    failure_scenario: "the constant changed and breaks callers.",
    producing_hunt: "h",
    model_authored_prose: "The constant changed incorrectly.",
};

/** A producer that catches the bug at a fixed cost per case. */
const produceHit =
    (usd: number, failedAgent?: string): ArmProduce =>
    async () => ({
        findings: [
            {
                source: "correctness",
                finding: hitFinding as never,
            },
        ],
        validation: [],
        perAgent: [
            {
                name: "correctness-reviewer",
                model: "m",
                usd,
                turns: 1,
                wallMs: 10,
                retried: false,
                ...(failedAgent !== undefined ? {} : {}),
            },
            ...(failedAgent !== undefined
                ? [
                      {
                          name: failedAgent,
                          model: "m",
                          usd: 0,
                          turns: 2,
                          wallMs: 5,
                          retried: true,
                          failed: "malformed output",
                      },
                  ]
                : []),
        ],
    });

/** A producer that finds nothing. */
const produceMiss: ArmProduce = async () => ({
    findings: [],
    validation: [],
    perAgent: [
        {
            name: "correctness-reviewer",
            model: "m",
            usd: 1,
            turns: 1,
            wallMs: 10,
            retried: false,
        },
    ],
});

describe("selectCases", () => {
    const corpus = () => [
        liveCase("smoke-a", {tags: ["live", "smoke"]}),
        liveCase("smoke-b", {tags: ["live", "smoke"]}),
        liveCase("holdout-c", {tags: ["live", "holdout"]}),
    ];

    it("scopes unscoped runs by the smoke tag, or not at all", () => {
        expect(
            selectCases(corpus(), {smokeOnly: true}).map((c) => c.id),
        ).toEqual(["smoke-a", "smoke-b"]);
        expect(
            selectCases(corpus(), {smokeOnly: false}).map((c) => c.id),
        ).toEqual(["smoke-a", "smoke-b", "holdout-c"]);
    });

    it("treats an explicit case list as exact: it bypasses the smoke scope", () => {
        // The 2026-07-10 footgun: a powered dispatch named a non-smoke case
        // and the smoke scope silently dropped it from a paid measurement.
        expect(
            selectCases(corpus(), {
                smokeOnly: true,
                caseFilter: ["smoke-a", "holdout-c"],
            }).map((c) => c.id),
        ).toEqual(["smoke-a", "holdout-c"]);
    });

    it("preserves requested order and runs duplicate ids once", () => {
        expect(
            selectCases(corpus(), {
                smokeOnly: false,
                caseFilter: ["holdout-c", "smoke-a", "holdout-c"],
            }).map((c) => c.id),
        ).toEqual(["holdout-c", "smoke-a"]);
    });

    it("fails before any spend on an id that matches no live case", () => {
        expect(() =>
            selectCases(corpus(), {
                smokeOnly: false,
                caseFilter: ["smoke-a", "not-a-case"],
            }),
        ).toThrow(/not in the live corpus: not-a-case/);
    });
});

describe("runArm", () => {
    it("scores cases, accounts cost, and reports agent failures", async () => {
        const report = await runArm(
            "candidate",
            [liveCase("case-1")],
            produceHit(2, "skill-auditor"),
            {maxUsd: 10},
        );
        expect(report.runs.length).toBe(1);
        expect(report.usd).toBe(2);
        expect(report.metrics.mustCatchRecall.rate).toBe(1);
        expect(report.perCase[0]?.verdict).toBe("REQUEST_CHANGES");
        expect(report.perCase[0]?.failedAgents).toEqual([
            "skill-auditor: malformed output",
        ]);
        expect(report.skippedCases).toEqual([]);
    });

    it("stops dispatching when the next case would cross the budget", async () => {
        const cases = [
            liveCase("case-1"),
            liveCase("case-2"),
            liveCase("case-3"),
        ];
        // Each case costs $10; budget $15: case-1 runs ($10 spent), then
        // spent + running average (10) crosses 15, so 2 and 3 are skipped.
        const report = await runArm("baseline", cases, produceHit(10), {
            maxUsd: 15,
        });
        expect(report.runs.map((r) => r.corpusCase.id)).toEqual(["case-1"]);
        expect(report.skippedCases).toEqual(["case-2", "case-3"]);
        expect(report.usd).toBe(10);
    });
});

describe("diffRegressions", () => {
    it("diffs caught specs over the shared scored cases only", async () => {
        const cases = [liveCase("case-1"), liveCase("case-2")];
        const baseline = await runArm("baseline", cases, produceHit(1), {
            maxUsd: 100,
        });
        // Candidate misses case-1's bug and never runs case-2 (budget).
        const candidate = await runArm(
            "candidate",
            cases,
            produceMiss,
            // $1 for case-1, then 1 + avg(1) > 1.5 skips case-2.
            {maxUsd: 1.5},
        );
        const diff = diffRegressions(baseline, candidate);
        // case-1: genuinely lost. case-2: skipped, NOT a regression.
        expect(diff.lost).toEqual(["case-1:bug"]);
        expect(diff.gained).toEqual([]);
    });
});

describe("adversarialGateFailures", () => {
    it("fails on a wrong verdict or a missed spec, only for adversarial cases", async () => {
        const adversarial = liveCase("adv-1", {
            category: "adversarial-injection",
        });
        const failing = await runArm("candidate", [adversarial], produceMiss, {
            maxUsd: 100,
        });
        const failures = adversarialGateFailures(failing);
        expect(failures.some((f) => f.includes("verdict APPROVE"))).toBe(true);
        expect(failures.some((f) => f.includes("missed spec bug"))).toBe(true);

        const incidentOnly = await runArm(
            "candidate",
            [liveCase("case-1")],
            produceMiss,
            {maxUsd: 100},
        );
        expect(adversarialGateFailures(incidentOnly)).toEqual([]);
    });
});

describe("retryGateFlips", () => {
    it("settles a flip as a flake when both retries pass", async () => {
        const adversarial = liveCase("adv-1", {
            category: "adversarial-injection",
        });
        const candidate = await runArm(
            "candidate",
            [adversarial],
            produceMiss,
            {maxUsd: 100},
        );
        const attemptsSeen: number[] = [];
        const retries = await retryGateFlips(
            candidate,
            [adversarial],
            (attempt) => {
                attemptsSeen.push(attempt);
                return produceHit(0.5);
            },
        );
        expect(attemptsSeen).toEqual([1, 2]);
        expect(retries).toEqual([
            {
                caseId: "adv-1",
                attempts: [
                    {pass: true, failures: [], usd: 0.5},
                    {pass: true, failures: [], usd: 0.5},
                ],
                settledPass: true,
            },
        ]);
    });

    it("confirms the failure after one failed retry and skips the second", async () => {
        const adversarial = liveCase("adv-1", {
            category: "adversarial-injection",
        });
        const candidate = await runArm(
            "candidate",
            [adversarial],
            produceMiss,
            {maxUsd: 100},
        );
        const retries = await retryGateFlips(
            candidate,
            [adversarial],
            () => produceMiss,
        );
        expect(retries.length).toBe(1);
        // Original fail + first retry fail settles the majority; the second
        // attempt would be spend with no decision left to make.
        expect(retries[0]?.attempts.length).toBe(1);
        expect(retries[0]?.settledPass).toBe(false);
        expect(retries[0]?.attempts[0]?.failures.length).toBeGreaterThan(0);
    });

    it("retries nothing when the gate passed", async () => {
        const candidate = await runArm(
            "candidate",
            [liveCase("case-1")],
            produceHit(1),
            {maxUsd: 100},
        );
        const retries = await retryGateFlips(candidate, [], () => produceMiss);
        expect(retries).toEqual([]);
    });
});

describe("majorityGateFailures", () => {
    const adversarial = liveCase("adv-1", {
        category: "adversarial-injection",
    });

    it("confirms a failure only on a strict majority of repeats", async () => {
        const fail = await runArm("candidate", [adversarial], produceMiss, {
            maxUsd: 100,
        });
        const pass = await runArm("candidate", [adversarial], produceHit(1), {
            maxUsd: 100,
        });
        // 1/3 failed: a flake, not a confirmed failure.
        expect(majorityGateFailures([fail, pass, pass])).toEqual([
            {caseId: "adv-1", failedRepeats: 1, repeats: 3, confirmed: false},
        ]);
        // 2/3 failed: confirmed.
        expect(majorityGateFailures([fail, fail, pass])[0]?.confirmed).toBe(
            true,
        );
        // Exactly half (1/2) is NOT a strict majority.
        expect(majorityGateFailures([fail, pass])[0]?.confirmed).toBe(false);
        // No failures anywhere: nothing to report.
        expect(majorityGateFailures([pass, pass])).toEqual([]);
    });
});

describe("renderMultiMarkdownReport", () => {
    const multiReport = async (
        produces: ArmProduce[],
        reviewMdSha = {baseline: "a".repeat(64), candidate: "b".repeat(64)},
    ): Promise<MultiAbReport> => {
        const cases = [liveCase("case-1")];
        const reports: AbReport[] = [];
        for (const produce of produces) {
            const baseline = await runArm("baseline", cases, produceHit(1), {
                maxUsd: 100,
            });
            const candidate = await runArm("candidate", cases, produce, {
                maxUsd: 100,
            });
            reports.push({
                baseRef: "origin/main",
                reviewMdSha,
                arms: {baseline, candidate},
                regressions: diffRegressions(baseline, candidate),
                adversarialFailures: [],
                gateRetries: [],
            });
        }
        const gate = majorityGateFailures(reports.map((r) => r.arms.candidate));
        return {
            repeatCount: reports.length,
            repeats: reports,
            aggregate: aggregateSamples(
                reports.flatMap((r, i) => extractSamples(`repeat-${i + 1}`, r)),
            ),
            gate,
            adversarialFailures: gate
                .filter((g) => g.confirmed)
                .map(
                    (g) =>
                        `${g.caseId}: failed ${g.failedRepeats}/${g.repeats} repeats`,
                ),
        };
    };

    it("renders pooled pass rates with intervals instead of single-run deltas", async () => {
        const multi = await multiReport([produceHit(1), produceMiss]);
        const markdown = renderMultiMarkdownReport(multi);
        expect(markdown).toContain("## Review live A/B: 2 repeats");
        // The candidate caught the spec in 1 of 2 repeats: a pass RATE row.
        expect(markdown).toContain("| case-1:bug | 2/2 (100%)");
        expect(markdown).toContain("| 1/2 (50%)");
        expect(markdown).toContain("### Pooled");
        expect(markdown).toContain(
            "Adversarial hard gate: PASSED on the candidate arm in every repeat.",
        );
    });

    it("reports minority gate flips as flakes and majorities as confirmed", async () => {
        const adversarial = liveCase("adv-1", {
            category: "adversarial-injection",
        });
        const armFor = async (produce: ArmProduce): Promise<ArmRunReport> =>
            runArm("candidate", [adversarial], produce, {maxUsd: 100});
        const fail = await armFor(produceMiss);
        const pass = await armFor(produceHit(1));
        const gate = majorityGateFailures([fail, pass, pass]);
        const markdown = renderMultiMarkdownReport({
            repeatCount: 3,
            repeats: [],
            aggregate: aggregateSamples([]),
            gate,
            adversarialFailures: [],
        });
        expect(markdown).toContain(
            "- adv-1: failed 1/3 repeats: minority flip, treated as run-to-run flake",
        );
        const confirmed = majorityGateFailures([fail, fail, pass]);
        expect(
            renderMultiMarkdownReport({
                repeatCount: 3,
                repeats: [],
                aggregate: aggregateSamples([]),
                gate: confirmed,
                adversarialFailures: ["adv-1: failed 2/3 repeats"],
            }),
        ).toContain("- adv-1: failed 2/3 repeats: FAILURE CONFIRMED");
    });

    it("relabels an identical-arm run as a wobble control", async () => {
        // Identical review.md in both arms only happens under --force-arms
        // (drift watch / noise floor); the report must not read as an A/B.
        const sha = "a".repeat(64);
        const multi = await multiReport([produceHit(1), produceHit(1)], {
            baseline: sha,
            candidate: sha,
        });
        const markdown = renderMultiMarkdownReport(multi);
        expect(markdown).toContain(
            "## Review wobble control: 2 repeats (identical arms)",
        );
        expect(markdown).toContain("run-to-run wobble, not a prompt effect");
        expect(markdown).not.toContain("## Review live A/B");
        // The embedded aggregate relabels too (identical arms imply the
        // noise floor, which implies the relabel).
        expect(markdown).toContain("| Case / spec | Arm A | 95% CI | Arm B |");
    });

    it("round-trips a MultiAbReport through the aggregate extractor", async () => {
        // The --repeats artifact must stay poolable across dispatches: the
        // aggregate CLI reads the `repeats` field of a multi-run report.
        const multi = await multiReport([produceHit(1), produceHit(1)]);
        const samples = extractSamples(
            "multi.json",
            JSON.parse(JSON.stringify(multi)),
        );
        expect(samples.length).toBe(2);
        const pooled = aggregateSamples(samples);
        expect(pooled.arms.candidate.pooled.recall.numerator).toBe(2);
    });
});

describe("renderMarkdownReport", () => {
    it("renders the arm table, regressions, gate status, and skips", async () => {
        const cases = [liveCase("case-1"), liveCase("case-2")];
        const baseline = await runArm("baseline", cases, produceHit(1), {
            maxUsd: 100,
        });
        const candidate = await runArm("candidate", cases, produceMiss, {
            maxUsd: 1.5,
        });
        const report: AbReport = {
            baseRef: "abc1234",
            reviewMdSha: {baseline: "a".repeat(64), candidate: "b".repeat(64)},
            arms: {baseline, candidate},
            regressions: diffRegressions(baseline, candidate),
            adversarialFailures: adversarialGateFailures(candidate),
            gateRetries: [],
        };
        const markdown = renderMarkdownReport(report);
        expect(markdown).toContain("| Must-catch recall | 100% | 0% |");
        expect(markdown).toContain(
            "Regressions (baseline caught, candidate missed)",
        );
        expect(markdown).toContain("- case-1:bug (not found)");
        expect(markdown).toContain("| Misses found-but-dropped | 0 | 0 |");
        expect(markdown).toContain("Adversarial hard gate: PASSED");
        expect(markdown).toContain("SKIPPED (budget exhausted");
        expect(markdown).toContain("- candidate:case-2");
        // The stability footer plus the measured noise floor close every
        // report, so a reader always sees which rows are single-run signals
        // and prices any delta against measured wobble, not prose.
        expect(markdown).toContain("load-bearing metric.*");
        expect(markdown).toContain(
            "Measured noise floor (identical arms, run 29069228968",
        );
        expect(markdown).toContain("must-catch recall 54%-86% (sd 10%)");
        expect(markdown.trimEnd().endsWith("resolve smaller effects.*")).toBe(
            true,
        );
    });

    it("relabels the arm columns on an identical-arm single run", async () => {
        const cases = [liveCase("case-1")];
        const baseline = await runArm("baseline", cases, produceHit(1), {
            maxUsd: 100,
        });
        const candidate = await runArm("candidate", cases, produceHit(1), {
            maxUsd: 100,
        });
        const markdown = renderMarkdownReport({
            baseRef: "origin/main",
            reviewMdSha: {baseline: "a".repeat(64), candidate: "a".repeat(64)},
            arms: {baseline, candidate},
            regressions: diffRegressions(baseline, candidate),
            adversarialFailures: [],
            gateRetries: [],
        });
        expect(markdown).toContain("## Review wobble control (identical arms)");
        expect(markdown).toContain("| Metric | Arm A | Arm B | Delta |");
        expect(markdown).toContain("run-to-run wobble, not a prompt effect");
    });

    it("marks a failed adversarial gate", () => {
        const empty: ArmRunReport = {
            arm: "baseline",
            runs: [],
            metrics: {
                caseCount: 0,
                mustCatchRecall: {numerator: 0, denominator: 0, rate: 0},
                verdictAgreement: {numerator: 0, denominator: 0, rate: 0},
                cleanFalseFlag: {count: 0, details: []},
                noise: {numerator: 0, denominator: 0, rate: 0},
            },
            skippedCases: [],
            usd: 0,
            wallMs: 0,
            perCase: [],
        };
        const markdown = renderMarkdownReport({
            baseRef: "abc",
            reviewMdSha: {baseline: "a".repeat(64), candidate: "b".repeat(64)},
            arms: {baseline: empty, candidate: {...empty, arm: "candidate"}},
            regressions: {lost: [], gained: []},
            adversarialFailures: ["adv-1: missed spec bug"],
            gateRetries: [
                {
                    caseId: "adv-1",
                    attempts: [
                        {
                            pass: false,
                            failures: ["adv-1: missed spec bug"],
                            usd: 0.57,
                        },
                    ],
                    settledPass: false,
                },
            ],
        });
        expect(markdown).toContain("Adversarial hard gate: FAILED");
        expect(markdown).toContain("- adv-1: missed spec bug");
        expect(markdown).toContain(
            "Gate flips retried (best of three, flipped cases only)",
        );
        expect(markdown).toContain(
            "- adv-1: original run failed, 0/1 retries passed; failure confirmed ($0.57 retry spend)",
        );
    });

    it("annotates a found-but-dropped regression with its gate bucket", async () => {
        const baseline = await runArm(
            "baseline",
            [liveCase("case-1")],
            produceHit(1),
            {maxUsd: 100},
        );
        // The candidate produces the right mechanism anchored off the diff,
        // so the provenance gate drops it: found-but-dropped, not a true miss.
        const produceDropped: ArmProduce = async () => ({
            findings: [
                {
                    source: "correctness",
                    finding: {
                        ...hitFinding,
                        id: "live-dropped",
                        anchor: {
                            type: "line",
                            path: "src/a.ts",
                            line: 40,
                            side: "RIGHT",
                        },
                    } as never,
                },
            ],
            validation: [],
            perAgent: [
                {
                    name: "correctness-reviewer",
                    model: "m",
                    usd: 1,
                    turns: 1,
                    wallMs: 10,
                    retried: false,
                },
            ],
        });
        const candidate = await runArm(
            "candidate",
            [liveCase("case-1")],
            produceDropped,
            {maxUsd: 100},
        );
        const markdown = renderMarkdownReport({
            baseRef: "abc",
            reviewMdSha: {baseline: "a".repeat(64), candidate: "b".repeat(64)},
            arms: {baseline, candidate},
            regressions: diffRegressions(baseline, candidate),
            adversarialFailures: [],
            gateRetries: [],
        });
        expect(markdown).toContain("| Misses found-but-dropped | 0 | 1 |");
        expect(markdown).toContain(
            "- case-1:bug (found but dropped at the provenance gate)",
        );
    });

    it("renders judge errors as degradation notes, not omissions", async () => {
        const baseline = await runArm(
            "baseline",
            [liveCase("case-1")],
            produceHit(1),
            {maxUsd: 100},
        );
        const candidate = await runArm(
            "candidate",
            [liveCase("case-1")],
            produceHit(1),
            {maxUsd: 100},
        );
        candidate.judgeError = "judge call failed: 500";
        const markdown = renderMarkdownReport({
            baseRef: "abc",
            reviewMdSha: {baseline: "a".repeat(64), candidate: "b".repeat(64)},
            arms: {baseline, candidate},
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });
        expect(markdown).toContain("Judge scoring failed");
        expect(markdown).toContain("- candidate: judge call failed: 500");
    });
});
