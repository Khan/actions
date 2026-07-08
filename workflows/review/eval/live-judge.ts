/**
 * Live-judge entry point for the scheduled eval workflow
 * (`.github/workflows/review-eval-full.yml`).
 *
 * Replays the full corpus through the deterministic review path (loadCorpus ->
 * runCorpus -> computeMetrics -> evaluateGates) and scores the rendered review
 * comments with the live pinned judge model (`PINNED_JUDGE_MODEL`) through the
 * pure `JudgeModel` seam — `judge.ts` deliberately ships no API client, so this
 * file supplies the one production implementation. Nothing here checks out a
 * consumer repo or runs `review.md`: the corpus carries recorded findings, and
 * the judge grades the quality of the comments the deterministic path renders
 * from them.
 *
 * Run with `pnpm dlx tsx workflows/review/eval/live-judge.ts`. Requires
 * `ANTHROPIC_API_KEY`. When `GITHUB_STEP_SUMMARY` is set (as in Actions), the
 * metrics/gates/judge report is also appended there so scheduled runs are
 * readable without opening the log.
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {appendFileSync} from "fs";

import {loadCorpus} from "./corpus/loader.ts";
import {runCorpus} from "./runner.ts";
import {computeMetrics} from "./metrics.ts";
import {evaluateGates} from "./gates.ts";
import {
    judgeCorpus,
    PINNED_JUDGE_MODEL,
    type JudgeModel,
    type JudgeRequest,
    type JudgeScore,
} from "./judge.ts";
import type {EvalRun} from "./run-types.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const CONCURRENCY = 4;

const scoreOne = async (request: JudgeRequest): Promise<JudgeScore> => {
    const prompt = [
        "You are grading one code-review comment for quality.",
        'Return ONLY a JSON object: {"verdict": "good"|"borderline"|"bad", "quality": <0..1>, "rationale": "<one sentence>"}.',
        "",
        `PR context:\n${request.context}`,
        "",
        `Comment (lens=${request.lens}, label=${request.label}):\n${request.commentBody}`,
        "",
        `Evidence trace:\n${request.evidenceTrace.join("\n")}`,
    ].join("\n");
    const response = await fetch(API_URL, {
        method: "POST",
        headers: {
            "x-api-key": process.env["ANTHROPIC_API_KEY"] ?? "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: PINNED_JUDGE_MODEL,
            max_tokens: 512,
            messages: [{role: "user", content: prompt}],
        }),
    });
    if (!response.ok) {
        throw new Error(
            `judge call failed: ${response.status} ${await response.text()}`,
        );
    }
    const data = (await response.json()) as {
        content: {type: string; text?: string}[];
    };
    const text =
        data.content.find((block) => block.type === "text")?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
        throw new Error(
            `judge returned no JSON for finding ${request.findingId}: ${text}`,
        );
    }
    const parsed = JSON.parse(match[0]) as Omit<JudgeScore, "findingId">;
    return {findingId: request.findingId, ...parsed};
};

const liveJudge: JudgeModel = async (requests) => {
    const scores: JudgeScore[] = [];
    for (let i = 0; i < requests.length; i += CONCURRENCY) {
        const batch = requests.slice(i, i + CONCURRENCY);
        scores.push(...(await Promise.all(batch.map(scoreOne))));
    }
    return scores;
};

const main = async (): Promise<void> => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new Error("ANTHROPIC_API_KEY is required for the live judge.");
    }

    const cases = loadCorpus();
    const results = runCorpus(cases);
    const runs: EvalRun[] = cases.map((corpusCase, index) => ({
        corpusCase,
        result: results[index],
    }));

    const metrics = computeMetrics(runs);
    const gates = evaluateGates(runs);
    const judged = await judgeCorpus(runs, liveJudge);

    const report = {metrics, gates, judge: judged.report};
    console.log(JSON.stringify(report, null, 2));
    console.log(`audit sample (${judged.auditSample.length} entries):`);
    for (const entry of judged.auditSample) {
        console.log(JSON.stringify(entry));
    }

    // Make scheduled runs readable at a glance: append the report to the
    // Actions job summary when available.
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath !== undefined && summaryPath !== "") {
        appendFileSync(
            summaryPath,
            [
                "## Review eval — live judge",
                "",
                "```json",
                JSON.stringify(report, null, 2),
                "```",
                "",
            ].join("\n"),
        );
    }

    if (!gates.automaticModeAllowed) {
        console.error(
            "Adversarial hard gate FAILED on the scheduled full-suite run.",
        );
        process.exit(1);
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
