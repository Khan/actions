/**
 * The AgentRunner for the scripted dispatcher (`dispatch.ts`), built on Pi's
 * libraries (`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`). It
 * replaced the Claude-Agent-SDK runner after the re-anchoring harness A/B
 * (run 30666183461: two full-corpus repeats, identical model pins, identical
 * review.md) showed quality parity arm-to-arm with roughly half the cost and
 * 60% of the wall clock; the numbers live on PR #305.
 *
 * Why Pi: its libraries are multi-provider, so moving a role to a
 * non-Anthropic model is a pin change rather than a second bespoke agent
 * loop, and a cross-provider A/B measures the model instead of the harness
 * (exercised for real by the gemini-3.8-flash pins: dispatch-models.ts
 * routes each pin to its provider). Pi also reports usage with a
 * per-component `cost` breakdown (input, output, cacheRead, cacheWrite), so
 * `AgentResult.usd` does not inherit the api-proxy default-pricing path's
 * known cache-write under-count.
 *
 * The tools are implemented in dispatch-tools-pi.ts rather than taken from
 * pi-coding-agent's factories (which do include a `createReadOnlyTools`)
 * because the SDK's tool layer cannot be uniformly sandboxed. Verified
 * against 0.83.0/dist:
 * its `grep` spawns rg directly (`core/tools/grep.js`, via
 * `ensureTool("rg", true)`, which downloads the binary if absent) with no
 * interceptable exec seam, its `read` is in-process `fs.readFile`, and only
 * its `bash` exposes a `spawnHook`. The runner process deliberately sits
 * OUTSIDE the sandbox (the loop must reach the model provider), so adopting
 * those factories would sandbox Bash while Read and Grep ran unwrapped in
 * the credentialed process: a hole in the mount-level boundary, not a
 * trade. The single ToolExec seam (dispatch-exec.ts) is what makes the
 * sandbox policy total. Two SDK defaults reinforce the decision: `createAgentSession`
 * trusts project settings and `.pi/` extensions from cwd (`projectTrusted ??
 * true`), and in CI the cwd is the PR under review; and compaction defaults
 * on, whose silent mid-investigation summarization is the failure mode that
 * ruled out Flue as a harness. Secondarily, the output caps below were held
 * at parity with the Claude Code harness through the re-anchoring A/B (a
 * loop that truncates differently investigates differently), so they stay
 * explicit and unit-tested rather than inherited.
 *
 * Every tool subprocess additionally runs inside an OS sandbox
 * (`@anthropic-ai/sandbox-runtime`, the engine behind Claude Code's own
 * sandbox: bubblewrap on Linux, Seatbelt on macOS) with the checkout
 * read-only and tool-level network denied. dispatch-exec.ts carries the
 * policy and the fail-closed contract.
 */

import type {AgentRequest, AgentResult, AgentRunner} from "./dispatch";
import {createToolExec} from "./dispatch-exec";
import {
    ANTHROPIC_BASE_URL_ENV,
    providerForPin,
    rebaseModels,
    resolveModelId,
    thinkingLevelForModel,
    withGemini38Flash,
} from "./dispatch-models";
import {
    createReviewTools,
    createSubmitTool,
    finalText,
    type TextBlock,
} from "./dispatch-tools-pi";

// The runner decomposes along its real seams — the model-pin routing layer
// (dispatch-models.ts), the sandboxed subprocess seam (dispatch-exec.ts),
// and the tool surface (dispatch-tools-pi.ts) — re-exported here so
// existing importers keep this module as the runner's one surface.
export {
    GEMINI_38_FLASH_MODEL,
    providerForPin,
    resolveModelId,
    withGemini38Flash,
} from "./dispatch-models";
export {
    CAP_JOURNAL_PATH,
    SCRATCH_DIR,
    SCRUBBED_ENV_KEYS,
    createToolExec,
    makeSandboxedExec,
    plainExec,
    shellQuote,
    type ToolExec,
} from "./dispatch-exec";
export {
    capOutput,
    createReviewTools,
    createSubmitTool,
    finalText,
    windowLines,
} from "./dispatch-tools-pi";

