import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {computeDiffProvenance} from "./provenance";

/**
 * Cross-file duplicate merge at the dispatch level: one source's identical
 * finding on two files collapses to one claim, the merged copy skips
 * validation and posting, and the run artifact records the merge. Fixtures
 * mirror dispatch-cluster.test.ts; the duplicate shape is Khan/webapp#41440's
 * (byte-identical documentation suggestions on sibling files).
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

// Two sibling files, each with one added line, in a fixed diff order.
const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "+added line",
    " ctx",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
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
        {path: "b.ts", status: "modified", hasPatch: true},
    ]),
    [`${REVIEW}/provenance.json`]: JSON.stringify(computeDiffProvenance(DIFF)),
});

const finding = (path: string) => ({
    path,
    line: 2,
    label: "suggestion (non-blocking)",
    subject: "Comment names a v1 variant the versions block does not define.",
    discussion:
        "The header comment says the file compares a v1 variant against v2, but the versions block defines only v0 and v2, so the comment promises a comparison that never runs.",
    failure_scenario:
        "A reader trusts the comment and edits the wrong versions entry.",
});

describe("runDispatch cross-file duplicate merge", () => {
    it("collapses one source's identical finding on two files and records the merge", async () => {
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
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts", "b.ts"],
            }),
            "correctness-reviewer": JSON.stringify({
                findings: [finding("a.ts"), finding("b.ts")],
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
        });
        const result = await runDispatch({fs, runner, repoRoot: "/work"});

        // One claim survives, anchored on the diff's first file, with the
        // other occurrence carried in prose.
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].path).toBe("a.ts");
        expect(result.claims[0].discussion).toContain(
            "Also applies to `b.ts` (line 2).",
        );

        // The merge is in the artifact, and the validator saw ONE claim.
        expect(result.crossFileMerges).toEqual([
            {
                survivor: "correctness-reviewer-1",
                source: "correctness-reviewer",
                label: "suggestion (non-blocking)",
                path: "a.ts",
                line: 2,
                merged: [{id: "correctness-reviewer-2", path: "b.ts", line: 2}],
                via: "cross-file",
            },
        ]);
        const staged = JSON.parse(fs.files[`${REVIEW}/claims.json`]);
        expect(staged).toHaveLength(1);
        const artifact = JSON.parse(fs.files[`${REVIEW}/dispatch-result.json`]);
        expect(artifact.crossFileMerges).toHaveLength(1);
    });

    it("keeps the occurrence list when the validator corrects the survivor's discussion", async () => {
        // applyVerifications replaces discussion wholesale on a corrected
        // verdict, which erased the merge's "Also applies to" line and lost
        // the sibling file's finding from every posted surface.
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
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts", "b.ts"],
            }),
            "correctness-reviewer": JSON.stringify({
                findings: [finding("a.ts"), finding("b.ts")],
            }),
            "skill-auditor": JSON.stringify({findings: []}),
            "claim-validator": JSON.stringify({
                claims: [
                    {
                        id: "correctness-reviewer-1",
                        verification: "confirmed",
                        confidence: 0.9,
                        corrected: {
                            discussion:
                                "Corrected: the versions block defines only v0 and v2.",
                        },
                    },
                ],
            }),
        });
        const result = await runDispatch({fs, runner, repoRoot: "/work"});
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].discussion).toBe(
            "Corrected: the versions block defines only v0 and v2." +
                "\n\nAlso applies to `b.ts` (line 2).",
        );
    });

    it("posts the new file's copy when an open thread suppresses the survivor's file", async () => {
        // Regression for the merge-before-suppression loss case: an open bot
        // thread tracks the finding on a.ts (the author copied flawed a.ts
        // into sibling b.ts); the source re-finds it on both files. Thread
        // suppression only matches a claim on the thread's own path, so a
        // cross-file merge running FIRST would collapse b.ts into a.ts's
        // survivor and suppression would then drop b.ts's occurrence with
        // it, on this run and every later one. Order is
        // suppression-then-merge: a.ts exits through the thread, b.ts posts
        // alone.
        const fs = makeFakeFs({
            ...baseStaging(),
            [`${REVIEW}/threads.json`]: JSON.stringify([
                {
                    thread_id: "T1",
                    path: "a.ts",
                    resolved: false,
                    comments: [
                        {
                            author: "github-actions",
                            body: `**suggestion (non-blocking):** ${
                                finding("a.ts").subject
                            }\n\n${finding("a.ts").discussion}`,
                        },
                    ],
                },
            ]),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts", "b.ts"],
            }),
            "correctness-reviewer": JSON.stringify({
                findings: [finding("a.ts"), finding("b.ts")],
            }),
            "skill-auditor": JSON.stringify({findings: []}),
            "claim-validator": JSON.stringify({
                claims: [
                    {
                        id: "correctness-reviewer-2",
                        verification: "confirmed",
                        confidence: 0.9,
                    },
                ],
            }),
        });
        const result = await runDispatch({fs, runner, repoRoot: "/work"});

        // b.ts's occurrence posts on its own anchor, unmerged and without
        // the prose occurrence list.
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].path).toBe("b.ts");
        expect(result.claims[0].discussion).not.toContain("Also applies to");
        expect(result.crossFileMerges).toEqual([]);

        // a.ts's copy exited through the open thread, recorded as such.
        expect(result.threadSuppressions).toHaveLength(1);
        expect(result.threadSuppressions[0]).toMatchObject({
            path: "a.ts",
            thread_id: "T1",
        });
    });

    it("posts both when the same source's findings differ", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const other = {
            path: "b.ts",
            line: 2,
            label: "suggestion (non-blocking)",
            subject: "Unbounded read on the response body.",
            discussion:
                "io.ReadAll on the response with no size cap; a large body exhausts memory.",
            failure_scenario: "A multi-gigabyte response OOMs the process.",
        };
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts", "b.ts"],
            }),
            "correctness-reviewer": JSON.stringify({
                findings: [finding("a.ts"), other],
            }),
            "skill-auditor": JSON.stringify({findings: []}),
            "claim-validator": JSON.stringify({
                claims: [
                    {
                        id: "correctness-reviewer-1",
                        verification: "confirmed",
                        confidence: 0.9,
                    },
                    {
                        id: "correctness-reviewer-2",
                        verification: "confirmed",
                        confidence: 0.9,
                    },
                ],
            }),
        });
        const result = await runDispatch({fs, runner, repoRoot: "/work"});
        expect(result.claims).toHaveLength(2);
        expect(result.crossFileMerges).toEqual([]);
    });
});
