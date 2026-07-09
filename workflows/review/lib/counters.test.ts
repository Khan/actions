import {describe, it, expect} from "vitest";

import {computeRunCounters, normalizeRunArtifacts} from "./counters";
import type {RunArtifacts} from "./counters";

const runOf = (over: Partial<RunArtifacts>): RunArtifacts => ({
    runId: "run",
    verdict: "APPROVE",
    postedCommentCount: 0,
    validatorDecisions: [],
    ...over,
});

describe("computeRunCounters: cost by re-review depth", () => {
    it("groups run cost by executed depth; the mode-dial pricing surface", () => {
        const counters = computeRunCounters([
            runOf({runId: "a", rereviewDepth: "full", cost: {usd: 9.14}}),
            runOf({runId: "b", rereviewDepth: "full", cost: {usd: 8.77}}),
            runOf({runId: "c", rereviewDepth: "scoped", cost: {usd: 3.1}}),
            runOf({runId: "d", rereviewDepth: "fast", cost: {usd: 0.9}}),
        ]);
        expect(counters.costByRereviewDepth).toEqual([
            {depth: "fast", runs: 1, totalUsd: 0.9, usdPerRun: 0.9},
            {depth: "full", runs: 2, totalUsd: 17.91, usdPerRun: 8.955},
            {depth: "scoped", runs: 1, totalUsd: 3.1, usdPerRun: 3.1},
        ]);
    });

    it("groups depth-less runs (older reviewer versions) under unrecorded, cost null when unknown", () => {
        const counters = computeRunCounters([runOf({runId: "old"})]);
        expect(counters.costByRereviewDepth).toEqual([
            {depth: "unrecorded", runs: 1, totalUsd: null, usdPerRun: null},
        ]);
    });

    it("is empty over an empty window", () => {
        expect(computeRunCounters([]).costByRereviewDepth).toEqual([]);
    });
});

describe("normalizeRunArtifacts: re-review depth", () => {
    it("reads the depth from the staged plan artifact", () => {
        const run = normalizeRunArtifacts(
            {
                summary: {verdict: "APPROVE"},
                rereviewPlan: {depth: "flip-gated", dispatch: "reconcile+correctness"},
            },
            "fallback",
        );
        expect(run.rereviewDepth).toBe("flip-gated");
    });

    it("falls back to a summary-recorded depth when no plan is uploaded", () => {
        const run = normalizeRunArtifacts(
            {summary: {verdict: "APPROVE", rereviewDepth: "scoped"}},
            "fallback",
        );
        expect(run.rereviewDepth).toBe("scoped");
    });

    it("leaves the field absent when neither source records one", () => {
        const run = normalizeRunArtifacts(
            {summary: {verdict: "APPROVE"}},
            "fallback",
        );
        expect(run.rereviewDepth).toBeUndefined();
    });
});
