import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {computeDiffProvenance} from "./provenance";

/**
 * Trial-driven dispatcher regression tests, split from dispatch.test.ts
 * (which sits against the max-lines budget); the harness and fixtures
 * mirror that file's.
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

describe("dispatch-result artifact staging (run 29943085279)", () => {
    it("stages out/dispatch-result.json with the per-agent accounting", async () => {
        // That run's post-hoc could not tell whether the correctness output
        // arrived through submit_result or the text fallback: the file lived
        // only in the review dir, which the run artifact does not include.
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": TRIAGE_OK,
            "correctness-reviewer": CORRECTNESS_OUT,
            "skill-auditor": EMPTY_FINDINGS,
            "claim-validator": VALIDATOR_CONFIRM,
        });
        await runDispatch({fs, runner, repoRoot: "/work"});
        const outCopy = JSON.parse(
            fs.files[`${REVIEW}/out/dispatch-result.json`],
        );
        expect(outCopy.perAgent).toHaveLength(4);
        expect(outCopy).toEqual(
            JSON.parse(fs.files[`${REVIEW}/dispatch-result.json`]),
        );
    });
});
