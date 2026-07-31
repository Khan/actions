import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {computeDiffProvenance} from "./provenance";

/**
 * Defect-clustering tests (dedup tier 2): the `claim-clusterer` dispatch, the
 * merge it unlocks, and every way it degrades. Split from dispatch.test.ts for
 * its max-lines budget; the fixtures mirror that file's.
 *
 * The finder outputs are run 30587343777's real claim texts, trimmed: two
 * reviewers describing ONE wrong doc comment in words that share almost
 * nothing, which is the shape text similarity cannot reach (that run posted
 * four such copies and merged none of them).
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

describe("runDispatch defect clustering (dedup tier 2)", () => {
    const options = (fs: DispatchFs, runner: AgentRunner) => ({
        fs,
        runner,
        repoRoot: "/work",
    });

    /**
     * Dedup tier 2 (the claim-clusterer): two reviewers describing one wrong
     * comment in words that share almost nothing, the shape run 30587343777
     * posted four times. The finder outputs here are that run's real claim
     * texts, trimmed; on text similarity alone they stay two comments.
     */
    const CAP_NOTE = JSON.stringify({
        findings: [
            {
                path: "a.ts",
                line: 2,
                label: "note (non-blocking)",
                subject:
                    "Comment says the per-key cap is 10 but maxSamples is 25.",
                discussion:
                    'The comment on `maxSamples` reads "Keeps at most 10 samples per key" while the constant is 25.',
                failure_scenario:
                    "Comment says the per-key cap is 10 but maxSamples is 25",
            },
        ],
    });
    const CAP_NITPICK = JSON.stringify({
        findings: [
            {
                path: "a.ts",
                line: 2,
                label: "nitpick (non-blocking)",
                subject:
                    "Declaration doc comment doesn't begin with the symbol name.",
                discussion:
                    "Every other declaration comment in this file starts with the declared name; `// Keeps at most 10 samples per key.` above `const maxSamples = 25` is the sole one that omits the prefix.",
                failure_scenario:
                    "A `go doc` reader won't associate this comment with `maxSamples`, and the odd-one-out style reads as an oversight.",
            },
        ],
    });

    it("merges a defect the clusterer identifies and similarity cannot reach", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-clusterer",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": TRIAGE_OK,
            "correctness-reviewer": CAP_NOTE,
            "skill-auditor": CAP_NITPICK,
            "claim-clusterer": JSON.stringify({
                clusters: [
                    {
                        evidence:
                            "the doc comment on `maxSamples` says 10 while the constant is 25",
                        ids: ["correctness-reviewer-1", "skill-auditor-1"],
                    },
                ],
            }),
            "claim-validator": JSON.stringify({
                claims: [
                    {
                        id: "correctness-reviewer-1",
                        verification: "confirmed",
                        confidence: 0.8,
                    },
                ],
            }),
        });
        const result = await runDispatch(options(fs, runner));

        // The clusterer runs on the PRE-merge candidates, from its own staged
        // file, and before the validator (which must never pay for a copy).
        expect(runner.calls).toEqual([
            "pattern-triage",
            "correctness-reviewer",
            "skill-auditor",
            "claim-clusterer",
            "claim-validator",
        ]);
        expect(JSON.parse(fs.files[`${REVIEW}/candidates.json`])).toHaveLength(
            2,
        );
        expect(JSON.parse(fs.files[`${REVIEW}/claims.json`])).toHaveLength(1);
        expect(result.claims).toMatchObject([{id: "correctness-reviewer-1"}]);
        expect(result.claims[0].discussion).toContain(
            "Also flagged by:\n- skill-auditor: Declaration doc comment " +
                "doesn't begin with the symbol name.",
        );
        expect(result.merges[0].via).toBe("clusterer");
        // The audit block: candidate count and merge count come from here, not
        // from what survives on the PR.
        expect(result.clustering).toEqual({
            candidates: 2,
            proposed: 1,
            clusterMerges: 1,
            clusterMerged: 1,
            rejected: [],
        });
        expect(
            JSON.parse(fs.files[`${REVIEW}/dispatch-result.json`]).clustering,
        ).toEqual(result.clustering);
    });

    it("degrades to similarity alone when the clusterer output is unusable", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-clusterer",
                "claim-validator",
            ),
        });
        const runner = stubRunner(
            {
                "pattern-triage": TRIAGE_OK,
                "correctness-reviewer": CAP_NOTE,
                "skill-auditor": CAP_NITPICK,
                "claim-validator": JSON.stringify({claims: []}),
            },
            ["claim-clusterer"],
        );
        const result = await runDispatch(options(fs, runner));
        // Both copies post, exactly as they do today: a clusterer failure is
        // never a dropped or downgraded finding.
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toEqual([]);
        expect(result.clustering).toEqual({
            candidates: 2,
            proposed: 0,
            clusterMerges: 0,
            clusterMerged: 0,
            rejected: [],
            unavailable: true,
        });
        // Not an author-facing dimension: duplicate hygiene never renders a
        // "not assessed this run" note into the review body.
        expect(result.noteLines).toEqual([]);
        expect(result.skippedDimensions).toEqual([]);
    });

    it("never spends on clustering when one source produced every claim", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-clusterer",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": TRIAGE_OK,
            "correctness-reviewer": CORRECTNESS_OUT,
            "skill-auditor": EMPTY_FINDINGS,
            "claim-validator": VALIDATOR_CONFIRM,
        });
        const result = await runDispatch(options(fs, runner));
        expect(runner.calls).not.toContain("claim-clusterer");
        expect(result.clustering).toBeUndefined();
        expect(fs.files[`${REVIEW}/candidates.json`]).toBeUndefined();
    });

    it("never spends on clustering when no candidate pair could legally merge", async () => {
        // Two sources, two claims, and still nothing tier 2 may do with them:
        // they sit in different files, and cross-file merging is out of both
        // tiers. The count-and-source gate alone would pay for a serial
        // dispatch whose every proposal the merge rules must reject.
        const twoFileDiff = [
            DIFF.trimEnd(),
            "diff --git a/b.ts b/b.ts",
            "--- a/b.ts",
            "+++ b/b.ts",
            "@@ -1,2 +1,3 @@",
            " ctx",
            "+added line",
            " ctx",
            "",
        ].join("\n");
        const fs = makeFakeFs({
            ...baseStaging(),
            [`${REVIEW}/full.diff`]: twoFileDiff,
            [`${REVIEW}/provenance.json`]: JSON.stringify(
                computeDiffProvenance(twoFileDiff),
            ),
            [`${REVIEW}/files.json`]: JSON.stringify([
                {path: "a.ts", status: "modified", hasPatch: true},
                {path: "b.ts", status: "modified", hasPatch: true},
            ]),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-clusterer",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts", "b.ts"],
            }),
            "correctness-reviewer": CAP_NOTE,
            "skill-auditor": JSON.stringify({
                findings: [
                    {
                        ...JSON.parse(CAP_NITPICK).findings[0],
                        path: "b.ts",
                        line: 2,
                    },
                ],
            }),
            "claim-validator": JSON.stringify({claims: []}),
        });
        const result = await runDispatch(options(fs, runner));
        expect(runner.calls).not.toContain("claim-clusterer");
        expect(result.clustering).toBeUndefined();
        expect(result.claims).toHaveLength(2);
    });

    it("records the ids a clusterer invents rather than merging on them", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-clusterer",
                "claim-validator",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": TRIAGE_OK,
            "correctness-reviewer": CAP_NOTE,
            "skill-auditor": CAP_NITPICK,
            "claim-clusterer": JSON.stringify({
                clusters: [
                    {
                        evidence: "the `maxSamples` cap comment",
                        ids: ["correctness-reviewer-1", "holistic-4"],
                    },
                ],
            }),
            "claim-validator": JSON.stringify({claims: []}),
        });
        const result = await runDispatch(options(fs, runner));
        expect(result.claims).toHaveLength(2);
        expect(result.clustering).toEqual({
            candidates: 2,
            proposed: 1,
            clusterMerges: 0,
            clusterMerged: 0,
            rejected: [
                {id: "holistic-4", reason: "unknown-id"},
                {id: "correctness-reviewer-1", reason: "cluster-collapsed"},
            ],
        });
    });
});
