/**
 * The production ProseRunner for the prose judge (judge-prose.ts): one Pi
 * model call per prompt, no tools, one turn. Split out (like
 * dispatch-runner-pi.ts) so unit tests never load Pi's libraries; only the
 * CLI entry imports this module, lazily.
 *
 * Why Pi and not a raw `fetch` to the Anthropic API: inside the firewall
 * sandbox the api-proxy injects auth and meters spend, and the agent job
 * runs `--exclude-env ANTHROPIC_API_KEY` (see dispatch.ts's header), while
 * node's fetch would have to be steered by hand. The judge call goes through
 * the same provider registration the dispatch runner uses — Pi's Anthropic
 * provider re-based onto `ANTHROPIC_BASE_URL` when the sandbox sets one —
 * so the judge is priced and capped like the rest of the run. (The SDK
 * subprocess the pre-Pi harness used for this is gone with the harness.)
 */

import {
    ANTHROPIC_BASE_URL_ENV,
    providerForPin,
    rebaseModels,
    resolveModelId,
} from "./dispatch-models";
import type {ProseRunner} from "./judge-prose";

/**
 * Per-call ceiling. A judge call is a bounded classification over one
 * comment; two minutes is generous and keeps a wedged call from stalling
 * the submit_result path it runs inside.
 */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Bounded transient-failure retries for the judge calls, for the same
 * reason dispatch-runner-pi.ts restores them on sub-agent turns: nothing
 * upstream supplies one, and pi-ai's own default is 0.
 */
const JUDGE_MAX_RETRIES = 2;

/**
 * The dispatch CLI's construction path: the pinned judge model, fail-open
 * at construction too. A judge that cannot even be built must cost nothing
 * but a workflow warning, so the dispatch (and the review) proceeds
 * unjudged rather than red.
 */
export const createDefaultProseRunner = async (): Promise<
    ProseRunner | undefined
> => {
    try {
        const {PINNED_PROSE_JUDGE_MODEL} = await import("./judge-prose");
        return await createJudgeRunner(PINNED_PROSE_JUDGE_MODEL);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
            `::warning title=prose judge::judge unavailable (review proceeds unjudged): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return undefined;
    }
};

export const createJudgeRunner = async (
    modelPin: string,
): Promise<ProseRunner> => {
    const ai = (await import("@earendil-works/pi-ai")) as {
        createModels: () => {
            setProvider: (provider: unknown) => void;
            getModels: (provider?: string) => readonly {id: string}[];
            getModel: (provider: string, id: string) => unknown;
            completeSimple: (
                model: unknown,
                context: unknown,
                options?: unknown,
            ) => Promise<{
                stopReason: string;
                errorMessage?: string;
                content: {type: string; text?: string}[];
            }>;
        };
    };
    const {anthropicProvider} = (await import(
        "@earendil-works/pi-ai/providers/anthropic"
    )) as {
        anthropicProvider: () => {
            id: string;
            getModels: () => readonly {id: string; baseUrl?: string}[];
        };
    };

    const models = ai.createModels();
    const baseUrl = process.env[ANTHROPIC_BASE_URL_ENV];
    const anthropic = anthropicProvider();
    models.setProvider(
        baseUrl === undefined || baseUrl === ""
            ? anthropic
            : rebaseModels(anthropic, baseUrl),
    );
    const providerId = providerForPin(modelPin);
    const modelId = resolveModelId(modelPin, models.getModels(providerId));
    const model = models.getModel(providerId, modelId);
    if (model === undefined) {
        throw new Error(`Pi could not load the judge model "${modelId}"`);
    }

    return async (prompt: string): Promise<string> => {
        const abort = new AbortController();
        const timer = setTimeout(() => {
            abort.abort(
                new Error(`judge call timed out after ${CALL_TIMEOUT_MS}ms`),
            );
        }, CALL_TIMEOUT_MS);
        try {
            const message = await models.completeSimple(
                model,
                {
                    messages: [
                        {
                            role: "user",
                            content: [{type: "text", text: prompt}],
                            timestamp: Date.now(),
                        },
                    ],
                },
                {signal: abort.signal, maxRetries: JUDGE_MAX_RETRIES},
            );
            if (
                message.stopReason === "error" ||
                message.stopReason === "aborted"
            ) {
                throw new Error(
                    `judge call ended without success: ${
                        message.errorMessage ?? message.stopReason
                    }`,
                );
            }
            const text = message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("");
            if (text === "") {
                throw new Error("judge call produced no text");
            }
            return text;
        } finally {
            clearTimeout(timer);
        }
    };
};
