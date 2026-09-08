/**
 * Shared fixtures for the live-match tests: a small diff, a posted-candidate
 * builder for direct `matchesSpec` calls, a spec builder, and `liveRun`,
 * which parses a live case around the posted set a test controls and runs
 * the deterministic pipeline over it.
 */

import {parseCase, type LiveDefectSpec} from "./corpus/loader";
import {runCase, type RunCandidate} from "./runner";

export const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    "-const total = round(cents);",
    "+const total = subtotal * 1.08;",
    "+const rounded = total.toFixed(2);",
    " export {compute};",
    " // end",
    "",
].join("\n");

/** A minimal posted candidate for direct matchesSpec tests. */
export const candidate = (over: Partial<RunCandidate> = {}): RunCandidate => ({
    id: "cand-1",
    source: "correctness",
    lens: "correctness",
    label: "issue (blocking)",
    blocking: true,
    anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
    path: "src/a.ts",
    line: 1,
    body: "**issue (blocking):** float math",
    finding: {
        schema_version: 2,
        id: "cand-1",
        lens: "correctness",
        anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
        severity: "blocking",
        confidence: 0.8,
        evidence_trace: ["e"],
        failure_scenario:
            "totals computed in floating point drift by a cent on large carts.",
        producing_hunt: "h",
        model_authored_prose: "The tax total uses float math and rounds late.",
    },
    ...over,
});

export const spec = (over: Partial<LiveDefectSpec> = {}): LiveDefectSpec => ({
    key: "bug-1",
    path: "src/a.ts",
    lineStart: 1,
    lineEnd: 3,
    mechanism: ["float(ing)?[- ]?point", "rounds? late"],
    ...over,
});

/** Build a live case + deterministic run whose posted set we control. */
export const liveRun = (over: {
    id?: string;
    category?: string;
    mustCatchSpecs?: LiveDefectSpec[];
    mustNotFlagSpecs?: LiveDefectSpec[];
    mayFlagSpecs?: LiveDefectSpec[];
    findings?: unknown[];
    expectedVerdict?: string;
}) => {
    const corpusCase = parseCase(
        {
            id: over.id ?? "match-case",
            tags: ["live"],
            category: over.category ?? "incident-repro",
            description: "matcher fixture",
            changedFiles: [{path: "src/a.ts", status: "modified"}],
            expected: {verdict: over.expectedVerdict ?? "REQUEST_CHANGES"},
            diff: DIFF,
            findings: (over.findings ?? []).map((raw) => {
                const {source, ...finding} = raw as {
                    source?: string;
                    lens?: string;
                };
                return {
                    source: source ?? finding.lens ?? "correctness",
                    finding,
                };
            }),
            live: {
                prContext: {
                    title: "t",
                    description: "",
                    author: "a",
                    baseBranch: "main",
                },
                ...(over.mustCatchSpecs
                    ? {mustCatchSpecs: over.mustCatchSpecs}
                    : {}),
                ...(over.mustNotFlagSpecs
                    ? {mustNotFlagSpecs: over.mustNotFlagSpecs}
                    : {}),
                ...(over.mayFlagSpecs ? {mayFlagSpecs: over.mayFlagSpecs} : {}),
            },
        },
        `test://${over.id ?? "match-case"}`,
    );
    return {corpusCase, result: runCase(corpusCase)};
};

export const finding = (id: string, prose: string, severity = "blocking") => ({
    schema_version: 2,
    id,
    lens: "correctness",
    anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
    severity,
    confidence: 0.8,
    evidence_trace: ["e"],
    failure_scenario: prose,
    producing_hunt: "h",
    model_authored_prose: prose,
});
