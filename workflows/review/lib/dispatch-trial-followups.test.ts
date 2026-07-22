import {describe, it, expect} from "vitest";

import {
    contractValidator,
    runDispatch,
    type AgentRunner,
    type DispatchFs,
} from "./dispatch";
import {computeDiffProvenance} from "./provenance";
import {subAgentEnv} from "./dispatch-runner";

/**
 * Post-trial follow-up tests for the scripted dispatcher: the
 * structured-final `submit_result` channel (trial suggestion h) and
 * open-thread suppression (trial suggestion g). Split from dispatch.test.ts
 * for its max-lines budget; the fixtures mirror that file's.
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
    `---\nname: ${name}\ndescription: d\nmodel: claude-opus-4-8\n---\nYou are ${name}. Read from disk and return JSON.`;

const agentFiles = (...names: string[]): Record<string, string> =>
    Object.fromEntries(
        names.map((name) => [`${AGENTS}/${name}.md`, agentFile(name)]),
    );

/** A runner stub: canned final text per agent, throwing for names in fail. */
const stubRunner = (
    outputs: Record<string, string>,
    fail: string[] = [],
): AgentRunner & {calls: string[]} => {
    const calls: string[] = [];
    const runner = (async (request) => {
        calls.push(request.name);
        if (fail.includes(request.name)) {
            throw new Error("boom");
        }
        const output = outputs[request.name];
        if (output === undefined) {
            throw new Error(`no canned output for ${request.name}`);
        }
        return {output, usd: 0.5, turns: 3, wallMs: 100};
    }) as AgentRunner & {calls: string[]};
    runner.calls = calls;
    return runner;
};

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

const baseStaging = (): Record<string, string> => ({
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
});

const CORRECTNESS_OUT = JSON.stringify({
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
});

const EMPTY_FINDINGS = JSON.stringify({findings: []});

const TRIAGE_OK = JSON.stringify({patterns: [], reviewFiles: ["a.ts"]});

const VALIDATOR_CONFIRM = JSON.stringify({
    claims: [
        {
            id: "correctness-reviewer-1",
            verification: "confirmed",
            confidence: 0.9,
        },
    ],
});

describe("structured finals (trial suggestion h)", () => {
    it("builds contract checks that reject drifted shapes and accept the contract", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const validators: Record<
            string,
            (payload: Record<string, unknown>) => string | null
        > = {};
        const runner: AgentRunner = async (request) => {
            if (request.validate !== undefined) {
                validators[request.name] = request.validate;
            }
            return {
                output: {
                    "pattern-triage": TRIAGE_OK,
                    "correctness-reviewer": CORRECTNESS_OUT,
                    "skill-auditor": EMPTY_FINDINGS,
                    "claim-validator": VALIDATOR_CONFIRM,
                }[request.name] as string,
                usd: 0.5,
                turns: 3,
                wallMs: 100,
            };
        };
        await runDispatch({fs, runner, repoRoot: "/work"});

        // Every dispatch carried a contract check.
        expect(Object.keys(validators).sort()).toEqual([
            "claim-validator",
            "correctness-reviewer",
            "pattern-triage",
            "skill-auditor",
        ]);
        const finder = validators["correctness-reviewer"];
        // The defect-13 drift class: a ReportFindings-style object with no
        // Conventional Comments label is rejected with the exact contract
        // message, in-session, instead of voiding the dimension.
        expect(
            finder({
                findings: [
                    {
                        file: "a.ts",
                        line: 2,
                        summary: "Broken guard.",
                        severity: "blocking",
                        verdict: "CONFIRMED",
                    },
                ],
            }),
        ).toMatch(/label/);
        expect(finder(JSON.parse(CORRECTNESS_OUT))).toBeNull();
        // The validator's contract: a claims array is required.
        expect(validators["claim-validator"]({})).toMatch(/claims array/);
        expect(
            validators["claim-validator"](JSON.parse(VALIDATOR_CONFIRM)),
        ).toBeNull();
        // Triage tolerates any object (downstream fails toward more review).
        expect(validators["pattern-triage"]({})).toBeNull();
    });

    it("records a structured final in the per-agent report and acts on its payload", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const runner: AgentRunner = async (request) => ({
            output: {
                "pattern-triage": TRIAGE_OK,
                "correctness-reviewer": CORRECTNESS_OUT,
                "skill-auditor": EMPTY_FINDINGS,
                "claim-validator": VALIDATOR_CONFIRM,
            }[request.name] as string,
            usd: 0.5,
            turns: 3,
            wallMs: 100,
            ...(request.name === "correctness-reviewer"
                ? {structured: true}
                : {}),
        });
        const result = await runDispatch({fs, runner, repoRoot: "/work"});

        const correctness = result.perAgent.find(
            (agent) => agent.name === "correctness-reviewer",
        );
        expect(correctness?.structuredFinal).toBe(true);
        expect(
            result.perAgent.find((agent) => agent.name === "skill-auditor")
                ?.structuredFinal,
        ).toBeUndefined();
        // The structured payload flowed through the normal collection path.
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].source).toBe("correctness-reviewer");
    });

    it("does not perturb id-collision handling (validation uses a throwaway id set)", () => {
        const check = contractValidator("correctness-reviewer", "finder");
        const payload = JSON.parse(CORRECTNESS_OUT) as Record<string, unknown>;
        // Two validations of the same payload both pass: no shared id state.
        expect(check(payload)).toBeNull();
        expect(check(payload)).toBeNull();
    });
});

