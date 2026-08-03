import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {computeDiffProvenance} from "./provenance";

/**
 * Malformed-output leniency and the single contract-parse retry (trial run
 * 29893634730), exercised end to end through runDispatch.
 *
 * Split from dispatch.test.ts for file size; the subject is one behavior of
 * dispatch-calls.ts: what happens when an agent's final text does not parse
 * against its contract, including the out-of-turns case where "fix your JSON"
 * is the wrong corrective note.
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

const agentFile = (name: string, model = "claude-opus-4-8"): string =>
    `---\nname: ${name}\ndescription: d\nmodel: ${model}\n---\nYou are ${name}. Read from disk and return JSON.`;

const agentFiles = (...names: string[]): Record<string, string> =>
    Object.fromEntries(
        names.map((name) => [`${AGENTS}/${name}.md`, agentFile(name)]),
    );

/** A runner stub: canned final text per agent, one output per name. */
const stubRunner = (
    outputs: Record<string, string>,
): AgentRunner & {calls: string[]} => {
    const calls: string[] = [];
    const runner = (async (request) => {
        calls.push(request.name);
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

const VALIDATOR_CONFIRM = JSON.stringify({
    claims: [
        {
            id: "correctness-reviewer-1",
            verification: "confirmed",
            confidence: 0.9,
        },
    ],
});

describe("prose-wrapped outputs and the malformed-output retry", () => {
    const options = (fs: DispatchFs, runner: AgentRunner) => ({
        fs,
        runner,
        repoRoot: "/work",
    });

    /** A runner whose canned outputs are consumed per call, in order. */
    const sequencedRunner = (
        sequences: Record<string, string[]>,
    ): AgentRunner & {calls: string[]} => {
        const remaining = Object.fromEntries(
            Object.entries(sequences).map(([k, v]) => [k, [...v]]),
        );
        const calls: string[] = [];
        const runner = (async (request) => {
            calls.push(request.name);
            const output = remaining[request.name]?.shift();
            if (output === undefined) {
                throw new Error(`no canned output for ${request.name}`);
            }
            return {output, usd: 0.5, turns: 3, wallMs: 100};
        }) as AgentRunner & {calls: string[]};
        runner.calls = calls;
        return runner;
    };

    const staging = () => ({
        ...baseStaging(),
        ...agentFiles(
            "pattern-triage",
            "correctness-reviewer",
            "skill-auditor",
            "claim-validator",
        ),
    });

    it("parses the run-29893634730 correctness shape without a retry: prose, a json fence, and no findings key", async () => {
        const proseFenced = [
            "Investigation complete. The commit-limit concern is refuted.",
            "```json",
            JSON.stringify({files: [{path: "a.ts", risk: "High"}]}),
            "```",
        ].join("\n");
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": proseFenced,
            "skill-auditor": EMPTY_FINDINGS,
        });
        const result = await runDispatch(
            options(makeFakeFs(staging()), runner),
        );
        // One call each: the lenient parse needed no retry, the dimension
        // was not shed, and the risk block came through.
        expect(
            runner.calls.filter((c) => c === "correctness-reviewer"),
        ).toHaveLength(1);
        expect(result.skippedDimensions).toEqual([]);
        expect(result.riskFiles).toEqual([{path: "a.ts", risk: "High"}]);
        expect(result.noteLines).toEqual([]);
    });

    it("retries a malformed finder once with a corrective note and acts on the second reply", async () => {
        const runner = sequencedRunner({
            "pattern-triage": [
                JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
            ],
            "correctness-reviewer": [
                "I reviewed the change and found one blocking problem.",
                CORRECTNESS_OUT,
            ],
            "skill-auditor": [EMPTY_FINDINGS],
            "claim-validator": [VALIDATOR_CONFIRM],
        });
        const fs = makeFakeFs(staging());
        const result = await runDispatch(options(fs, runner));

        expect(
            runner.calls.filter((c) => c === "correctness-reviewer"),
        ).toHaveLength(2);
        // The claim survived: the second output was parsed and validated.
        expect(result.claims).toHaveLength(1);
        expect(result.skippedDimensions).toEqual([]);
        // The retry entry is marked, its cost is real, and the roster
        // arithmetic does not double-count the agent.
        const entries = result.perAgent.filter(
            (agent) => agent.name === "correctness-reviewer",
        );
        expect(entries).toHaveLength(2);
        expect(entries[1].retried).toBe(true);
        expect(
            result.dispatched.filter((n) => n === "correctness-reviewer"),
        ).toHaveLength(1);
        // The staged out-file is the output the run acted on.
        expect(fs.files[`${REVIEW}/out/correctness-reviewer.json`]).toBe(
            CORRECTNESS_OUT,
        );
    });

    it("tells an out-of-turns agent to conclude rather than to fix its JSON shape", async () => {
        // A transcript truncated at the turn cap is not a SHAPE error. The
        // default corrective note ("deliver the complete corrected JSON
        // object") is then the wrong instruction, and this is the run's only
        // retry, so the note has to say what actually happened.
        const prompts: string[] = [];
        const remaining: Record<string, string[]> = {
            "pattern-triage": [
                JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
            ],
            "correctness-reviewer": [
                "I was still reading the diff when I ran out of turns.",
                CORRECTNESS_OUT,
            ],
            "skill-auditor": [EMPTY_FINDINGS],
            "claim-validator": [VALIDATOR_CONFIRM],
        };
        const runner: AgentRunner = async (request) => {
            prompts.push(request.prompt);
            const output = remaining[request.name]?.shift();
            if (output === undefined) {
                throw new Error(`no canned output for ${request.name}`);
            }
            return {
                output,
                usd: 0.5,
                turns: 3,
                wallMs: 100,
                toolCalls: 7,
                ...(request.name === "correctness-reviewer"
                    ? {stopReason: "max_turns"}
                    : {}),
            };
        };
        const result = await runDispatch(
            options(makeFakeFs(staging()), runner),
        );

        const corrective = prompts.filter((prompt) =>
            prompt.includes("could not be used"),
        );
        expect(corrective).toHaveLength(1);
        expect(corrective[0]).toContain("stopped at its turn cap");
        // The runner's diagnostics also reach the report, where a
        // harness-parity read can see them.
        const entries = result.perAgent.filter(
            (agent) => agent.name === "correctness-reviewer",
        );
        expect(entries[0].stopReason).toBe("max_turns");
        expect(entries[0].toolCalls).toBe(7);
        expect(result.claims).toHaveLength(1);
    });

    it("keeps the ordinary shape note when the agent finished under the cap", async () => {
        const prompts: string[] = [];
        const remaining: Record<string, string[]> = {
            "pattern-triage": [
                JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
            ],
            "correctness-reviewer": ["prose only", CORRECTNESS_OUT],
            "skill-auditor": [EMPTY_FINDINGS],
            "claim-validator": [VALIDATOR_CONFIRM],
        };
        const runner: AgentRunner = async (request) => {
            prompts.push(request.prompt);
            const output = remaining[request.name]?.shift();
            if (output === undefined) {
                throw new Error(`no canned output for ${request.name}`);
            }
            return {
                output,
                usd: 0.5,
                turns: 3,
                wallMs: 100,
                stopReason: "end_turn",
            };
        };
        await runDispatch(options(makeFakeFs(staging()), runner));
        const corrective = prompts.filter((prompt) =>
            prompt.includes("could not be used"),
        );
        expect(corrective).toHaveLength(1);
        expect(corrective[0]).not.toContain("turn cap");
    });

    it("sheds the dimension with its note when the retry is malformed too", async () => {
        const runner = sequencedRunner({
            "pattern-triage": [
                JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
            ],
            "correctness-reviewer": ["prose only", "still prose only"],
            "skill-auditor": [EMPTY_FINDINGS],
        });
        const result = await runDispatch(
            options(makeFakeFs(staging()), runner),
        );
        expect(result.skippedDimensions).toEqual([
            {dimension: "correctness-reviewer", cause: "unavailable"},
        ]);
        expect(result.noteLines.join(" ")).toContain(
            "correctness-reviewer not assessed this run",
        );
    });

    it("retries a prose-only validator and applies the second reply", async () => {
        const runner = sequencedRunner({
            "pattern-triage": [
                JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
            ],
            "correctness-reviewer": [CORRECTNESS_OUT],
            "skill-auditor": [EMPTY_FINDINGS],
            "claim-validator": [
                "All claims check out, nothing to change.",
                VALIDATOR_CONFIRM,
            ],
        });
        const result = await runDispatch(
            options(makeFakeFs(staging()), runner),
        );
        expect(
            runner.calls.filter((c) => c === "claim-validator"),
        ).toHaveLength(2);
        // Validated, not degraded: no unavailable note for claim validation.
        expect(result.skippedDimensions).toEqual([]);
        expect(result.claims[0].label).toBe("issue (blocking)");
    });

    it("accepts a prose-prefixed validator payload without a retry (the production claim-validator shape)", async () => {
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": CORRECTNESS_OUT,
            "skill-auditor": EMPTY_FINDINGS,
            "claim-validator": `All four claims are accurate.\n\n${VALIDATOR_CONFIRM}`,
        });
        const result = await runDispatch(
            options(makeFakeFs(staging()), runner),
        );
        expect(
            runner.calls.filter((c) => c === "claim-validator"),
        ).toHaveLength(1);
        expect(result.skippedDimensions).toEqual([]);
    });
});