/**
 * Bounded client-side retries for transient provider failures (429, 529, the
 * 5xx family), restored deliberately.
 *
 * Nothing upstream supplies one. gh-aw pins `ANTHROPIC_MAX_RETRIES=0` on the
 * engine step, and pi-ai does not read that env var at all: its Anthropic
 * provider calls the SDK with a hardcoded `maxRetries: 0` and delegates to its
 * own `retryProviderRequest` helper, whose default is also 0 unless the caller
 * passes one (pi-ai 0.83.0, `dist/api/anthropic-messages.js`). So without this
 * option a single transient overload on ANY turn ends the sub-agent, and
 * `dispatch.ts` records the thrown error as a failed dimension with no
 * transient retry of its own: one 529 sheds a whole review lens.
 *
 * 2 matches what the deleted SDK harness restored for its sub-agent
 * subprocesses, and what both provider SDKs default to. pi-ai caps a
 * server-requested delay at 60s and fails fast beyond it, so a retry cannot
 * silently park a reviewer past its `timeoutMs`.
 */
const SUB_AGENT_MAX_RETRIES = 2;

/**
 * Times the follow-up seam redirects a sub-agent that ended its turn without
 * an ACCEPTED `submit_result` back to the tool (the port of the SDK
 * harness's Stop hook). Past the cap the free-text fallback proceeds
 * (fail-open: the fallback exists precisely so a tool-shy model cannot void
 * a dimension), and dispatch.ts records the agent's findings as skipped by
 * the prose gate.
 */
const MAX_STOP_BLOCKS = 2;

/**
 * The sub-agent framing. Pi supplies no system prompt of its own, and an
 * empty one left the reviewers unframed — run 30592964392's candidate arm
 * returned prose where the contract was required on 2 of 9 cases. This is
 * deliberately minimal: the role and the output-contract obligation only,
 * because everything else the reviewer needs is in its own prompt (extracted
 * from review.md).
 */
export const SYSTEM_PROMPT = [
    "You are a code-review sub-agent investigating a pull request in the",
    "working directory. Investigate with the read-only tools before you",
    "conclude. Your final message must be your output contract and nothing",
    "else: emit the JSON object your instructions specify, with no prose",
    "before or after it.",
].join(" ");

/**
 * The `REVIEW_DISPATCH_RUNNER` seam is gone: the Claude-Agent-SDK harness
 * was removed after the re-anchoring A/B, and this runner is the only
 * harness. A leftover selection must fail loudly — an operator exporting
 * `sdk` would otherwise silently run Pi while believing they were measuring
 * the SDK loop, which is the worst failure a harness seam can have.
 */
export const rejectStaleRunnerSelection = (env: {
    [key: string]: string | undefined;
}): void => {
    const value = env["REVIEW_DISPATCH_RUNNER"];
    if (value !== undefined && value !== "pi") {
        throw new Error(
            `REVIEW_DISPATCH_RUNNER=${value} selects nothing: the Claude ` +
                `Agent SDK harness was removed after the re-anchoring A/B ` +
                `(PR #305), and the Pi runner is the only dispatch harness. ` +
                `Unset REVIEW_DISPATCH_RUNNER.`,
        );
    }
};

/**
 * Build the production Pi runner. The libraries are imported lazily: unit
 * tests and the task-mode path never require them.
 */
export type PiRunnerOptions = {
    /**
     * Restrict the tool surface to these names. Production and the eval's
     * measured arms both omit it (the eval measures the surface production
     * runs, by construction); the harness probe uses it to reproduce a
     * historical configuration.
     */
    allowedTools?: string[];
    /**
     * Called with the name of each completed tool call. The sandbox smoke job
     * uses it to assert that a live run on the production surface actually
     * reached Bash: `toolCalls` alone cannot tell a Bash call from a Read, and
     * "the production surface works" is precisely a claim about Bash.
     */
    onToolCall?: (toolName: string) => void;
    /**
     * Replace the sub-agent framing ({@link SYSTEM_PROMPT}). Production never
     * sets this; the harness probe (eval/harness-probe.ts) does, because the
     * system prompt is one of the two asymmetries between this runner and the
     * deleted SDK harness and the probe has to vary exactly one thing at a
     * time to tell which one sheds findings.
     */
    systemPrompt?: string;
};

