import {describe, it, expect} from "vitest";

import {parseCase, type CorpusCase} from "./corpus/loader";
import {
    adversarialGateFailures,
    diffRegressions,
    renderMarkdownReport,
    runArm,
    type AbReport,
    type ArmProduce,
    type ArmRunReport,
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
        };
        const markdown = renderMarkdownReport(report);
        expect(markdown).toContain("| Must-catch recall | 100% | 0% |");
        expect(markdown).toContain(
            "Regressions (baseline caught, candidate missed)",
        );
        expect(markdown).toContain("- case-1:bug");
        expect(markdown).toContain("Adversarial hard gate: PASSED");
        expect(markdown).toContain("SKIPPED (budget exhausted");
        expect(markdown).toContain("- candidate:case-2");
        // The stability footer closes every report, so a reader always sees
        // which rows are single-run signals and which are cross-run trends.
        expect(markdown.trimEnd().endsWith("load-bearing metric.*")).toBe(true);
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
        });
        expect(markdown).toContain("Adversarial hard gate: FAILED");
        expect(markdown).toContain("- adv-1: missed spec bug");
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
        });
        expect(markdown).toContain("Judge scoring failed");
        expect(markdown).toContain("- candidate: judge call failed: 500");
    });
});
