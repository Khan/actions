import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, it, expect, afterEach} from "vitest";

import {
    findArtifactFile,
    loadRunDir,
    parseJsonl,
    renderCountersMarkdown,
    synthesizeSummaryFromGhAw,
    UNATTRIBUTED_SOURCE,
} from "./counters-report.ts";
import {computeRunCounters, joinValidatorDecisions} from "./counters.ts";

describe("parseJsonl", () => {
    it("keeps valid records and drops blank/malformed lines", () => {
        const text = '{"type":"add_comment"}\n\nnot json\n{"type":"x"}';
        expect(parseJsonl(text)).toEqual([{type: "add_comment"}, {type: "x"}]);
    });
});

describe("synthesizeSummaryFromGhAw", () => {
    it("derives verdict, posted count, and cost from the engine artifacts", () => {
        const summary = synthesizeSummaryFromGhAw({
            safeOutputs: [
                '{"type":"create_pull_request_review_comment","body":"a"}',
                '{"type":"submit_pull_request_review","event":"REQUEST_CHANGES"}',
                '{"type":"upload_artifact"}',
            ].join("\n"),
            postedItems: [
                '{"type":"create_pull_request_review_comment","url":"u1"}',
                '{"type":"add_comment","url":"u2"}',
            ].join("\n"),
            agentUsage: {
                input_tokens: 1000,
                output_tokens: 500,
                ai_credits: 430.924,
            },
        });

        expect(summary["verdict"]).toBe("REQUEST_CHANGES");
        // The handler log (what actually posted) wins over emitted intent.
        expect(summary["postedCommentCount"]).toBe(2);
        expect(summary["cost"]).toEqual({usd: 4.30924, tokens: 1500});
    });

    it("keeps REQUEST_CHANGES when a malformed artifact also carries APPROVE", () => {
        const summary = synthesizeSummaryFromGhAw({
            safeOutputs: [
                '{"type":"submit_pull_request_review","event":"REQUEST_CHANGES"}',
                '{"type":"submit_pull_request_review","event":"APPROVE"}',
            ].join("\n"),
        });
        expect(summary["verdict"]).toBe("REQUEST_CHANGES");
    });

    it("counts emitted intent when the handler log is absent", () => {
        const summary = synthesizeSummaryFromGhAw({
            safeOutputs: '{"type":"add_comment","body":"guidance"}',
        });
        expect(summary["postedCommentCount"]).toBe(1);
        expect(summary["verdict"]).toBeUndefined();
    });

    it("yields an empty posted count with no artifacts at all", () => {
        expect(synthesizeSummaryFromGhAw({})["postedCommentCount"]).toBe(0);
    });
});

describe("validator vocabulary folding (counters.ts)", () => {
    it("accepts the production {claims: [...]} shape with three-state verification", () => {
        const decisions = joinValidatorDecisions(
            undefined,
            {
                claims: [
                    {id: "v1", verification: "refuted"},
                    {id: "v2", verification: "plausible"},
                    {id: "v3", verification: "confirmed"},
                    {id: "v4", verification: "unsure"}, // unknown -> skipped
                ],
            },
            UNATTRIBUTED_SOURCE,
        );
        expect(decisions).toEqual([
            {source: UNATTRIBUTED_SOURCE, decision: "drop"},
            {source: UNATTRIBUTED_SOURCE, decision: "keep"},
            {source: UNATTRIBUTED_SOURCE, decision: "keep"},
        ]);
    });

    it("still skips unattributed entries when no fallback source is given", () => {
        const decisions = joinValidatorDecisions(undefined, [
            {id: "v1", verdict: "drop"},
        ]);
        expect(decisions).toEqual([]);
    });

    it("prefers the claims.json source join when it matches", () => {
        const decisions = joinValidatorDecisions(
            [{id: "v1", source: "security-auth"}],
            [{id: "v1", verdict: "keep"}],
            UNATTRIBUTED_SOURCE,
        );
        expect(decisions).toEqual([
            {source: "security-auth", decision: "keep"},
        ]);
    });
});

