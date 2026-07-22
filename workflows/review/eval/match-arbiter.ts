/**
 * The live fallback match arbiter (the tuning memo's rev-2 item 5): the
 * implementation behind live-match.ts's injected {@link MatchFallback} seam.
 * The deterministic matcher requires a mechanism alternate to hit the
 * finding's own wording; real model runs phrase the same defect a hundred
 * ways, and the "unmatched posted" noise metric reads 54-69% everywhere,
 * implausibly high as true noise. When a spec stays unmatched and a posted
 * candidate shares its file, this arbiter asks a pinned Haiku one yes/no
 * question: does this finding describe THIS labeled defect?
 *
 * Guard rails, all inherited from the seam: called only for specs the
 * deterministic pass left unmatched, only against candidates on a spec file,
 * hard-capped per case, and every match it claims is recorded `via:
 * "fallback"` in the report so a human can audit it. The prompt biases to NO
 * (a false yes inflates recall, the load-bearing metric; a false no just
 * leaves the report as conservative as it is today), and any API failure
 * degrades to a non-match, never a dead run.
 */

import type {LiveDefectSpec} from "./corpus/loader";
import type {MatchFallback} from "./live-match";
import type {RunCandidate} from "./runner";
import {extractJsonObject} from "./extract-json";

/**
 * Pinned snapshot, deliberately at the Haiku tier: the question is a narrow
 * semantic-equivalence check, priced to run up to 10x per case on every arm.
 */
export const PINNED_ARBITER_MODEL = "claude-haiku-4-5-20251001";

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000];

const isTransientStatus = (status: number): boolean =>
    status === 429 || status === 408 || status >= 500;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** The one question, deterministic in its inputs (unit-testable). */
export const buildArbiterPrompt = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
): string =>
    [
        "You are auditing one code-review comment against one labeled defect spec.",
        'Answer ONLY a JSON object: {"match": true|false}.',
        "",
        `Labeled defect: in file ${spec.path}` +
            (spec.lineStart !== undefined
                ? ` (lines ${spec.lineStart}-${spec.lineEnd ?? spec.lineStart})`
                : "") +
            (spec.lens !== undefined ? `, lens ${spec.lens}` : "") +
            ".",
        `Causal mechanism (any of): ${spec.mechanism.join(" | ")}`,
        "",
        `Review comment (anchored at ${candidate.path ?? "the PR"}${
            candidate.line !== undefined && candidate.line !== null
                ? `:${candidate.line}`
                : ""
        }):`,
        `Failure scenario: ${candidate.finding.failure_scenario}`,
        `Comment prose: ${candidate.finding.model_authored_prose}`,
        "",
        "match is true ONLY when the comment describes this same defect" +
            " (the same root cause and failure mode the mechanism names)," +
            " not merely a nearby, related, or different issue in the same" +
            " file. If uncertain, answer false.",
    ].join("\n");

/** Parse the arbiter's reply; anything but an explicit true is a no. */
export const parseArbiterAnswer = (text: string): boolean => {
    try {
        return extractJsonObject(text)["match"] === true;
    } catch {
        return false;
    }
};

/**
 * A {@link MatchFallback} scored over the Anthropic Messages API with the
 * pinned arbiter model. Transient failures retry with backoff; a call that
 * still fails resolves false (deterministic-only behavior for that spec) and
 * reports through `onError` rather than throwing; a matching pass must
 * never kill a run whose arms have already spent their budget.
 */
export const haikuMatchArbiter = (options?: {
    onError?: (message: string) => void;
}): MatchFallback => {
    const onError = options?.onError ?? (() => {});
    return async (candidate, spec) => {
        const prompt = buildArbiterPrompt(candidate, spec);
        try {
            // Typed via the fetch signature: the repo's eslint no-undef does
            // not know the fetch-API globals in type position.
            let response: Awaited<ReturnType<typeof fetch>> | undefined;
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
                            model: PINNED_ARBITER_MODEL,
                            max_tokens: 64,
                            messages: [{role: "user", content: prompt}],
                        }),
                    });
                } catch (error) {
                    // Network-level failure: transient by definition.
                    if (attempt === MAX_ATTEMPTS) {
                        throw new Error(String(error));
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
                    throw new Error(`${status} ${body}`);
                }
                response = undefined;
                await sleep(BACKOFF_MS[attempt - 1] ?? 4_000);
            }
            if (response === undefined) {
                throw new Error("no response");
            }
            const data = (await response.json()) as {
                content: {type: string; text?: string}[];
            };
            const text =
                data.content.find((block) => block.type === "text")?.text ?? "";
            return parseArbiterAnswer(text);
        } catch (error) {
            onError(
                `match arbiter failed for spec ${spec.key} vs ${
                    candidate.id
                }: ${String(error instanceof Error ? error.message : error)}`,
            );
            return false;
        }
    };
};
