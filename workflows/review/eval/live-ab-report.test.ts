import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {parseCase, type CorpusCase} from "./corpus/loader";
import {renderMarkdownReport, runArm, type ArmProduce} from "./live-ab";
import {armCosts} from "./cost-rows";
import {armToolCalls} from "./live-ab-report";
import {readOverlayRates, type ModelTokens, type RateCard} from "./pricing";

/**
 * The report rows that read cost and volume apart. Split from live-ab.test.ts
 * at the max-lines cap; the fixture is the same minimal live case.
 */

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

const liveCase = (id: string): CorpusCase =>
    parseCase(
        {
            id,
            tags: ["live"],
            category: "incident-repro",
            description: "ab fixture",
            changedFiles: [{path: "src/a.ts", status: "modified"}],
            expected: {verdict: "REQUEST_CHANGES"},
            diff: DIFF,
            live: {
                prContext: {
                    title: "t",
                    description: "",
                    author: "a",
                    baseBranch: "main",
                },
                mustCatchSpecs: [
                    {
                        key: "bug",
                        path: "src/a.ts",
                        lineStart: 1,
                        lineEnd: 2,
                        mechanism: ["constant changed"],
                    },
                ],
            },
        },
        `test://${id}`,
    );

const withCalls =
    (usd: number, calls?: number): ArmProduce =>
    async () => ({
        findings: [],
        validation: [],
        perAgent: [
            {
                name: "correctness-reviewer",
                model: "m",
                usd,
                turns: 1,
                wallMs: 10,
                retried: false,
                ...(calls === undefined ? {} : {toolCalls: calls}),
            },
        ],
    });

describe("armToolCalls", () => {
    it("sums every agent's count and is undefined when no agent reported one", async () => {
        const counted = await runArm(
            "baseline",
            [liveCase("c")],
            withCalls(1, 7),
            {
                maxUsd: 10,
            },
        );
        expect(armToolCalls(counted)).toBe(7);
        const uncounted = await runArm(
            "baseline",
            [liveCase("c")],
            withCalls(1),
            {
                maxUsd: 10,
            },
        );
        expect(armToolCalls(uncounted)).toBeUndefined();
    });
});

describe("renderMarkdownReport cost rows", () => {
    it("renders tool calls and cost per call beside cost, so volume and rate read apart", async () => {
        // The gemini-3.8-flash A/B's 1.5x cost delta was a 3.8x tool-call
        // delta at 2.8x cheaper per call, and the table could not say so.
        const withCalls =
            (usd: number, calls: number): ArmProduce =>
            async () => ({
                findings: [],
                validation: [],
                perAgent: [
                    {
                        name: "correctness-reviewer",
                        model: "m",
                        usd,
                        turns: 1,
                        wallMs: 10,
                        retried: false,
                        toolCalls: calls,
                    },
                ],
            });
        const baseline = await runArm(
            "baseline",
            [liveCase("case-1")],
            withCalls(6, 300),
            {maxUsd: 10},
        );
        const candidate = await runArm(
            "candidate",
            [liveCase("case-1")],
            withCalls(9, 1200),
            {maxUsd: 10},
        );
        const markdown = renderMarkdownReport({
            baseRef: "origin/main",
            reviewMdSha: {baseline: "a".repeat(12), candidate: "b".repeat(12)},
            arms: {baseline, candidate},
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });
        expect(markdown).toContain("| Tool calls | 300 | 1200 | 4.00x |");
        expect(markdown).toContain(
            "| Cost per tool call | $0.0200 | $0.0075 |",
        );
        expect(markdown).toContain("| Cost (list price) | $6.00 | $9.00 |");
    });
});

