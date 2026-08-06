import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {computeDiffProvenance} from "./provenance";
import {createSpendLedger} from "./spend-ledger";

/**
 * The spend ceiling as the RUN sees it: does crossing it shed work, disclose
 * the shed, and leave the record saying what happened?
 *
 * Separate file from dispatch.test.ts for size, and separate subject: these
 * tests are about money, not about parsing. The ledger's arithmetic is pinned
 * in spend-ledger.test.ts; what is pinned here is the wiring, which is the part
 * that would fail silently. A ceiling that is never consulted looks exactly
 * like a ceiling that was never crossed.
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

const agentFiles = (...names: string[]): Record<string, string> =>
    Object.fromEntries(
        names.map((name) => [
            `${AGENTS}/${name}.md`,
            `---\nname: ${name}\ndescription: d\nmodel: claude-opus-4-8\n---\nYou are ${name}.`,
        ]),
    );

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

const staging = (): Record<string, string> => ({
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
    ...agentFiles(
        "pattern-triage",
        "correctness-reviewer",
        "skill-auditor",
        "claim-validator",
    ),
});

const FINDING = JSON.stringify({
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
});

/** A runner that charges `usd` for every dispatch and records its calls. */
const chargingRunner = (
    usd: number,
    outputs: Record<string, string>,
): AgentRunner & {calls: string[]} => {
    const calls: string[] = [];
    const runner = (async (request) => {
        calls.push(request.name);
        return {
            output: outputs[request.name] ?? JSON.stringify({findings: []}),
            usd,
            turns: 2,
            wallMs: 10,
        };
    }) as AgentRunner & {calls: string[]};
    runner.calls = calls;
    return runner;
};

describe("the spend ceiling inside runDispatch", () => {
    it("carries the cost record on the result, enforcement named", () => {
        // Cheap run: nothing sheds, and the record still says what governed it.
        const runner = chargingRunner(0.01, {
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": FINDING,
        });
        return runDispatch({
            fs: makeFakeFs(staging()),
            runner,
            repoRoot: "/work",
            ledger: createSpendLedger({env: {}, warn: () => {}}),
        }).then((result) => {
            expect(result.spend.enforcement).toBe("in-code");
            expect(result.spend.crossed).toBe(false);
            expect(result.spend.sheds).toEqual([]);
            expect(result.spend.spentUsd).toBeCloseTo(result.totalUsd, 6);
        });
    });

    it("refuses later dispatches once the budget is gone, and says so", async () => {
        // $1 per dispatch against a $2 ceiling holding $1 back: the first
        // dispatch settles, the budget is then gone, and everything after is
        // refused rather than half-run.
        const runner = chargingRunner(1, {
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": FINDING,
        });
        const result = await runDispatch({
            fs: makeFakeFs(staging()),
            runner,
            repoRoot: "/work",
            ledger: createSpendLedger({
                ceilingUsd: 2,
                landingReserveUsd: 1,
                env: {},
                warn: () => {},
            }),
        });

        // Exactly one dispatch was paid for; the rest never ran.
        expect(runner.calls).toHaveLength(1);
        expect(result.spend.crossed).toBe(true);
        // Every refusal is disclosed as a budget shed, with a note line a
        // reader of the review can actually see.
        const budgetSheds = result.skippedDimensions.filter(
            (skip) => skip.cause === "budget",
        );
        expect(budgetSheds.length).toBeGreaterThan(0);
        expect(result.noteLines.join("\n")).toContain("spend ceiling");
        // And the refused agents are reported as failed for budget, not as
        // agents that ran and found nothing.
        expect(
            result.perAgent.filter((agent) => agent.failed === "budget").length,
        ).toBeGreaterThan(0);
    });

    it("spends without refusing under the proxy-only rollback", async () => {
        const runner = chargingRunner(1, {
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": FINDING,
        });
        const result = await runDispatch({
            fs: makeFakeFs(staging()),
            runner,
            repoRoot: "/work",
            ledger: createSpendLedger({
                ceilingUsd: 2,
                landingReserveUsd: 1,
                env: {REVIEW_SPEND_ENFORCEMENT: "proxy-only"},
                warn: () => {},
            }),
        });
        // The whole roster ran: rollback means the ceiling measures and does
        // not enforce.
        expect(runner.calls.length).toBeGreaterThan(1);
        expect(result.spend.enforcement).toBe("proxy-only");
        expect(result.spend.crossed).toBe(true);
        // Still disclosed, so a rolled-back run is not a silent one.
        expect(result.noteLines.join("\n")).toContain("spend ceiling");
    });

    it("stages the cost record in the run artifact, not just in memory", async () => {
        const fs = makeFakeFs(staging());
        const runner = chargingRunner(0.01, {
            "pattern-triage": JSON.stringify({
                patterns: [],
                reviewFiles: ["a.ts"],
            }),
            "correctness-reviewer": FINDING,
        });
        await runDispatch({
            fs,
            runner,
            repoRoot: "/work",
            ledger: createSpendLedger({env: {}, warn: () => {}}),
        });
        // Both copies the gate and the post-hoc read carry it: without this the
        // record exists only where nobody looks.
        for (const path of [
            `${REVIEW}/dispatch-result.json`,
            `${REVIEW}/out/dispatch-result.json`,
        ]) {
            const staged = JSON.parse(fs.files[path]) as {
                spend?: {schemaVersion?: number; ceilingUsd?: number};
            };
            expect(staged.spend?.schemaVersion).toBe(1);
            expect(staged.spend?.ceilingUsd).toBe(12.5);
        }
    });
});
