/**
 * The production ProseRunner for the prose judge (judge-prose.ts): one
 * Claude Agent SDK call per prompt, no tools, one turn. Split out (like
 * dispatch-runner.ts) so unit tests never load the SDK; only the CLI entry
 * imports this module, lazily.
 *
 * Why the SDK and not a raw `fetch` to the Anthropic API: inside the
 * firewall sandbox the api-proxy injects auth and meters spend, and the
 * agent job runs `--exclude-env ANTHROPIC_API_KEY` (see dispatch.ts's
 * header), while node's fetch ignores the proxy environment entirely. A
 * fetch-based judge would therefore error on every call in production, and
 * since the judge fails open, enforcement would silently become a no-op.
 * The SDK subprocess inherits the same proxy plumbing every other sub-agent
 * call uses, so the judge is priced and capped like the rest of the run.
 */

import type {ProseRunner} from "./judge-prose";

/**
 * Per-call ceiling. A judge call is a bounded classification over one
 * comment; two minutes is generous and keeps a wedged call from stalling
 * the submit_result path it runs inside.
 */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Restore the SDK's own default retries for the judge subprocesses; the
 * engine step's environment disables them for the orchestrator process only
 * (same reasoning and value as dispatch-runner.ts).
 */
const JUDGE_MAX_RETRIES = "2";

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
    model: string,
): Promise<ProseRunner> => {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
        query: (input: {
            prompt: string;
            options: Record<string, unknown>;
        }) => AsyncIterable<Record<string, unknown>>;
    };

    return async (prompt: string): Promise<string> => {
        const abort = new AbortController();
        const timer = setTimeout(() => {
            abort.abort(
                new Error(`judge call timed out after ${CALL_TIMEOUT_MS}ms`),
            );
        }, CALL_TIMEOUT_MS);
        try {
            const run = sdk.query({
                prompt,
                options: {
                    model,
                    maxTurns: 1,
                    allowedTools: [],
                    permissionMode: "bypassPermissions",
                    abortController: abort,
                    env: {
                        ...process.env,
                        ANTHROPIC_MAX_RETRIES: JUDGE_MAX_RETRIES,
                    },
                },
            });
            for await (const message of run) {
                if (message["type"] !== "result") {
                    continue;
                }
                if (message["subtype"] !== "success") {
                    throw new Error(
                        `judge call ended without success: ${String(
                            message["subtype"],
                        )}`,
                    );
                }
                return String(message["result"] ?? "");
            }
            throw new Error("judge call produced no result message");
        } finally {
            clearTimeout(timer);
        }
    };
};
