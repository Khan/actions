import {describe, it, expect} from "vitest";

import {parseCase, type CorpusCase} from "./corpus/loader";
import {renderMarkdownReport, runArm, type ArmProduce} from "./live-ab";
import {armToolCalls} from "./live-ab-report";

/**
 * The report rows that read cost and volume apart. Split from live-ab.test.ts
 * at the max-lines cap; the fixture is the same minimal live case.
 */

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

const liveCase = (id: string): CorpusCase =>
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
        },
        `test://${id}`,
    );

const withCalls =
    (usd: number, calls?: number): ArmProduce =>
    async () => ({
        findings: [],
        validation: [],
        perAgent: [
            {
                name: "correctness-reviewer",
                model: "m",
                usd,
                turns: 1,
                wallMs: 10,
                retried: false,
                ...(calls === undefined ? {} : {toolCalls: calls}),
            },
        ],
    });

describe("armToolCalls", () => {
    it("sums every agent's count and is undefined when no agent reported one", async () => {
        const counted = await runArm(
            "baseline",
            [liveCase("c")],
            withCalls(1, 7),
            {
                maxUsd: 10,
            },
        );
        expect(armToolCalls(counted)).toBe(7);
        const uncounted = await runArm(
            "baseline",
            [liveCase("c")],
            withCalls(1),
            {
                maxUsd: 10,
            },
        );
        expect(armToolCalls(uncounted)).toBeUndefined();
    });
});

describe("renderMarkdownReport cost rows", () => {
    it("renders tool calls and cost per call beside cost, so volume and rate read apart", async () => {
        // The gemini-3.8-flash A/B's 1.5x cost delta was a 3.8x tool-call
        // delta at 2.8x cheaper per call, and the table could not say so.
        const withCalls =
            (usd: number, calls: number): ArmProduce =>
            async () => ({
                findings: [],
                validation: [],
                perAgent: [
                    {
                        name: "correctness-reviewer",
                        model: "m",
                        usd,
                        turns: 1,
                        wallMs: 10,
                        retried: false,
                        toolCalls: calls,
                    },
                ],
            });
        const baseline = await runArm(
            "baseline",
            [liveCase("case-1")],
            withCalls(6, 300),
            {maxUsd: 10},
        );
        const candidate = await runArm(
            "candidate",
            [liveCase("case-1")],
            withCalls(9, 1200),
            {maxUsd: 10},
        );
        const markdown = renderMarkdownReport({
            baseRef: "origin/main",
            reviewMdSha: {baseline: "a".repeat(12), candidate: "b".repeat(12)},
            arms: {baseline, candidate},
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });
        expect(markdown).toContain("| Tool calls | 300 | 1200 | 4.00x |");
        expect(markdown).toContain(
            "| Cost per tool call | $0.0200 | $0.0075 |",
        );
        expect(markdown).toContain("| Cost (list price) | $6.00 | $9.00 |");
    });
});
