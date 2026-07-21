import {describe, it, expect} from "vitest";

import {
    applyScopeFilter,
    applyVerifications,
    buildClaims,
    computeRoster,
    parseAgentFile,
    parseFinderOutput,
    parseValidatorOutput,
    runDispatch,
    type AgentRunner,
    type Candidate,
    type Claim,
    type DispatchFs,
} from "./dispatch";
import {computeDiffProvenance} from "./provenance";
import {parseRoutingConfig} from "./routing-config";

/**
 * Script-driven dispatch tests (deterministic-orchestrator slice 2).
 *
 * The runner is stubbed (a map of agent name to canned final text), so these
 * tests pin everything AROUND the models: roster and shed arithmetic, output
 * parsing per contract, the provenance gate and scope filter application,
 * verification mechanics, the out/ artifact writes the dispatch gate reads,
 * and the code-rendered Step 6 note lines.
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

const VALIDATOR_CONFIRM = JSON.stringify({
    "correctness-reviewer-1": {verification: "confirmed", confidence: 0.9},
});

describe("parseAgentFile", () => {
    it("parses gh-aw inline agent files (frontmatter + body)", () => {
        expect(parseAgentFile(agentFile("correctness-reviewer"))).toEqual({
            name: "correctness-reviewer",
            model: "claude-opus-4-8",
            prompt: "You are correctness-reviewer. Read from disk and return JSON.",
        });
        expect(parseAgentFile("no frontmatter")).toBeNull();
    });
});

describe("computeRoster", () => {
    const routing = {
        enabledReviewers: ["holistic", "conventions", "test-adequacy"],
        lensesToSpawn: ["security-auth"],
        runBudget: {maxReviewerInvocations: 4},
    };

    it("fills slots in dispatch-ranking order and records planned sheds", () => {
        const roster = computeRoster("full", routing, false);
        // Defaults, then the matched lens, then opt-ins by inverse shed
        // order; the cap of 4 sheds holistic and conventions.
        expect(roster.finders).toEqual([
            "correctness-reviewer",
            "skill-auditor",
            "security-auth",
            "test-adequacy",
        ]);
        expect(roster.shed).toEqual([
            {name: "holistic", cause: "budget"},
            {name: "conventions", cause: "budget"},
        ]);
        expect(roster.triage).toBe(true);
    });

    it("dispatches fixed rosters at flip-gated and fast depths", () => {
        expect(computeRoster("flip-gated", routing, true)).toEqual({
            finders: ["correctness-reviewer"],
            shed: [],
            triage: false,
            reconcile: true,
        });
        expect(computeRoster("fast", routing, false)).toEqual({
            finders: [],
            shed: [],
            triage: false,
            reconcile: false,
        });
    });

    it("never caps below the default finders", () => {
        const roster = computeRoster(
            "full",
            {...routing, runBudget: {maxReviewerInvocations: 1}},
            false,
        );
        expect(roster.finders).toEqual([
            "correctness-reviewer",
            "skill-auditor",
        ]);
    });
});

describe("parseFinderOutput", () => {
    it("maps label-shape findings, keeping the producer's own label", () => {
        const {candidates, riskFiles} = parseFinderOutput(
            "correctness-reviewer",
            CORRECTNESS_OUT,
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].labelOverride).toBe("issue (blocking)");
        expect(candidates[0].finding.severity).toBe("blocking");
        expect(candidates[0].finding.anchor).toMatchObject({
            path: "a.ts",
            line: 2,
        });
        expect(riskFiles).toEqual([{path: "a.ts", risk: "high"}]);
    });

    it("routes out-of-lane observations as question (non-blocking) handoffs", () => {
        const {candidates} = parseFinderOutput(
            "skill-auditor",
            JSON.stringify({
                findings: [],
                out_of_lane_observations: [
                    {
                        path: "a.ts",
                        line: 2,
                        observation: "This looks off.",
                        failure_scenario: "maybe fails",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].labelOverride).toBe("question (non-blocking)");
        expect(candidates[0].source).toBe("skill-auditor (out-of-lane)");
        expect(candidates[0].finding.severity).toBe("advisory");
    });

    it("treats an enabled whole-change reviewer as label-shape, a lens as schema", () => {
        const holistic = parseFinderOutput(
            "holistic",
            CORRECTNESS_OUT,
            new Set(),
            false,
        );
        expect(holistic.candidates[0].labelOverride).toBe("issue (blocking)");
        expect(() =>
            parseFinderOutput(
                "security-auth",
                CORRECTNESS_OUT,
                new Set(),
                true,
            ),
        ).toThrow(/findings\[0\]/);
    });

    it("dedupes colliding finding ids across producers", () => {
        const used = new Set<string>();
        parseFinderOutput("correctness-reviewer", CORRECTNESS_OUT, used);
        const second = parseFinderOutput("holistic", CORRECTNESS_OUT, used);
        // holistic's first finding id collides (both are <agent>-1 shapes
        // only when equal); here ids differ by agent name so no collision.
        expect(second.candidates[0].finding.id).toBe("holistic-1");
        expect(used.has("holistic-1")).toBe(true);
    });
});

describe("applyScopeFilter", () => {
    const candidate = (
        line: number,
        label = "suggestion (non-blocking)",
    ): Candidate =>
        ({
            finding: {
                anchor: {type: "line", path: "a.ts", line, side: "RIGHT"},
            },
            source: "correctness-reviewer",
            labelOverride: label,
        } as unknown as Candidate);

    it("keeps everything on a first review", () => {
        const result = applyScopeFilter([candidate(9)], {
            priorReview: false,
            inScope: {},
        });
        expect(result.kept).toHaveLength(1);
    });

    it("drops out-of-scope non-blocking findings, keeps plain blocking ones", () => {
        const scope = {priorReview: true, inScope: {"a.ts": [2]}};
        const result = applyScopeFilter(
            [
                candidate(2),
                candidate(9),
                candidate(9, "issue (blocking)"),
                candidate(9, "issue (blocking, best-practice)"),
            ],
            scope,
        );
        expect(result.kept).toHaveLength(2);
        expect(result.dropped).toHaveLength(2);
    });
});

describe("verification mechanics", () => {
    const claim = (overrides: Partial<Claim>): Claim => ({
        id: "c1",
        source: "correctness-reviewer",
        path: "a.ts",
        line: 2,
        label: "issue (blocking)",
        subject: "s",
        discussion: "d",
        failure_scenario: "f",
        confidence: 0.7,
        ...overrides,
    });

    it("parses the validator's id-keyed map, skipping malformed entries", () => {
        const parsed = parseValidatorOutput(
            JSON.stringify({
                c1: {verification: "confirmed", confidence: 0.95},
                c2: {verification: "nonsense"},
                c3: "not an object",
            }),
        );
        expect(Object.keys(parsed)).toEqual(["c1"]);
    });

    it("drops refuted, downgrades plausible to non-blocking, applies corrections", () => {
        const claims = [
            claim({id: "refuted"}),
            claim({id: "plausible"}),
            claim({id: "confirmed"}),
            claim({id: "unmentioned"}),
        ];
        const result = applyVerifications(claims, {
            refuted: {verification: "refuted"},
            plausible: {verification: "plausible", confidence: 0.4},
            confirmed: {
                verification: "confirmed",
                corrected: {line: 3, subject: "fixed subject"},
            },
        });
        expect(result.map((c) => c.id)).toEqual([
            "plausible",
            "confirmed",
            "unmentioned",
        ]);
        const plausible = result[0];
        expect(plausible.label).toBe("suggestion (non-blocking)");
        expect(plausible.confidence).toBe(0.4);
        const confirmed = result[1];
        expect(confirmed.line).toBe(3);
        expect(confirmed.subject).toBe("fixed subject");
        expect(confirmed.label).toBe("issue (blocking)");
        expect(result[2].label).toBe("issue (blocking)");
    });

    it("caps an author-disputed claim at a question unless confirmed", () => {
        const result = applyVerifications(
            [claim({id: "c1", author_dispute: "author says no"})],
            {c1: {verification: "plausible"}},
        );
        expect(result[0].label).toBe("question (non-blocking)");
        const confirmed = applyVerifications(
            [claim({id: "c1", author_dispute: "author says no"})],
            {c1: {verification: "confirmed"}},
        );
        expect(confirmed[0].label).toBe("issue (blocking)");
    });

    it("builds claims with the producer label and prose split", () => {
        const candidates = parseFinderOutput(
            "correctness-reviewer",
            CORRECTNESS_OUT,
            new Set(),
        ).candidates;
        const claims = buildClaims(candidates);
        expect(claims[0]).toMatchObject({
            id: "correctness-reviewer-1",
            source: "correctness-reviewer",
            path: "a.ts",
            line: 2,
            label: "issue (blocking)",
            failure_scenario: "nil deref on empty input",
            confidence: 0.7,
        });
    });
});

describe("ROUTING dispatch directive", () => {
    it("defaults to task and accepts scripted", () => {
        expect(parseRoutingConfig("").dispatchMode).toBe("task");
        expect(parseRoutingConfig("dispatch scripted\n").dispatchMode).toBe(
            "scripted",
        );
    });

    it("warns and keeps the default on an unknown mode", () => {
        const config = parseRoutingConfig("dispatch warp\n");
        expect(config.dispatchMode).toBe("task");
        expect(config.warnings.join(" ")).toContain("unknown dispatch mode");
    });
});

describe("runDispatch", () => {
    const options = (fs: DispatchFs, runner: AgentRunner) => ({
        fs,
        runner,
        repoRoot: "/work",
    });

    it("runs the full pipeline: triage narrows, finders stage out/, validator applies", async () => {
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
                patterns: ["rename"],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": CORRECTNESS_OUT,
            "skill-auditor": EMPTY_FINDINGS,
            "claim-validator": VALIDATOR_CONFIRM,
        });
        const result = await runDispatch(options(fs, runner));

        expect(runner.calls).toEqual([
            "pattern-triage",
            "correctness-reviewer",
            "skill-auditor",
            "claim-validator",
        ]);
        // out/ evidence per dispatch (what the conformance gate reads).
        for (const name of runner.calls) {
            expect(fs.files[`${REVIEW}/out/${name}.json`]).toBeDefined();
        }
        expect(fs.files[`${REVIEW}/pr.diff`]).toContain("added line");
        expect(fs.files[`${REVIEW}/pr-annotated.diff`]).toBeDefined();
        expect(JSON.parse(fs.files[`${REVIEW}/review-files.json`])).toEqual([
            {path: "a.ts", status: "modified", hasPatch: true},
        ]);
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].confidence).toBe(0.9);
        expect(result.noteLines).toEqual([]);
        expect(result.riskFiles).toEqual([{path: "a.ts", risk: "high"}]);
        expect(result.totalUsd).toBeCloseTo(2);
        expect(
            JSON.parse(fs.files[`${REVIEW}/dispatch-result.json`]).dispatched,
        ).toEqual(runner.calls);
    });

    it("sheds under the invocation cap with a code-rendered note line", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            [`${REVIEW}/routing.json`]: JSON.stringify({
                enabledReviewers: ["holistic"],
                lensesToSpawn: [],
                runBudget: {maxReviewerInvocations: 2, tier: "High"},
            }),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": EMPTY_FINDINGS,
            "skill-auditor": EMPTY_FINDINGS,
        });
        const result = await runDispatch(options(fs, runner));
        expect(result.shed).toEqual([{name: "holistic", cause: "budget"}]);
        expect(result.noteLines).toContain(
            "Note: holistic not assessed this run (shed under the High-tier run budget).",
        );
        expect(runner.calls).not.toContain("holistic");
    });

    it("skips the finders when triage empties reviewFiles", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({patterns: [], reviewFiles: []}),
        });
        const result = await runDispatch(options(fs, runner));
        expect(runner.calls).toEqual(["pattern-triage"]);
        expect(result.claims).toEqual([]);
        // The triage evidence still stages for the conformance-gate waiver.
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/pattern-triage.json`]),
        ).toMatchObject({reviewFiles: []});
    });

    it("runs reconcile-only at fast depth when threads are staged", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({depth: "fast"}),
            [`${REVIEW}/threads.json`]: JSON.stringify([
                {thread_id: "t1", path: "a.ts", line: 2, comments: []},
            ]),
            ...agentFiles("thread-reconciler"),
        });
        const runner = stubRunner({
            "thread-reconciler": JSON.stringify({
                resolve: ["t1"],
                keep: [],
                skipLines: [],
            }),
        });
        const result = await runDispatch(options(fs, runner));
        expect(runner.calls).toEqual(["thread-reconciler"]);
        expect(result.reconciliation).toEqual({
            resolve: ["t1"],
            keep: [],
            skipLines: [],
        });
    });

    it("stages an error note and an unavailable note when a dispatch fails", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
            ),
        });
        const runner = stubRunner(
            {
                "pattern-triage": JSON.stringify({
                    patterns: [],
                    reviewFiles: ["a.ts"],
                }),
                "skill-auditor": EMPTY_FINDINGS,
            },
            ["correctness-reviewer"],
        );
        const result = await runDispatch(options(fs, runner));
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/correctness-reviewer.json`]),
        ).toEqual({error: "boom"});
        expect(result.skippedDimensions).toContainEqual({
            dimension: "correctness-reviewer",
            cause: "unavailable",
        });
        expect(result.noteLines.join(" ")).toContain(
            "correctness-reviewer output unavailable",
        );
    });

    it("posts unvalidated with the claim-validation note when the validator fails", async () => {
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
                "claim-validator",
            ),
        });
        const runner = stubRunner(
            {
                "pattern-triage": JSON.stringify({
                    patterns: [],
                    reviewFiles: ["a.ts"],
                }),
                "correctness-reviewer": CORRECTNESS_OUT,
                "skill-auditor": EMPTY_FINDINGS,
            },
            ["claim-validator"],
        );
        const result = await runDispatch(options(fs, runner));
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].label).toBe("issue (blocking)");
        expect(result.noteLines).toContain(
            "Note: claim validation not assessed this run (claim-validator output unavailable).",
        );
    });

    it("applies the provenance gate: out-of-provenance findings are set aside", async () => {
        const offAnchor = JSON.stringify({
            findings: [
                {
                    path: "a.ts",
                    line: 40,
                    label: "issue (blocking)",
                    subject: "Pre-existing.",
                    discussion: "Old code.",
                    failure_scenario: "was always broken",
                },
            ],
            files: [],
        });
        const fs = makeFakeFs({
            ...baseStaging(),
            ...agentFiles(
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
            ),
        });
        const runner = stubRunner({
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": offAnchor,
            "skill-auditor": EMPTY_FINDINGS,
        });
        const result = await runDispatch(options(fs, runner));
        expect(result.claims).toEqual([]);
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/pre-existing.json`]),
        ).toHaveLength(1);
    });
});