describe("open-thread suppression (trial suggestion g)", () => {
    const THREADS = JSON.stringify([
        {
            thread_id: "T1",
            path: "a.ts",
            line: 60,
            url: "https://github.com/x/y/pull/1#discussion_r1",
            comments: [
                {
                    author: "github-actions[bot]",
                    body: "**issue (blocking):** Broken guard. The guard was removed. nil deref on empty input",
                },
            ],
        },
    ]);
    const outputs = (reconciler: Record<string, unknown>) => ({
        "pattern-triage": TRIAGE_OK,
        "correctness-reviewer": CORRECTNESS_OUT,
        "skill-auditor": EMPTY_FINDINGS,
        "thread-reconciler": JSON.stringify(reconciler),
    });
    const staging = () => ({
        ...baseStaging(),
        [`${REVIEW}/threads.json`]: THREADS,
        ...agentFiles(
            "pattern-triage",
            "correctness-reviewer",
            "skill-auditor",
            "claim-validator",
            "thread-reconciler",
        ),
    });

    it("suppresses a re-flag of an open thread's defect, skipping validation, noting it, and recording it", async () => {
        const runner = stubRunner(
            outputs({resolve: [], keep: ["T1"], skipLines: []}),
        );
        const result = await runDispatch({
            fs: makeFakeFs(staging()),
            runner,
            repoRoot: "/work",
        });
        // The one candidate duplicated the open thread: nothing to post,
        // nothing to validate (the validator dispatch is saved).
        expect(result.claims).toEqual([]);
        expect(runner.calls).not.toContain("claim-validator");
        expect(result.threadSuppressions).toEqual([
            {
                id: "correctness-reviewer-1",
                source: "correctness-reviewer",
                label: "issue (blocking)",
                path: "a.ts",
                line: 2,
                thread_id: "T1",
            },
        ]);
        expect(result.noteLines).toEqual([
            "Note: 1 finding(s) not re-posted (already tracked in open review threads).",
        ]);
    });

    it("does not suppress against a thread the reconciler resolves this run", async () => {
        const runner = stubRunner(
            outputs({resolve: ["T1"], keep: [], skipLines: []}),
        );
        const fs = makeFakeFs({
            ...staging(),
        });
        const result = await runDispatch({fs, runner, repoRoot: "/work"});
        // The thread is being resolved, so the re-flag is a fresh finding:
        // it survives to validation (which retains it unvalidated here:
        // the stub has no validator output, so the unavailable note posts).
        expect(result.threadSuppressions).toEqual([]);
        expect(result.claims).toHaveLength(1);
    });
});

describe("subAgentEnv (the orchestrator effort dial never reaches sub-agents)", () => {
    it("strips CLAUDE_CODE_EFFORT_LEVEL and undefined values, keeps the rest", () => {
        expect(
            subAgentEnv({
                CLAUDE_CODE_EFFORT_LEVEL: "low",
                REVIEW_REPO_ROOT: "/work",
                EMPTY: undefined,
            }),
        ).toEqual({REVIEW_REPO_ROOT: "/work"});
    });
});
