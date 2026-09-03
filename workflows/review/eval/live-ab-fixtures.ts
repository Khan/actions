/**
 * Shared stubs for the live A/B runner tests (`live-ab-progress.test.ts`,
 * `live-ab-checkpoint.test.ts`): a one-spec live case, the finding that
 * catches it, a scripted runner in `live-producer.test.ts`'s shape, and a
 * producer that dispatches two agents per case through a wrapped runner the
 * way `produceLive` would. Test-only, in the `judge-prose-fixtures.ts` mould.
 */

import {parseCase, type CorpusCase} from "./corpus/loader";
import type {ArmProduce, RunHeader} from "./live-ab";
import {withDispatchProgress} from "./live-ab-progress";
import type {LiveAgentRunner} from "./live-producer";

export const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

export const liveCase = (id: string, category = "incident-repro"): CorpusCase =>
    parseCase(
        {
            id,
            tags: ["live"],
            category,
            description: "progress fixture",
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

export const hitFinding = {
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

/** A scripted runner in live-producer.test.ts's shape: fixed cost, a tool
 * call count only for the agent that reports one, and the requests kept. */
export const scriptedRunner = (): {
    runner: LiveAgentRunner;
    names: string[];
} => {
    const names: string[] = [];
    const runner: LiveAgentRunner = async (request) => {
        names.push(request.name);
        return {
            output: "{}",
            usd: 0.25,
            turns: 3,
            wallMs: 1000,
            ...(request.name === "correctness-reviewer" ? {toolCalls: 12} : {}),
        };
    };
    return {runner, names};
};

/**
 * A stub producer that dispatches two agents per case through the wrapped
 * runner (the way `produceLive` would) and catches the bug at their summed
 * cost.
 */
export const producerOver =
    (arm: string, runner: LiveAgentRunner): ArmProduce =>
    async (corpusCase) => {
        const dispatch = withDispatchProgress(runner, {
            arm,
            caseId: corpusCase.id,
        });
        const request = {
            model: "m",
            prompt: "p",
            cwd: "/",
            maxTurns: 1,
            timeoutMs: 1000,
        };
        const first = await dispatch({
            ...request,
            name: "correctness-reviewer",
        });
        const second = await dispatch({...request, name: "claim-validator"});
        return {
            findings: [{source: "correctness", finding: hitFinding as never}],
            validation: [],
            perAgent: [
                {
                    name: "correctness-reviewer",
                    model: "m",
                    usd: first.usd,
                    turns: 1,
                    wallMs: 10,
                    retried: false,
                    toolCalls: first.toolCalls,
                },
                {
                    name: "claim-validator",
                    model: "m",
                    usd: second.usd,
                    turns: 1,
                    wallMs: 10,
                    retried: false,
                },
            ],
        };
    };

export const header: RunHeader = {
    baseRef: "abc123",
    reviewMdSha: {baseline: "a".repeat(64), candidate: "b".repeat(64)},
    provenance: {
        matcher: "deterministic",
        corpusSha: "c".repeat(64),
        caseCount: 2,
    },
};