describe("renderMarkdownReport priced rows", () => {
    // Every recorded usd is list price. Production meters claude at the
    // review.md overlay's rate (50% of list), and a model with no overlay
    // entry at list, so a mixed run needs both numbers side by side.
    const KHAN: RateCard = new Map([
        [
            "claude-opus-5",
            {
                input: 2.5e-6,
                output: 1.25e-5,
                cacheRead: 2.5e-7,
                cacheWrite: 3.125e-6,
            },
        ],
        [
            "claude-haiku-4-5",
            {input: 5e-7, output: 2.5e-6, cacheRead: 5e-8, cacheWrite: 6.25e-7},
        ],
    ]);
    /** Tokens that price to exactly $6.00 at opus-5 list ($3.00 Khan). */
    const OPUS_6_LIST: ModelTokens = {
        model: "claude-opus-5",
        input: 400_000,
        output: 160_000,
        cacheRead: 0,
        cacheWrite: 0,
    };
    /** Tokens priced by nothing in either card. */
    const GEMINI: ModelTokens = {
        model: "gemini-3.8-flash",
        input: 3_000_000,
        output: 500_000,
        cacheRead: 0,
        cacheWrite: 0,
    };
    const agent = (
        name: string,
        usd: number,
        usage: ModelTokens | undefined,
        toolCalls?: number,
    ) => ({
        name,
        model: usage?.model ?? "m",
        usd,
        turns: 1,
        wallMs: 10,
        retried: false,
        ...(usage === undefined ? {} : {usage: [usage]}),
        ...(toolCalls === undefined ? {} : {toolCalls}),
    });
    const producing =
        (...agents: ReturnType<typeof agent>[]): ArmProduce =>
        async () => ({findings: [], validation: [], perAgent: agents});
    const report = (
        baseline: Awaited<ReturnType<typeof runArm>>,
        candidate: Awaited<ReturnType<typeof runArm>>,
    ) => ({
        baseRef: "origin/main",
        reviewMdSha: {baseline: "a".repeat(12), candidate: "b".repeat(12)},
        arms: {baseline, candidate},
        regressions: {lost: [], gained: []},
        adversarialFailures: [],
        gateRetries: [],
    });

    it("prices a claude arm at half its list row and leaves a gemini arm at list, and says so", async () => {
        const baseline = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 6, OPUS_6_LIST, 300)),
            {maxUsd: 10},
        );
        const candidate = await runArm(
            "candidate",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 9, GEMINI, 1200)),
            {maxUsd: 10},
        );
        expect(baseline.perCase[0]?.agentCosts).toEqual([
            {
                agent: "correctness-reviewer",
                model: "claude-opus-5",
                usd: 6,
                usage: [OPUS_6_LIST],
            },
        ]);
        expect(armCosts(baseline)?.map((c) => c.usage)).toEqual([
            [OPUS_6_LIST],
        ]);
        const markdown = renderMarkdownReport(report(baseline, candidate), {
            khanRates: KHAN,
        });
        expect(markdown).toContain("| Cost (list price) | $6.00 | $9.00 |");
        // The gemini arm's two rows are equal: no overlay entry means
        // production bills it at list too.
        expect(markdown).toContain("| Cost (Khan rate) | $3.00 | $9.00 |");
        expect(markdown).toContain(
            "| Cost per tool call (list / Khan rate) | $0.0200 / $0.0100 | $0.0075 / $0.0075 |",
        );
        expect(markdown).toContain(
            "Cost (Khan rate) prices the same tokens at the `models.providers` overlay in review.md, which is what production meters (claude-opus-5). No overlay entry, so read at list: gemini-3.8-flash. Cost (list price) is the SDK's own meter",
        );
        // The list table agrees with the SDK's meter here, so no drift note.
        expect(markdown).not.toContain("List-rate check");
        // No judge or arbiter ran, so no overhead rows.
        expect(markdown).not.toContain("Judge + arbiter");
    });

    it("re-prices a mixed arm per model, not per arm", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(
                agent("correctness-reviewer", 6, OPUS_6_LIST),
                agent("security-reviewer", 4, GEMINI),
            ),
            {maxUsd: 20},
        );
        expect(arm.usd).toBe(10);
        const markdown = renderMarkdownReport(report(arm, arm), {
            khanRates: KHAN,
        });
        // 6 * 0.5 for claude plus gemini's recorded 4 at list.
        expect(markdown).toContain("| Cost (Khan rate) | $7.00 | $7.00 |");
    });

    it("adds the judge and arbiter from their tokens and totals the run", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 6, OPUS_6_LIST)),
            {maxUsd: 10},
        );
        // 1M haiku input at list is $1.00 (Khan $0.50).
        const haiku: ModelTokens = {
            model: "claude-haiku-4-5-20251001",
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        };
        const metered = {...arm, overhead: {judge: [haiku], arbiter: [haiku]}};
        const markdown = renderMarkdownReport(report(metered, arm), {
            khanRates: KHAN,
        });
        expect(markdown).toContain(
            "| Judge + arbiter (list / Khan rate) | $2.00 / $1.00 | n/a |",
        );
        expect(markdown).toContain(
            "| Run total (list / Khan rate) | $8.00 / $4.00 | n/a |",
        );
    });

    it("flags a list table that disagrees with the SDK's meter", async () => {
        // Same tokens, but the runner reported twice what the table prices
        // them at: one of the two has moved and the report must not pick.
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 12, OPUS_6_LIST)),
            {maxUsd: 20},
        );
        const markdown = renderMarkdownReport(report(arm, arm), {
            khanRates: KHAN,
        });
        expect(markdown).toContain(
            "List-rate check (baseline): the eval's list table prices these tokens at $6.00 and the SDK metered $12.00 (0.50x). One of the two has moved, see pricing.ts.",
        );
        // The Khan figure still comes from tokens, not from the drifted meter.
        expect(markdown).toContain("| Cost (Khan rate) | $3.00 | $3.00 |");
    });

    it("omits the priced rows without a rate card, and prints n/a on an artifact predating tokens", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 6, OPUS_6_LIST)),
            {maxUsd: 10},
        );
        const plain = renderMarkdownReport(report(arm, arm));
        expect(plain).not.toContain("Khan rate");
        expect(plain).toContain("| Cost (list price) | $6.00 | $6.00 |");
        const legacy = {
            ...arm,
            perCase: arm.perCase.map(({agentCosts: _, ...rest}) => rest),
        };
        const markdown = renderMarkdownReport(report(legacy, legacy), {
            khanRates: KHAN,
        });
        expect(markdown).toContain("| Cost (Khan rate) | n/a | n/a |");
        expect(markdown).toContain(
            "Khan rate: n/a, this artifact predates per-agent cost.",
        );
    });

    it("prices a dispatch with no token counts by the overlay ratio, and says so", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 6, OPUS_6_LIST), {
                ...agent("security-reviewer", 2, undefined),
                model: "claude-opus-5",
            }),
            {maxUsd: 10},
        );
        const markdown = renderMarkdownReport(report(arm, arm), {
            khanRates: KHAN,
        });
        // 3 from tokens plus the untracked opus dispatch by ratio, 2 * 0.5.
        expect(markdown).toContain("| Cost (Khan rate) | $4.00 | $4.00 |");
        // One per arm, and the same arm is rendered on both sides.
        expect(markdown).toContain(
            "2 dispatch(es) recorded no token counts and are priced from the SDK's list figure by the overlay ratio (at list where the model has none).",
        );
    });

    it("bills a refusal fallback on the model it fell back to, and skips absent reviewers", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            async () => ({
                findings: [],
                validation: [],
                perAgent: [
                    // Pinned to a model with no overlay entry, fell back to
                    // opus: the dollars were spent on opus and price at 0.5x.
                    {
                        name: "correctness-reviewer",
                        model: "gemini-3.8-flash",
                        fellBackTo: "claude-opus-5",
                        usd: 6,
                        turns: 1,
                        wallMs: 10,
                        retried: true,
                        usage: [OPUS_6_LIST],
                    },
                    // The placeholder live-producer seeds per reviewer this
                    // arm's review.md lacks: never dispatched, not a cost.
                    {
                        name: "documentation",
                        model: "",
                        usd: 0,
                        turns: 0,
                        wallMs: 0,
                        retried: false,
                        absent: true,
                    },
                ],
            }),
            {maxUsd: 10},
        );
        expect(arm.perCase[0]?.agentCosts).toEqual([
            {
                agent: "correctness-reviewer",
                model: "claude-opus-5",
                usd: 6,
                usage: [OPUS_6_LIST],
            },
        ]);
        const markdown = renderMarkdownReport(report(arm, arm), {
            khanRates: KHAN,
        });
        expect(markdown).toContain("| Cost (Khan rate) | $3.00 | $3.00 |");
        expect(markdown).not.toContain("recorded no token counts");
    });

    it("prices the gate-retry spend in both currencies when rates are in hand", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 6, OPUS_6_LIST)),
            {maxUsd: 10},
        );
        const markdown = renderMarkdownReport(
            {
                ...report(arm, arm),
                adversarialFailures: ["adv-1: missed spec bug"],
                gateRetries: [
                    {
                        caseId: "adv-1",
                        attempts: [
                            {
                                pass: false,
                                failures: ["adv-1: missed spec bug"],
                                usd: 6,
                                agentCosts: [
                                    {
                                        agent: "correctness-reviewer",
                                        model: "claude-opus-5",
                                        usd: 6,
                                        usage: [OPUS_6_LIST],
                                    },
                                ],
                            },
                        ],
                        settledPass: false,
                    },
                ],
            },
            {khanRates: KHAN},
        );
        expect(markdown).toContain(
            "failure confirmed ($6.00 retry spend at list, $3.00 at Khan's rate)",
        );
    });

    it("prices the clusterer's merge-row figure in both currencies", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            async () => ({
                findings: [],
                validation: [],
                perAgent: [
                    agent("correctness-reviewer", 6, OPUS_6_LIST),
                    {
                        name: "claim-clusterer",
                        model: "claude-opus-5",
                        usd: 6,
                        turns: 2,
                        wallMs: 21_000,
                        retried: false,
                        usage: [OPUS_6_LIST],
                    },
                ],
                dedup: {
                    candidates: 4,
                    merges: [],
                    rejected: [],
                    clustererAbsent: false,
                },
            }),
            {maxUsd: 20},
        );
        const markdown = renderMarkdownReport(report(arm, arm), {
            khanRates: KHAN,
        });
        expect(markdown).toContain(
            "0 by clusterer at $6.00 list, $3.00 Khan rate / 21s",
        );
    });

    it("prices the real review.md overlay at half of list for opus 5", async () => {
        const arm = await runArm(
            "baseline",
            [liveCase("case-1")],
            producing(agent("correctness-reviewer", 6, OPUS_6_LIST)),
            {maxUsd: 10},
        );
        const markdown = renderMarkdownReport(report(arm, arm), {
            khanRates: readOverlayRates(
                readFileSync(join(__dirname, "..", "review.md"), "utf8"),
            ),
        });
        expect(markdown).toContain("| Cost (Khan rate) | $3.00 | $3.00 |");
    });
});
