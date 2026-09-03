import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {extractSamples} from "./aggregate";
import {parseCase, type CorpusCase} from "./corpus/loader";
import {
    createCheckpointer,
    runArm,
    type AbReport,
    type ArmProduce,
    type ArmRunReport,
    type MultiAbReport,
    type RunHeader,
} from "./live-ab";
import {withDispatchProgress} from "./live-ab-progress";
import type {LiveAgentRunner} from "./live-producer";

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

/** A scripted runner in live-producer.test.ts's shape: fixed cost, a tool
 * call count only for the agent that reports one, and the requests kept. */
const scriptedRunner = (): {runner: LiveAgentRunner; names: string[]} => {
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
const producerOver =
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

const header: RunHeader = {
    baseRef: "abc123",
    reviewMdSha: {baseline: "a".repeat(64), candidate: "b".repeat(64)},
    provenance: {
        matcher: "deterministic",
        corpusSha: "c".repeat(64),
        caseCount: 2,
    },
};

describe("live A/B progress lines", () => {
    let stderr: string[];
    let stdout: string[];
    beforeEach(() => {
        stderr = [];
        stdout = [];
        vi.spyOn(process.stderr, "write").mockImplementation(((
            chunk: string | Uint8Array,
        ) => {
            stderr.push(String(chunk));
            return true;
        }) as typeof process.stderr.write);
        vi.spyOn(process.stdout, "write").mockImplementation(((
            chunk: string | Uint8Array,
        ) => {
            stdout.push(String(chunk));
            return true;
        }) as typeof process.stdout.write);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits one line per dispatch end and one per case end, on stderr only", async () => {
        const {runner} = scriptedRunner();
        const cases = [liveCase("case-1"), liveCase("case-2")];
        await runArm("baseline", cases, producerOver("baseline", runner), {
            maxUsd: 10,
        });

        const lines = stderr
            .join("")
            .split("\n")
            .filter((l) => l !== "");
        expect(stdout).toEqual([]);
        // Two dispatches then the case line, twice.
        expect(lines.map((l) => l.split("] ")[1]?.split(":")[0])).toEqual([
            "correctness-reviewer (m)",
            "claim-validator (m)",
            "case done",
            "correctness-reviewer (m)",
            "claim-validator (m)",
            "case done",
        ]);
        expect(lines[0]).toBe(
            "[baseline/case-1] correctness-reviewer (m): $0.25, 3 turns, 1s, 12 tool calls",
        );
        // No tool-call count when the runner reports none.
        expect(lines[1]).toBe(
            "[baseline/case-1] claim-validator (m): $0.25, 3 turns, 1s",
        );
        expect(lines[2]).toBe(
            "[baseline/case-1] case done: verdict REQUEST_CHANGES (as expected), " +
                "caught bug, missed none, $0.50 this case, $0.50 so far (1/2 cases)",
        );
        expect(lines[5]).toBe(
            "[baseline/case-2] case done: verdict REQUEST_CHANGES (as expected), " +
                "caught bug, missed none, $0.50 this case, $1.00 so far (2/2 cases)",
        );
    });

    it("labels a repeat's arm with its suffix and names a verdict miss", async () => {
        const produceMiss: ArmProduce = async () => ({
            findings: [],
            validation: [],
            perAgent: [],
        });
        await runArm("candidate", [liveCase("case-1")], produceMiss, {
            maxUsd: 10,
            label: "candidate-r2",
        });
        expect(stderr.join("")).toBe(
            "[candidate-r2/case-1] case done: verdict APPROVE (expected " +
                "REQUEST_CHANGES), caught none, missed bug, $0.00 this case, " +
                "$0.00 so far (1/1 cases)\n",
        );
    });

    it("reports a dispatch that threw, then rethrows", async () => {
        const failing: LiveAgentRunner = async () => {
            throw new Error("boom");
        };
        const dispatch = withDispatchProgress(failing, {
            arm: "baseline",
            caseId: "case-1",
        });
        await expect(
            dispatch({
                name: "correctness-reviewer",
                model: "m",
                prompt: "p",
                cwd: "/",
                maxTurns: 1,
                timeoutMs: 1,
            }),
        ).rejects.toThrow("boom");
        expect(stderr.join("")).toBe(
            "[baseline/case-1] correctness-reviewer (m): dispatch threw: boom\n",
        );
    });
});

describe("live A/B checkpoints", () => {
    let dir: string;
    let outPath: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "live-ab-ckpt-"));
        outPath = join(dir, "out", "live-ab-report.json");
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, {recursive: true, force: true});
    });

    const readJson = (): AbReport | MultiAbReport =>
        JSON.parse(readFileSync(outPath, "utf8")) as AbReport | MultiAbReport;
    const readMd = (): string =>
        readFileSync(outPath.replace(/\.json$/, ".md"), "utf8");

    it("writes a partial report after every case and a full one at the end", async () => {
        const {runner} = scriptedRunner();
        const cases = [liveCase("case-1"), liveCase("case-2")];
        const ckpt = createCheckpointer({outPath, repeats: 1, header});
        expect(existsSync(outPath)).toBe(false);

        const seen: {baseline: number; candidate: number; partial?: true}[] =
            [];
        const observe = (): void => {
            const report = readJson() as AbReport;
            seen.push({
                baseline: report.arms.baseline.runs.length,
                candidate: report.arms.candidate.runs.length,
                ...(report.partial === true ? {partial: true} : {}),
            });
        };

        const baseline = await runArm(
            "baseline",
            cases,
            producerOver("baseline", runner),
            {
                maxUsd: 10,
                onCase: (soFar) => {
                    ckpt.baselineCase(soFar);
                    observe();
                },
            },
        );
        // After case 1 of 2 on the baseline arm: a partial report with the
        // candidate arm still empty, and the markdown header says so.
        expect(seen[0]).toEqual({baseline: 1, candidate: 0, partial: true});
        expect(readMd()).toContain("## Review live A/B (partial)");
        expect(readMd()).toContain(
            "PARTIAL REPORT: a checkpoint written mid-run",
        );
        expect(readMd()).toContain(
            "So far baseline scored 2 of 2 cases, candidate 0 of 2.",
        );

        const candidate = await runArm(
            "candidate",
            cases,
            producerOver("candidate", runner),
            {
                maxUsd: 10,
                onCase: (soFar) => {
                    ckpt.candidateCase(baseline)(soFar);
                    observe();
                },
            },
        );
        expect(seen).toEqual([
            {baseline: 1, candidate: 0, partial: true},
            {baseline: 2, candidate: 0, partial: true},
            {baseline: 2, candidate: 1, partial: true},
            {baseline: 2, candidate: 2, partial: true},
        ]);
        // A partial single-run report pools nothing.
        expect(extractSamples("ckpt", readJson())).toEqual([]);

        ckpt.repeatDone({
            ...header,
            arms: {baseline, candidate},
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });
        const {payload, markdown, candidateRunCount} = ckpt.finish();
        expect(candidateRunCount).toBe(2);
        expect((payload as AbReport).partial).toBeUndefined();
        expect((readJson() as AbReport).partial).toBeUndefined();
        expect(markdown).toContain("## Review live A/B\n");
        expect(readMd()).not.toContain("partial");
        expect(readMd()).not.toContain("PARTIAL");
        expect(extractSamples("final", readJson()).length).toBe(1);
    });

    it("marks a repeated run partial until the last repeat finishes", async () => {
        const {runner} = scriptedRunner();
        const cases = [liveCase("case-1")];
        const oneCase: RunHeader = {
            ...header,
            provenance: {...header.provenance, caseCount: 1},
        };
        const ckpt = createCheckpointer({outPath, repeats: 2, header: oneCase});
        const armOf = (arm: "baseline" | "candidate"): Promise<ArmRunReport> =>
            runArm(arm, cases, producerOver(arm, runner), {maxUsd: 10});
        const pair = async (): Promise<AbReport> => ({
            ...header,
            arms: {
                baseline: await armOf("baseline"),
                candidate: await armOf("candidate"),
            },
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });

        const first = await pair();
        ckpt.repeatDone(first);
        const afterOne = readJson() as MultiAbReport;
        expect(afterOne.partial).toBe(true);
        expect(afterOne.repeats.length).toBe(1);
        expect(readMd()).toContain("## Review live A/B: 2 repeats (partial)");
        expect(readMd()).toContain("1 of 2 repeats finished.");
        // The finished repeat pools, nothing else does yet.
        expect(extractSamples("ckpt", afterOne).length).toBe(1);

        // Mid-repeat 2: the in-progress repeat rides along, itself partial.
        await runArm("baseline", cases, producerOver("baseline-r2", runner), {
            maxUsd: 10,
            onCase: ckpt.baselineCase,
        });
        const midTwo = readJson() as MultiAbReport;
        expect(midTwo.partial).toBe(true);
        expect(midTwo.repeats.length).toBe(2);
        expect(midTwo.repeats[1]?.partial).toBe(true);
        expect(readMd()).toContain(
            "1 of 2 repeats finished, repeat 2 in progress (baseline scored 1 of 1 cases, candidate 0 of 1).",
        );
        expect(extractSamples("ckpt", midTwo).length).toBe(1);

        ckpt.repeatDone(await pair());
        const {payload} = ckpt.finish();
        expect((payload as MultiAbReport).partial).toBeUndefined();
        expect((readJson() as MultiAbReport).partial).toBeUndefined();
        expect(readMd()).toContain("## Review live A/B: 2 repeats\n");
        expect(extractSamples("final", readJson()).length).toBe(2);
    });
});
