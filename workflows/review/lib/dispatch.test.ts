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
import {runCli as runRouterCli} from "./router";
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

    it("keeps label-shape ids distinct without renaming (agent-prefixed ids cannot collide)", () => {
        // The real collision case (two lenses declaring the same schema id)
        // is covered in "renames the second lens finding when ids collide
        // across producers"; this pins the non-collision path: label-shape
        // ids are <agent>-<index>, so distinct agents never rename.
        const used = new Set<string>();
        parseFinderOutput("correctness-reviewer", CORRECTNESS_OUT, used);
        const second = parseFinderOutput("holistic", CORRECTNESS_OUT, used);
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

    it("parses the validator's claims-array contract, skipping malformed entries", () => {
        // The contract (review.md and the eval producer alike) is
        // {"claims": [{id, verification, ...}]}.
        const parsed = parseValidatorOutput(
            JSON.stringify({
                claims: [
                    {id: "c1", verification: "confirmed", confidence: 0.95},
                    {id: "c2", verification: "nonsense"},
                    "not an object",
                    {verification: "refuted"},
                ],
            }),
        );
        expect(Object.keys(parsed)).toEqual(["c1"]);
        expect(() => parseValidatorOutput(JSON.stringify({c1: {}}))).toThrow(
            /no claims array/,
        );
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

    it("skips a dispatch line with the wrong arity", () => {
        const config = parseRoutingConfig("dispatch task scripted\n");
        expect(config.dispatchMode).toBe("task");
        expect(config.warnings.join("\n")).toContain("exactly one");
    });

    it("lets the last of duplicate dispatch lines win, with a warning", () => {
        const config = parseRoutingConfig("dispatch task\ndispatch scripted\n");
        expect(config.dispatchMode).toBe("scripted");
        expect(config.warnings.join("\n")).toContain("duplicate dispatch");
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

    it("merges cross-source duplicates before the validator sees them (#245)", async () => {
        const duplicate = (label: string) =>
            JSON.stringify({
                findings: [
                    {
                        path: "a.ts",
                        line: 2,
                        label,
                        subject: "AddDate subtracts months, not days.",
                        failure_scenario:
                            "Memories older than 180 days are never expired; the retention pass is a silent no-op.",
                    },
                ],
            });
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
            "correctness-reviewer": duplicate("issue (blocking)"),
            "skill-auditor": duplicate("nitpick (non-blocking)"),
            "claim-validator": VALIDATOR_CONFIRM,
        });
        const result = await runDispatch(options(fs, runner));
        expect(result.claims).toMatchObject([{id: "correctness-reviewer-1"}]);
        expect(result.claims[0].discussion).toContain("Also flagged by");
        // The validator was dispatched on the merged set, and the merge is
        // recorded in dispatch-result.json for the run report.
        expect(JSON.parse(fs.files[`${REVIEW}/claims.json`])).toHaveLength(1);
        expect(
            JSON.parse(fs.files[`${REVIEW}/dispatch-result.json`]).merges,
        ).toEqual(result.merges);
        expect(result.merges).toMatchObject([
            {survivor: "correctness-reviewer-1", path: "a.ts", line: 2},
        ]);
        expect(result.merges[0].merged.map((m) => m.id)).toEqual([
            "skill-auditor-1",
        ]);
    });
});

describe("re-review hardening (slice 2 feedback)", () => {
    it("caps an author-disputed claim without any verification (validator failed or omitted)", () => {
        const disputed: Claim = {
            id: "c1",
            source: "correctness-reviewer",
            path: "a.ts",
            line: 2,
            label: "issue (blocking)",
            subject: "s",
            discussion: "d",
            failure_scenario: "f",
            confidence: 0.7,
            author_dispute: "author says no",
        };
        expect(applyVerifications([disputed], {})[0].label).toBe(
            "question (non-blocking)",
        );
    });

    it("renames the second lens finding when ids collide across producers", () => {
        const lensFinding = (id: string) =>
            JSON.stringify({
                findings: [
                    {
                        schema_version: 2,
                        id,
                        lens: "security-auth",
                        anchor: {
                            type: "line",
                            path: "a.ts",
                            line: 2,
                            side: "RIGHT",
                        },
                        severity: "advisory",
                        confidence: 0.8,
                        evidence_trace: ["a.ts:2"],
                        failure_scenario: "f",
                        producing_hunt: "h",
                        model_authored_prose: "p",
                    },
                ],
            });
        const used = new Set<string>();
        parseFinderOutput(
            "security-auth",
            lensFinding("shared-id"),
            used,
            true,
        );
        const second = parseFinderOutput(
            "caching-resource",
            lensFinding("shared-id"),
            used,
            true,
        );
        expect(second.candidates[0].finding.id).toBe(
            "caching-resource:shared-id",
        );
    });

    it("warns on dispatch directive arity and duplicates (last one wins)", () => {
        const arity = parseRoutingConfig("dispatch task scripted\n");
        expect(arity.dispatchMode).toBe("task");
        expect(arity.warnings.join(" ")).toContain("exactly one");
        const dupe = parseRoutingConfig("dispatch task\ndispatch scripted\n");
        expect(dupe.dispatchMode).toBe("scripted");
        expect(dupe.warnings.join(" ")).toContain("duplicate dispatch");
    });

    it("emits dispatchMode through the router CLI's routing.json", () => {
        const files: Record<string, string> = {
            "/tmp/gh-aw/review/files.json": JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
            "/work/.github/aw/review/ROUTING": "dispatch scripted\n",
        };
        const fs = {
            readFileSync: (p: string) => {
                if (!(p in files)) {
                    throw new Error(`ENOENT: ${p}`);
                }
                return files[p];
            },
            writeFileSync: (p: string, data: string) => {
                files[p] = data;
            },
            existsSync: (p: string) => p in files,
            mkdirSync: () => {},
        };
        const routing = runRouterCli(fs, "/work", {});
        expect(routing.dispatchMode).toBe("scripted");
        expect(
            JSON.parse(files["/tmp/gh-aw/review/routing.json"]).dispatchMode,
        ).toBe("scripted");
    });

    it("stages review-files.json for the finders when triage is unavailable", async () => {
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
                "correctness-reviewer": EMPTY_FINDINGS,
                "skill-auditor": EMPTY_FINDINGS,
            },
            ["pattern-triage"],
        );
        await runDispatch({fs, runner, repoRoot: "/work"});
        expect(JSON.parse(fs.files[`${REVIEW}/review-files.json`])).toEqual([
            {path: "a.ts", status: "modified", hasPatch: true},
        ]);
    });
});

/* -------------------------------------------------------------------------- */
/* Malformed-output leniency and retry (trial run 29893634730)                */
/* -------------------------------------------------------------------------- */

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
