import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {computeDiffProvenance} from "./provenance";

/**
 * Adjudicated-thread suppression, end to end through `runDispatch`: the
 * staged adjudicated-threads.json corpus, the pre-validation drop, and the
 * blocking exemption. Split from dispatch.test.ts for its max-lines budget
 * (the dispatch-cluster.test.ts precedent); the fixtures mirror that file's.
 *
 * The scenario is webapp#41290's loop: the author resolves the bot's thread,
 * the next run re-derives the same defect with fresh wording, and the
 * accountability recap then reports it "still unaddressed".
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

/** The re-derivation finding, at the label the case under test wants. */
const rederivationOut = (label: string): string =>
    JSON.stringify({
        findings: [
            {
                path: "a.ts",
                line: 2,
                label,
                subject:
                    "Missing deletion test: the expiration path has no test covering the delete.",
                discussion:
                    "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
                failure_scenario:
                    "A regression that identifies expired memories but skips the deletion is not caught by TestExpiration and ships green.",
            },
        ],
        files: [],
    });

const ADJUDICATED_STAGING = JSON.stringify([
    {
        thread_id: "T-adj",
        path: "a.ts",
        resolved: true,
        resolvedBy: "octo",
        comments: [
            {
                author: "github-actions",
                body: "**suggestion (non-blocking):** No test exercises the deletion path: TestExpiration only asserts that expired keys are identified, so a regression that identifies but never deletes expired memories stays green.",
            },
        ],
    },
]);

describe("runDispatch adjudicated-thread suppression", () => {
    const options = (fs: DispatchFs, runner: AgentRunner) => ({
        fs,
        runner,
        repoRoot: "/work",
    });

    it("suppresses a non-blocking re-derivation of an adjudicated defect before validation", () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            [`${REVIEW}/adjudicated-threads.json`]: ADJUDICATED_STAGING,
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": TRIAGE_OK,
            "correctness-reviewer": rederivationOut(
                "suggestion (non-blocking)",
            ),
            "skill-auditor": EMPTY_FINDINGS,
        });
        return runDispatch(options(fs, runner)).then((result) => {
            expect(result.claims).toEqual([]);
            expect(result.threadSuppressions).toEqual([
                {
                    id: "correctness-reviewer-1",
                    source: "correctness-reviewer",
                    label: "suggestion (non-blocking)",
                    path: "a.ts",
                    line: 2,
                    thread_id: "T-adj",
                    threadBlocking: false,
                    adjudicated: true,
                },
            ]);
            // Suppressed pre-validation: with nothing left to validate, the
            // validator is never dispatched.
            expect(runner.calls).not.toContain("claim-validator");
        });
    });

    it("never adjudicates away a blocking candidate: a regression re-flag posts", () => {
        // The adjudicated thread is closed and floors nothing, so a blocking
        // re-flag suppressed against it would vanish without a trace. It must
        // reach validation and post.
        const fs = makeFakeFs({
            ...baseStaging(),
            [`${REVIEW}/adjudicated-threads.json`]: ADJUDICATED_STAGING,
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": TRIAGE_OK,
            "correctness-reviewer": rederivationOut("issue (blocking)"),
            "skill-auditor": EMPTY_FINDINGS,
            "claim-validator": VALIDATOR_CONFIRM,
        });
        return runDispatch(options(fs, runner)).then((result) => {
            expect(result.claims).toHaveLength(1);
            expect(result.claims[0].label).toBe("issue (blocking)");
            expect(result.threadSuppressions).toEqual([]);
            expect(runner.calls).toContain("claim-validator");
        });
    });
});
