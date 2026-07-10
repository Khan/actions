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

/**
 * Retry policy for one judge call: transient failures (429, 5xx, network)
 * back off and retry; anything else throws immediately. Before this, a
 * single transient 500 killed the whole scoring pass after every arm had
 * already spent its budget (judgeArm degrades that to a judgeError note, but
 * the weekly full-corpus run lost all its scores).
 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000];

const isTransientStatus = (status: number): boolean =>
    status === 429 || status === 408 || status >= 500;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

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
    let response: Response | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            response = await fetch(API_URL, {
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
        } catch (error) {
            // Network-level failure: transient by definition.
            if (attempt === MAX_ATTEMPTS) {
                throw new Error(
                    `judge call failed after ${MAX_ATTEMPTS} attempts: ${String(
                        error,
                    )}`,
                );
            }
            await sleep(BACKOFF_MS[attempt - 1] ?? 4_000);
            continue;
        }
        if (response.ok) {
            break;
        }
        const status = response.status;
        const body = await response.text();
        if (!isTransientStatus(status) || attempt === MAX_ATTEMPTS) {
            throw new Error(`judge call failed: ${status} ${body}`);
        }
        response = undefined;
        await sleep(BACKOFF_MS[attempt - 1] ?? 4_000);
    }
    if (response === undefined) {
        throw new Error("judge call failed: no response");
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
