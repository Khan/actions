/**
 * The one production {@link JudgeModel}: the pinned judge scored over the
 * Anthropic Messages API. Extracted from `live-judge.ts` so the live A/B
 * runner (`live-ab.ts`) can score both arms with the same judge without
 * importing that file's CLI entry point. `judge.ts` deliberately ships no API
 * client; this module is its single live implementation.
 *
 * Requires `ANTHROPIC_API_KEY`.
 */

import {
    PINNED_JUDGE_MODEL,
    type JudgeModel,
    type JudgeRequest,
    type JudgeScore,
} from "./judge";

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

/** Score requests with the live pinned judge, in bounded batches. */
export const liveJudgeModel: JudgeModel = async (requests) => {
    const scores: JudgeScore[] = [];
    for (let i = 0; i < requests.length; i += CONCURRENCY) {
        const batch = requests.slice(i, i + CONCURRENCY);
        scores.push(...(await Promise.all(batch.map(scoreOne))));
    }
    return scores;
};
