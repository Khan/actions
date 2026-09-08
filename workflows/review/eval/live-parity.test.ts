import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {Volume} from "memfs";

import {DEFAULT_TIER_BUDGETS} from "../lib/budgets";
import {DEFAULT_TIMEOUT_MS} from "../lib/dispatch-limits";
import {computeRoster} from "../lib/dispatch-roster";
import {parseCase} from "./corpus/loader";
import {produceLive, type LiveAgentRequest} from "./live-producer";
import type {StageFs} from "./live-stage";
import {runArm} from "./live-ab";
import {extractTierBudgets} from "./runtime-config";

const evidence = JSON.parse(
    readFileSync(`${__dirname}/field-parity-evidence.json`, "utf8"),
) as {
    existingEnabledReviewers: string[];
    replayBudget: typeof DEFAULT_TIER_BUDGETS.low & {
        effectiveCreditCap: number;
    };
    rounds: {
        runId: number;
        lenses: string[];
        observedShed: string[];
        observedFinderCount: number;
    }[];
};
const DIFF =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
const makeCase = (lenses: string[] = ["security-auth"]) =>
    parseCase(
        {
            id: "parity",
            tags: ["live"],
            category: "clean",
            description: "Scripted dispatch control, not a model measurement.",
            changedFiles: [{path: "src/a.ts", status: "modified"}],
            diff: DIFF,
            routerConfig: {
                enabledReviewers: evidence.existingEnabledReviewers,
                tierBudgets: {
                    ...DEFAULT_TIER_BUDGETS,
                    low: evidence.replayBudget,
                },
                lensRules: [{pattern: "src/**", lenses}],
                riskRules: [{pattern: "src/**", tier: "low"}],
                maxAiCredits: 2500,
            },
            expected: {verdict: "APPROVE"},
            live: {
                prContext: {
                    title: "t",
                    description: "",
                    author: "a",
                    baseBranch: "main",
                },
            },
        },
        "/corpus/parity/case.json",
    );
const agents = new Map(
    [
        "correctness-reviewer",
        "skill-auditor",
        "claim-validator",
        "security-auth",
        "api-federation-compat",
        ...evidence.existingEnabledReviewers,
    ].map((name) => [
        name,
        {name, description: name, model: "scripted", prompt: name},
    ]),
);
const fsForCase = () => {
    const vol = Volume.fromJSON({
        "/corpus/parity/tree/src/a.ts": "const a = 2;\n",
    });
    const fs: StageFs = {
        existsSync: (p) => vol.existsSync(p),
        mkdirSync: (p, o) => {
            vol.mkdirSync(p, o);
        },
        readdirSync: (p, o) =>
            vol.readdirSync(p, o) as ReturnType<StageFs["readdirSync"]>,
        readFileSync: (p, e) => vol.readFileSync(p, e) as string,
        writeFileSync: (p, d) => {
            vol.writeFileSync(p, d);
        },
    };
    return {vol, fs};
};
const run = async (
    corpusCase = makeCase(),
    options: {
        tierBudgets?: typeof DEFAULT_TIER_BUDGETS;
        disabledReviewers?: string[];
        fail?: string;
        outputs?: Record<string, unknown>;
    } = {},
) => {
    const requests: LiveAgentRequest[] = [];
    const {fs, vol} = fsForCase();
    const result = await produceLive(corpusCase, agents, {
        fs,
        stageDir: "/stage",
        ...options,
        runner: async (request) => {
            requests.push(request);
            return {
                output:
                    options.fail === request.name
                        ? "not JSON"
                        : JSON.stringify(
                              options.outputs?.[request.name] ?? {
                                  files: [],
                                  findings: [],
                              },
                          ),
                usd: 0.1,
                turns: 1,
                wallMs: 1,
            };
        },
    });
    return {result, requests, vol};
};

