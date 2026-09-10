import {describe, expect, it} from "vitest";

import {accountLiveRun, coverageNote} from "./live-accounting";
import {liveCase} from "./live-ab-fixtures";
import {runArm} from "./live-ab";
import {liveExecution, liveRouting} from "./live-roster";
import type {PerAgentReport} from "./live-producer";
import {runCase} from "./runner";
import {matchCase} from "./live-match";

const agent = (
    name: string,
    status: Partial<PerAgentReport> = {},
): PerAgentReport => ({
    name,
    model: "scripted",
    usd: 0.25,
    turns: 1,
    wallMs: 1,
    retried: false,
    ...status,
});
const corpusCase = liveCase("coverage");
const execution = liveExecution(
    "full",
    liveRouting(corpusCase, new Set(), {}),
    false,
);
const accounting = async (perAgent: PerAgentReport[], modeled = execution) => {
    const result = runCase(corpusCase);
    return accountLiveRun(
        {execution: modeled, findings: [], validation: [], perAgent},
        result,
        await matchCase(corpusCase, result),
    );
};

describe("modeled-reviewer coverage population", () => {
    it.each(["claim-validator", "thread-reconciler", "claim-clusterer"])(
        "excludes %s from finder dispatch counts but preserves stage failures",
        async (stage) => {
            const finders = execution.roster.finders.map((name) => agent(name));
            const success = await accounting([...finders, agent(stage)]);
            expect(success.coverage.planned).toEqual(execution.roster.finders);
            expect(success.coverage.dispatched).toEqual(
                success.coverage.planned,
            );
            expect(success.coverage.complete).toBe(true);
            expect(success.coverage.omittedStages).toEqual(["pattern-triage"]);
            const failure = await accounting([
                ...finders,
                agent(stage, {failed: "invalid output"}),
            ]);
            expect(failure.coverage.dispatched).toEqual(
                success.coverage.planned,
            );
            expect(failure.coverage.failed).toEqual([stage]);
            expect(failure.coverage.complete).toBe(false);
        },
    );

    it("keeps shed, absent, and failed reviewers distinct", async () => {
        const result = await accounting(
            [
                agent("correctness-reviewer", {failed: "invalid output"}),
                agent("skill-auditor", {absent: true, usd: 0}),
                agent("documentation", {shed: true, usd: 0}),
            ],
            {
                ...execution,
                roster: {
                    ...execution.roster,
                    shed: [{name: "documentation", cause: "budget"}],
                },
            },
        );
        expect(result.coverage).toMatchObject({
            planned: ["correctness-reviewer", "skill-auditor", "documentation"],
            dispatched: ["correctness-reviewer"],
            shed: ["documentation"],
            absent: ["skill-auditor"],
            failed: ["correctness-reviewer"],
            complete: false,
        });
    });

    it("doesn't count shed coverage as complete even when all dispatched finders succeed", async () => {
        const result = await accounting(
            [
                ...execution.roster.finders.map((name) => agent(name)),
                agent("documentation", {shed: true, usd: 0}),
            ],
            {
                ...execution,
                roster: {
                    ...execution.roster,
                    shed: [{name: "documentation", cause: "budget"}],
                },
            },
        );
        expect(result.coverage.complete).toBe(false);
    });

    it("doesn't invent a finder dispatch population without execution accounting", async () => {
        const arm = await runArm(
            "baseline",
            [corpusCase, liveCase("skipped")],
            async () => ({
                findings: [],
                validation: [],
                perAgent: [agent("claim-validator")],
            }),
            {maxUsd: 0.25, log: () => {}},
        );
        expect(arm.perCase[0]?.accounting?.coverage).toMatchObject({
            planned: [],
            dispatched: [],
            complete: false,
        });
        expect(coverageNote(arm)).toContain(
            "1/1 scored cases have incomplete or unrecorded modeled-reviewer coverage",
        );
        expect(coverageNote(arm)).toContain(
            "Skipped cases (not scored): 1 (skipped)",
        );
    });
});