describe("loadRunDir", () => {
    const cleanups: string[] = [];
    afterEach(() => {
        for (const dir of cleanups.splice(0)) {
            rmSync(dir, {recursive: true, force: true});
        }
    });

    const makeRunDir = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "counters-report-"));
        cleanups.push(dir);
        return dir;
    };

    it("tolerates gh-aw staging-path nesting and synthesizes the summary", () => {
        const dir = makeRunDir();
        // The known staging-path bug: artifact contents nested under the
        // absolute staging path instead of the artifact root.
        const nested = join(dir, "tmp", "gh-aw", "review", "out");
        mkdirSync(nested, {recursive: true});
        writeFileSync(
            join(nested, "claim-validator.json"),
            JSON.stringify({
                claims: [
                    {id: "v1", verification: "refuted"},
                    {id: "v2", verification: "confirmed"},
                ],
            }),
        );
        writeFileSync(
            join(dir, "safeoutputs.jsonl"),
            '{"type":"submit_pull_request_review","event":"APPROVE"}\n' +
                '{"type":"create_pull_request_review_comment"}\n',
        );
        writeFileSync(
            join(dir, "agent_usage.json"),
            JSON.stringify({
                input_tokens: 10,
                output_tokens: 5,
                ai_credits: 200,
            }),
        );

        const {run, hasVerdict} = loadRunDir(dir);
        expect(hasVerdict).toBe(true);
        expect(run.verdict).toBe("APPROVE");
        expect(run.postedCommentCount).toBe(1);
        expect(run.cost).toEqual({usd: 2, tokens: 15});
        expect(run.validatorDecisions).toEqual([
            {source: UNATTRIBUTED_SOURCE, decision: "drop"},
            {source: UNATTRIBUTED_SOURCE, decision: "keep"},
        ]);
    });

    it("flags a run with no submitted review as verdict-less", () => {
        const dir = makeRunDir();
        writeFileSync(
            join(dir, "safeoutputs.jsonl"),
            '{"type":"add_comment","body":"guidance"}\n',
        );
        const {run, hasVerdict} = loadRunDir(dir);
        expect(hasVerdict).toBe(false);
        expect(run.verdict).toBe("HOLD_FOR_HUMAN"); // documented safe fallback
    });

    it("prefers an explicit summary.json over synthesis", () => {
        const dir = makeRunDir();
        writeFileSync(
            join(dir, "summary.json"),
            JSON.stringify({verdict: "REQUEST_CHANGES", postedCommentCount: 4}),
        );
        writeFileSync(
            join(dir, "safeoutputs.jsonl"),
            '{"type":"submit_pull_request_review","event":"APPROVE"}\n',
        );
        const {run} = loadRunDir(dir);
        expect(run.verdict).toBe("REQUEST_CHANGES");
        expect(run.postedCommentCount).toBe(4);
    });

    it("findArtifactFile returns the shallowest match", () => {
        const dir = makeRunDir();
        mkdirSync(join(dir, "deep", "deeper"), {recursive: true});
        writeFileSync(join(dir, "deep", "deeper", "x.json"), "{}");
        writeFileSync(join(dir, "x.json"), "{}");
        expect(findArtifactFile(dir, "x.json")).toBe(join(dir, "x.json"));
        expect(findArtifactFile(dir, "missing.json")).toBeUndefined();
    });
});

describe("renderCountersMarkdown", () => {
    it("renders the aggregate tables with the verdict-fallback footnote", () => {
        const counters = computeRunCounters([
            {
                runId: "1",
                verdict: "APPROVE",
                postedCommentCount: 3,
                validatorDecisions: [
                    {source: "(unknown)", decision: "keep"},
                    {source: "(unknown)", decision: "drop"},
                ],
                cost: {usd: 4.2},
            },
            {
                runId: "2",
                verdict: "HOLD_FOR_HUMAN",
                postedCommentCount: 0,
                validatorDecisions: [],
            },
        ]);
        const markdown = renderCountersMarkdown(counters, 1);
        expect(markdown).toContain("Aggregated over **2** review runs");
        expect(markdown).toContain("| 1 | 0 | 1 |");
        expect(markdown).toContain("*1 run(s) submitted no review");
        expect(markdown).toContain("| (unknown) | 2 | 1 | 50.0% |");
        expect(markdown).toContain("$4.20 total");
        expect(markdown).toContain("thumbs-sweep run's job summary");
    });
});