describe("live dispatch parity", () => {
    for (const round of evidence.rounds) {
        it(`replays the final low-tier roster from webapp run ${round.runId}`, async () => {
            const {result, requests, vol} = await run(makeCase(round.lenses));
            expect(requests).toHaveLength(round.observedFinderCount);
            expect(
                result.execution.roster.shed.map((a) => a.name).sort(),
            ).toEqual([...round.observedShed].sort());
            expect(
                result.perAgent
                    .filter((a) => a.shed)
                    .map((a) => a.name)
                    .sort(),
            ).toEqual([...round.observedShed].sort());
            expect(
                result.perAgent
                    .filter((a) => a.shed)
                    .every((a) => a.usd === 0 && !a.failed),
            ).toBe(true);
            expect(
                requests.every((r) => r.timeoutMs === DEFAULT_TIMEOUT_MS),
            ).toBe(true);
            const staged = JSON.parse(
                vol.readFileSync(
                    "/stage/context/routing.json",
                    "utf8",
                ) as string,
            );
            expect(staged.runBudget).toEqual(
                result.execution.routing.runBudget,
            );
            expect(staged.enabledReviewers).toEqual(result.execution.enabled);
            expect(computeRoster("full", staged, false)).toEqual(
                result.execution.roster,
            );
        });
    }
    it("prices cap recovery separately from adding a reviewer", async () => {
        const tierBudgets = {
            ...DEFAULT_TIER_BUDGETS,
            low: {...DEFAULT_TIER_BUDGETS.low, maxReviewerInvocations: 9},
        };
        const {result, requests} = await run(makeCase(), {tierBudgets});
        expect(requests).toHaveLength(9);
        expect(result.execution.roster.shed).toEqual([]);
    });
    it("clamps to the consumer credit cap before dispatch", async () => {
        const corpusCase = makeCase();
        corpusCase.routerConfig = {
            ...corpusCase.routerConfig,
            maxAiCredits: 100,
        };
        const {result, requests} = await run(corpusCase);
        expect(result.execution.routing.runBudget.maxReviewerInvocations).toBe(
            4,
        );
        expect(requests).toHaveLength(4);
    });
    it("keeps intentional off/on arms at the same budget snapshot", async () => {
        const {result, requests} = await run(makeCase(), {
            disabledReviewers: ["conventions"],
        });
        expect(result.execution.routing.runBudget.maxReviewerInvocations).toBe(
            8,
        );
        expect(requests.map((r) => r.name)).not.toContain("conventions");
        expect(requests.map((r) => r.name)).toContain("documentation");
        expect(result.perAgent.some((a) => a.absent || a.shed)).toBe(false);
    });
    it("doesn't count a failed core reviewer as a clean approval", async () => {
        const {result} = await run(makeCase(), {fail: "correctness-reviewer"});
        const arm = await runArm(
            "candidate",
            [makeCase()],
            async () => result,
            {maxUsd: 10, log: () => {}},
        );
        expect(arm.perCase[0]?.verdict).toBe("HOLD_FOR_HUMAN");
        expect(arm.perCase[0]?.accounting?.coverage.failed).toEqual([
            "correctness-reviewer",
        ]);
        expect(arm.perCase[0]?.accounting?.coverage.complete).toBe(false);
    });
});

describe("label-shape posting metadata", () => {
    for (const label of [
        "nitpick (non-blocking)",
        "note (non-blocking)",
    ] as const) {
        it(`preserves ${label} through normalization and posting`, async () => {
            const {result} = await run(makeCase(), {
                outputs: {
                    "correctness-reviewer": {
                        findings: [
                            {
                                path: "src/a.ts",
                                line: 1,
                                label,
                                importance: "medium",
                                subject: "Changed constant",
                                discussion:
                                    "The old value has a different meaning.",
                                failure_scenario:
                                    "Callers read the changed value.",
                            },
                        ],
                    },
                    "claim-validator": {
                        claims: [
                            {
                                id: "parity:live-correctness-reviewer-1",
                                verification: "confirmed",
                                reason: "checked",
                            },
                        ],
                    },
                },
            });
            expect(result.findings[0]?.labelOverride).toBe(label);
            expect(result.findings[0]?.finding.severity).toBe("medium");
            const arm = await runArm(
                "candidate",
                [makeCase()],
                async () => result,
                {maxUsd: 10, log: () => {}},
            );
            const posted = arm.runs[0]!.result;
            expect(posted.postedLabels).toEqual([label]);
            expect(posted.plannedReview.comments).toHaveLength(
                label.startsWith("nitpick") ? 0 : 1,
            );
        });
    }
});

describe("arm budget extraction", () => {
    const source = readFileSync(`${__dirname}/../lib/budgets.ts`, "utf8");
    it("reads the literal table without running arm code", () => {
        expect(extractTierBudgets(source)).toEqual(DEFAULT_TIER_BUDGETS);
    });
    it("rejects dynamic tables rather than falling back to the candidate budget", () => {
        expect(() =>
            extractTierBudgets(
                "export const DEFAULT_TIER_BUDGETS = getBudgets();",
            ),
        ).toThrow("literals only");
    });
    it("rejects invalid caps before dispatch", () => {
        expect(() =>
            extractTierBudgets(
                source.replace(
                    `maxReviewerInvocations: ${DEFAULT_TIER_BUDGETS.low.maxReviewerInvocations}`,
                    "maxReviewerInvocations: 8.5",
                ),
            ),
        ).toThrow("invalid low.maxReviewerInvocations");
    });
});