export const createPiRunner = async (
    options: PiRunnerOptions = {},
): Promise<AgentRunner> => {
    const ai = (await import("@earendil-works/pi-ai")) as {
        createModels: () => {
            setProvider: (provider: unknown) => void;
            getModels: (provider?: string) => readonly {id: string}[];
            getModel: (provider: string, id: string) => unknown;
            streamSimple: (
                model: unknown,
                context: unknown,
                options?: unknown,
            ) => unknown;
        };
    };
    // The providers are not on pi-ai's index; they live behind the
    // package's `./providers/*` export subpath.
    const {anthropicProvider} = (await import(
        "@earendil-works/pi-ai/providers/anthropic"
    )) as {
        anthropicProvider: () => {
            id: string;
            getModels: () => readonly {id: string; baseUrl?: string}[];
        };
    };
    const {googleProvider} = (await import(
        "@earendil-works/pi-ai/providers/google"
    )) as {
        googleProvider: () => {
            id: string;
            getModels: () => readonly {id: string}[];
        };
    };
    const core = (await import("@earendil-works/pi-agent-core")) as unknown as {
        runAgentLoop: (
            prompts: unknown[],
            context: Record<string, unknown>,
            config: Record<string, unknown>,
            emit: (event: Record<string, unknown>) => void,
            signal: AbortSignal | undefined,
            streamFn: unknown,
        ) => Promise<unknown[]>;
    };

    const exec = await createToolExec();

    const models = ai.createModels();
    const baseUrl = process.env[ANTHROPIC_BASE_URL_ENV];
    // Register Anthropic, steered when the sandbox provides a base URL;
    // otherwise Pi's bundled provider (direct to api.anthropic.com) stands.
    // dispatch-models.ts's rebaseModels carries the how and the why.
    const anthropic = anthropicProvider();
    models.setProvider(
        baseUrl === undefined || baseUrl === ""
            ? anthropic
            : rebaseModels(anthropic, baseUrl),
    );
    // Register Google (Gemini API) with the catalog extended by the
    // gemini-3.8-flash entry pi-ai 0.83.0 predates. Auth (GEMINI_API_KEY)
    // resolves lazily at call time, so registering the provider costs
    // nothing on runs whose pins never leave Anthropic.
    const google = googleProvider();
    models.setProvider({
        ...google,
        getModels: () => withGemini38Flash(google.getModels()),
    });

    return async (request: AgentRequest): Promise<AgentResult> => {
        const started = Date.now();
        const abort = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            abort.abort(new Error(`timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);

        let captured: Record<string, unknown> | undefined;
        // The last CONTRACT-VALID payload, held even while the prose gate
        // bounces it: a style rejection keeps the session going, and a
        // session can die there (turns, timeout). Every salvage path below
        // uses `captured ?? provisional` — the styled acceptance when one
        // happened, else the best contract-valid submission seen.
        let provisional: Record<string, unknown> | undefined;
        // Calls counted BEFORE the contract check; the follow-up redirect's
        // reason branches on it (a contract- or prose-bounced agent is still
        // mid-correction, not an agent that never delivered).
        let submitAttempts = 0;
        const allowed = options.allowedTools;
        const tools = createReviewTools(request.cwd, exec).filter(
            (tool) => allowed === undefined || allowed.includes(tool.name),
        );
        if (request.validate !== undefined) {
            const validate = request.validate;
            tools.push(
                createSubmitTool(
                    validate,
                    (payload) => {
                        captured = payload;
                    },
                    {
                        ...(request.judgeProse === undefined
                            ? {}
                            : {judgeProse: request.judgeProse}),
                        onProvisional: (payload) => {
                            provisional = payload;
                        },
                        onAttempt: () => {
                            submitAttempts += 1;
                        },
                    },
                ),
            );
        }
        // The follow-up redirect (the SDK harness's Stop hook, ported to
        // Pi's follow-up seam): an agent ending its turn WITHOUT an accepted
        // submission is heading for the free-text fallback, which skips both
        // the in-session contract bounce and the prose gate. Point it back
        // at the tool, at most MAX_STOP_BLOCKS times: past the cap a
        // confused agent gets its genuine fallback rather than a loop, and
        // dispatch.ts records its findings as skipped by the gate.
        let stopBlocks = 0;

        let usd = 0;
        let turns = 0;
        let toolCalls = 0;
        let stopReason: string | undefined;
        let errorMessage: string | undefined;
        let rawStopReason: string | undefined;
        let tokensAtFailure: {input: number; total: number} | undefined;
        const texts: string[] = [];
        try {
            const providerId = providerForPin(request.model);
            const modelId = resolveModelId(
                request.model,
                models.getModels(providerId),
            );
            const model = models.getModel(providerId, modelId);
            if (model === undefined) {
                throw new Error(`Pi could not load the model "${modelId}"`);
            }
            await core.runAgentLoop(
                [
                    {
                        role: "user",
                        content: [{type: "text", text: request.prompt}],
                        timestamp: started,
                    },
                ],
                {
                    systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
                    messages: [],
                    tools,
                },
                {
                    model,
                    // The transcript is already LLM-shaped; nothing to convert.
                    convertToLlm: (messages: unknown[]) => messages,
                    /**
                     * The turn cap. Pi's loop has no turn limit of its own,
                     * so the cap is enforced here; an agent that has already
                     * submitted its result also stops, matching the tool's
                     * "end the turn now".
                     */
                    shouldStopAfterTurn: () =>
                        captured !== undefined || turns >= request.maxTurns,
                    /**
                     * The follow-up redirect: consulted only when the agent
                     * would otherwise stop (no pending tool calls), which is
                     * exactly the SDK Stop hook's trigger. No contract, no
                     * redirect — there is no tool to point at.
                     */
                    getFollowUpMessages: () => {
                        if (
                            request.validate === undefined ||
                            captured !== undefined ||
                            stopBlocks >= MAX_STOP_BLOCKS
                        ) {
                            return [];
                        }
                        stopBlocks += 1;
                        return [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text:
                                            submitAttempts === 0
                                                ? "You have not delivered your result yet. Call the submit_result tool ONCE now, passing the ENTIRE JSON object your output contract specifies as its `result` argument; do not paste the JSON as a message."
                                                : "Your submission was rejected and must be corrected. Rewrite what the rejection message named and call submit_result again with the full corrected result object; do not paste the JSON as a message.",
                                    },
                                ],
                                timestamp: Date.now(),
                            },
                        ];
                    },
                },
                (event: Record<string, unknown>) => {
                    if (event["type"] === "tool_execution_end") {
                        toolCalls += 1;
                        const toolName = event["toolName"];
                        if (typeof toolName === "string") {
                            options.onToolCall?.(toolName);
                        }
                        return;
                    }
                    if (event["type"] !== "turn_end") {
                        return;
                    }
                    turns += 1;
                    const message = event["message"] as
                        | Record<string, unknown>
                        | undefined;
                    const reason = message?.["stopReason"];
                    if (typeof reason === "string") {
                        stopReason = reason;
                    }
                    // Pi carries the failure detail on the assistant message
                    // itself; dropping it is what left `stopReason=error` as
                    // the whole diagnosis for three runs.
                    const errText = message?.["errorMessage"];
                    if (typeof errText === "string" && errText !== "") {
                        errorMessage = errText;
                    }
                    const rawReason = message?.["rawStopReason"];
                    if (typeof rawReason === "string") {
                        rawStopReason = rawReason;
                    }
                    const diagnostics = message?.["diagnostics"];
                    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
                        errorMessage = `${
                            errorMessage ?? ""
                        } diagnostics=${JSON.stringify(diagnostics).slice(
                            0,
                            500,
                        )}`.trim();
                    }
                    const counts = message?.["usage"] as
                        | {input?: number; totalTokens?: number}
                        | undefined;
                    if (counts !== undefined) {
                        tokensAtFailure = {
                            input: Number(counts.input ?? 0),
                            total: Number(counts.totalTokens ?? 0),
                        };
                    }
                    const usage = message?.["usage"] as
                        | {cost?: {total?: number}}
                        | undefined;
                    usd += Number(usage?.cost?.total ?? 0);
                    const content = (message?.["content"] ?? []) as TextBlock[];
                    const text = content
                        .filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join("");
                    if (text !== "") {
                        texts.push(text);
                    }
                },
                abort.signal,
                // Pi hands the stream options down from the loop; the retry
                // budget is added here because nothing upstream sets one (see
                // SUB_AGENT_MAX_RETRIES). A caller-supplied value wins.
                // The reasoning level rides the same way: every pin carries
                // an explicit one (dispatch-models.ts's thinkingLevelForModel
                // carries the two per-provider reasons, both learned the
                // hard way).
                (
                    model_: unknown,
                    context: unknown,
                    streamOptions?: Record<string, unknown>,
                ) =>
                    models.streamSimple(model_, context, {
                        ...streamOptions,
                        maxRetries:
                            streamOptions?.["maxRetries"] ??
                            SUB_AGENT_MAX_RETRIES,
                        reasoning:
                            streamOptions?.["reasoning"] ??
                            thinkingLevelForModel(model_),
                    }),
            );
            // A styled acceptance when one happened, else the best
            // contract-valid submission the prose gate was still bouncing:
            // style enforcement may cost prose quality, never a dimension.
            const salvage = captured ?? provisional;
            if (salvage !== undefined) {
                return {
                    output: JSON.stringify(salvage),
                    usd,
                    turns,
                    toolCalls,
                    stopReason,
                    errorMessage,
                    rawStopReason,
                    tokensAtFailure,
                    refused:
                        stopReason === "refusal" || rawStopReason === "refusal",
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            // Out of turns and finished-with-prose return the same shape: a
            // free-text final, `structured` unset. Left undistinguished,
            // `dispatch.ts` reads the truncated transcript as malformed
            // output and spends its ONE re-dispatch on a corrective note
            // about output shape, which is the wrong diagnosis for an agent
            // that simply ran out of turns. The deleted SDK harness surfaced
            // this loudly (`error_max_turns`); this is the same signal
            // through the `stopReason` channel.
            //
            // The override costs nothing: what it replaces is the last turn's
            // own reason (`tool_use`, `end_turn`), which says only that the
            // turn ended, never that the loop did. The provider's unnormalized
            // reason still rides on `rawStopReason`, and `refused` is still
            // computed from the pre-override values.
            const hitTurnCap = turns >= request.maxTurns;
            return {
                output: finalText(texts),
                usd,
                turns,
                toolCalls,
                stopReason: hitTurnCap ? "max_turns" : stopReason,
                errorMessage,
                rawStopReason,
                tokensAtFailure,
                refused:
                    stopReason === "refusal" || rawStopReason === "refusal",
                wallMs: Date.now() - started,
            };
        } catch (error) {
            // A payload the tool already accepted (or a contract-valid one
            // the prose gate was still bouncing) is complete and validated:
            // salvage it even when the session then dies. The cost
            // accumulated so far is real (Pi reports per-turn usage), so it
            // is kept rather than zeroed, and so are the diagnostics: this is
            // the path where a session died mid-flight, which is exactly when
            // "what killed it" is worth reporting. Dropping them here made a
            // salvaged result look like a clean one.
            const salvage = captured ?? provisional;
            if (salvage !== undefined) {
                return {
                    output: JSON.stringify(salvage),
                    usd,
                    turns,
                    toolCalls,
                    stopReason,
                    errorMessage,
                    rawStopReason,
                    tokensAtFailure,
                    refused:
                        stopReason === "refusal" || rawStopReason === "refusal",
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            if (timedOut) {
                throw new Error(
                    `sub-agent timed out after ${request.timeoutMs}ms`,
                );
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    };
};
