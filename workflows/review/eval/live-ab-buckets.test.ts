import {describe, it, expect} from "vitest";

import {parseCase} from "./corpus/loader";
import {runArm, type ArmProduce} from "./live-ab";

/**
 * The per-case noise buckets `runArm` writes into `perCase` (posted, noise,
 * duplicates, legitimateUnspecced) and their agreement with the pooled
 * metric. Split from live-ab.test.ts on file size.
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

describe("runArm per-case noise buckets", () => {
    it("reports each case's noise buckets from the one shared definition", async () => {
        // perCase.noise must read the same quantity computeLiveMetrics pools
        // (unmatched plus duplicates), with may-flag matches outside it.
        const withMayFlag = parseCase(
            {
                id: "case-1",
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
                    mayFlagSpecs: [
                        {
                            key: "real-but-unspecced",
                            path: "src/a.ts",
                            lineStart: 1,
                            lineEnd: 2,
                            mechanism: ["rounding drifts"],
                        },
                    ],
                },
            },
            "test://case-1",
        );
        const copy = {
            ...hitFinding,
            id: "live-copy",
            failure_scenario: "the constant changed here as well.",
        };
        const legit = {
            ...hitFinding,
            id: "live-legit",
            severity: "advisory",
            failure_scenario: "the rounding drifts by a cent on large carts.",
            model_authored_prose: "Rounding drifts.",
        };
        const template = {
            ...hitFinding,
            id: "live-template",
            severity: "advisory",
            failure_scenario: "no test covers this path.",
            model_authored_prose: "Add a test.",
        };
        const produce: ArmProduce = async () => ({
            findings: [hitFinding, copy, legit, template].map((finding) => ({
                source: "correctness",
                finding: finding as never,
            })),
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
        const report = await runArm("candidate", [withMayFlag], produce, {
            maxUsd: 10,
        });
        expect(report.perCase[0]).toMatchObject({
            posted: 4,
            noise: 2,
            duplicates: 1,
            legitimateUnspecced: 1,
        });
        expect(report.metrics.noise).toMatchObject({
            numerator: 2,
            denominator: 4,
            duplicates: 1,
        });
        expect(report.metrics.legitimateUnspecced.numerator).toBe(1);
    });
});
