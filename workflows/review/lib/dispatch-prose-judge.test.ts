import {describe, expect, it} from "vitest";

import {runDispatch, type AgentRunner} from "./dispatch";
import type {DispatchFs} from "./dispatch-agents";
import {computeDiffProvenance} from "./provenance";

/**
 * The prose judge's runDispatch wiring (PRA-45): gate construction per
 * agent, record collection, the fallback-skip record, the `proseJudge`
 * result block, and the double-staged artifact. Split from dispatch.test.ts
 * for its max-lines budget (the same cap that split dispatch.ts itself);
 * the fixtures are local copies of that file's minimal staging.
 */

const REVIEW = "/tmp/gh-aw/review";
const AGENTS = "/work/.claude/agents";

const makeFakeFs = (
    files: Record<string, string> = {},
): DispatchFs & {files: Record<string, string>} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) =>
            p in state || Object.keys(state).some((f) => f.startsWith(`${p}/`)),
        mkdirSync: () => {},
        readdirSync: (p: string) => {
            const prefix = `${p}/`;
            return [
                ...new Set(
                    Object.keys(state)
                        .filter((f) => f.startsWith(prefix))
                        .map((f) => f.slice(prefix.length).split("/")[0]),
                ),
            ];
        },
    };
};

const agentFile = (name: string): string =>
    `---\nname: ${name}\ndescription: d\nmodel: claude-opus-4-8\n---\nYou are ${name}.`;

const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "+added line",
    " ctx",
    "",
].join("\n");

const staging = (): Record<string, string> => ({
    [`${REVIEW}/routing.json`]: JSON.stringify({
        enabledReviewers: [],
        lensesToSpawn: [],
        runBudget: {maxReviewerInvocations: 6, tier: "High"},
    }),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({depth: "full"}),
    [`${REVIEW}/full.diff`]: DIFF,
    [`${REVIEW}/files.json`]: JSON.stringify([
        {path: "a.ts", status: "modified", hasPatch: true},
    ]),
    [`${REVIEW}/provenance.json`]: JSON.stringify(computeDiffProvenance(DIFF)),
    ...Object.fromEntries(
        [
            "pattern-triage",
            "correctness-reviewer",
            "skill-auditor",
            "claim-validator",
        ].map((name) => [`${AGENTS}/${name}.md`, agentFile(name)]),
    ),
});

const canned: Record<string, string> = {
    "pattern-triage": JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
    "correctness-reviewer": JSON.stringify({
        findings: [
            {
                path: "a.ts",
                line: 2,
                label: "issue (blocking)",
                subject: "Broken guard.",
                discussion: "The guard was removed.",
                failure_scenario: "nil deref on empty input",
            },
        ],
        files: [{path: "a.ts", risk: "high"}],
    }),
    "skill-auditor": JSON.stringify({findings: []}),
    "claim-validator": JSON.stringify({
        claims: [
            {
                id: "correctness-reviewer-1",
                verification: "confirmed",
                confidence: 0.9,
            },
        ],
    }),
};

const options = (fs: DispatchFs, runner: AgentRunner) => ({
    fs,
    runner,
    repoRoot: "/work",
});

describe("the prose judge wiring (PRA-45)", () => {
    it("builds a gate per agent, collects records, and stages the artifact twice", async () => {
        // A runner that submits through the gate (the structured path) for
        // the correctness reviewer and free-texts everything else, so one
        // run exercises gate records AND the fallback-skip record.
        const judged: string[] = [];
        const runner = (async (request) => {
            const output = canned[request.name];
            if (
                request.name === "correctness-reviewer" &&
                request.judgeProse !== undefined
            ) {
                const rejection = await request.judgeProse(
                    JSON.parse(output) as Record<string, unknown>,
                );
                expect(rejection).toBeNull();
                return {
                    output,
                    usd: 0.5,
                    turns: 3,
                    wallMs: 100,
                    structured: true,
                };
            }
            return {output, usd: 0.5, turns: 3, wallMs: 100};
        }) as AgentRunner;
        const fs = makeFakeFs(staging());
        const result = await runDispatch({
            ...options(fs, runner),
            proseRunner: (prompt) => {
                judged.push(prompt);
                return Promise.resolve('{"pass": true, "problems": []}');
            },
        });
        // One judge call: the correctness payload's single finding.
        expect(judged).toHaveLength(1);
        expect(judged[0]).toContain("The guard was removed.");
        expect(result.proseJudge).toBeDefined();
        // 1 pass (the judged finding) + 3 fallback skips (triage, auditor,
        // validator all arrived unstructured).
        expect(result.proseJudge?.counts.pass).toBe(1);
        expect(result.proseJudge?.counts.skipped).toBe(3);
        expect(result.proseJudge?.counts.error).toBe(0);
        const skipped = result.proseJudge?.verdicts.filter(
            (record) => record.state === "skipped",
        );
        expect(skipped?.map((record) => record.source).sort()).toEqual([
            "claim-validator",
            "pattern-triage",
            "skill-auditor",
        ]);
        // Staged BOTH places: the review dir and out/ (the artifact upload
        // carries out/** only; a review-dir-only file is invisible post-run).
        expect(fs.files[`${REVIEW}/judge-prose-verdicts.json`]).toBe(
            fs.files[`${REVIEW}/out/judge-prose-verdicts.json`],
        );
        expect(
            JSON.parse(fs.files[`${REVIEW}/judge-prose-verdicts.json`]).counts
                .pass,
        ).toBe(1);
        // The dispatch result carries the same accounting.
        expect(
            (
                JSON.parse(fs.files[`${REVIEW}/dispatch-result.json`]) as {
                    proseJudge: {counts: {pass: number}};
                }
            ).proseJudge.counts.pass,
        ).toBe(1);
    });

    it("judges nothing and stages nothing without a proseRunner", async () => {
        const fs = makeFakeFs(staging());
        const runner = (async (request) => ({
            output: canned[request.name],
            usd: 0.5,
            turns: 3,
            wallMs: 100,
        })) as AgentRunner;
        const result = await runDispatch(options(fs, runner));
        expect(result.proseJudge).toBeUndefined();
        expect(fs.files[`${REVIEW}/judge-prose-verdicts.json`]).toBeUndefined();
    });
});
