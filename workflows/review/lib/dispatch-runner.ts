/**
 * The SDK-backed production AgentRunner for the scripted dispatcher
 * (`dispatch.ts`), split out by concern (and dispatch.ts's max-lines
 * budget). Everything here is the model seam: the Claude Agent SDK query,
 * the timeout backstop, and the structured-final `submit_result` tool
 * (trial suggestion h). The dispatch run itself (roster, parsing, gating,
 * artifact writes) stays pure code in `dispatch.ts` and never imports this
 * module; only the CLI entry does, lazily, so unit tests and the task-mode
 * path never require the SDK.
 */

import type {AgentRequest, AgentResult, AgentRunner} from "./dispatch";
import {usageOfResultMessage, type ModelTokens} from "./pricing";

/**
 * Anthropic SDK internal retries for a sub-agent subprocess (the SDK's own
 * default). Set explicitly because the engine step's environment now disables
 * them; see the `env` note in the options below.
 */
const SUBAGENT_MAX_RETRIES = "2";

/**
 * Times the Stop hook redirects a sub-agent that ended its turn without
 * calling `submit_result` back to the tool. Past the cap the free-text
 * fallback proceeds (fail-open: the fallback exists precisely so a
 * tool-shy model cannot void a dimension).
 */
const MAX_STOP_BLOCKS = 2;

/**
 * Build the production runner. The SDK and zod are imported lazily here
 * (both installed by the scripted-mode `npm ci` pre-agent step); zod is the
 * SDK's own schema language for in-process MCP tools (a peer dependency).
 */
export const createSdkRunner = async (): Promise<AgentRunner> => {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
        query: (input: {
            prompt: string;
            options: Record<string, unknown>;
        }) => AsyncIterable<Record<string, unknown>>;
        createSdkMcpServer: (options: {
            name: string;
            tools: unknown[];
        }) => unknown;
        tool: (
            name: string,
            description: string,
            inputSchema: Record<string, unknown>,
            handler: (
                args: Record<string, unknown>,
                extra: unknown,
            ) => Promise<unknown>,
        ) => unknown;
    };
    const {z} = await import("zod");

    return async (request: AgentRequest): Promise<AgentResult> => {
        const started = Date.now();
        const abort = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            abort.abort(new Error(`timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);
        // Bash is allowed for production parity: the investigation-cap CLI
        // the sub-agent prompts invoke runs through it, inside the same
        // sandbox.
        const allowedTools = ["Read", "Grep", "Glob", "LS", "Bash"];
        const options: Record<string, unknown> = {
            cwd: request.cwd,
            model: request.model,
            maxTurns: request.maxTurns,
            allowedTools,
            permissionMode: "bypassPermissions",
            abortController: abort,
            // Pinned, not inherited. The SDK already defaults opus-4.6+ to
            // adaptive thinking at effort high, so this changes nothing
            // today; it exists because the default was invisible enough that
            // the Pi harness port (PR #406) disabled thinking entirely
            // without anyone noticing, including through a full A/B. Every
            // reviewer runs at high until per-role levels earn their own
            // measurement.
            effort: "high",
            // gh-aw >= v0.83 sets ANTHROPIC_MAX_RETRIES=0 on the engine step so
            // that a terminal error (403 ai_credits_limit_exceeded) reaches its
            // harness immediately, because that harness owns the retry/backoff
            // loop for 429/529 — for the ORCHESTRATOR process only. These
            // sub-agents are spawned by the dispatcher inside that process and
            // have no such wrapper, so inheriting 0 turns any transient
            // overload into a shed lens. Restore the SDK default for the
            // sub-agent subprocesses alone. `env` REPLACES the subprocess
            // environment rather than merging, so process.env is spread first:
            // the CLI still needs PATH, HOME, and the proxy's steering vars.
            env: {...process.env, ANTHROPIC_MAX_RETRIES: SUBAGENT_MAX_RETRIES},
        };
        // The structured-final channel (trial suggestion h): an in-process
        // MCP tool whose handler runs the same contract parse the collection
        // phase will, so a drifted shape bounces back to the model with the
        // exact rejection message while the session is still alive. The
        // captured payload IS the agent's output; the free-text final
        // remains the fallback.
        let captured: Record<string, unknown> | undefined;
        // The last CONTRACT-VALID payload, held even while the prose gate
        // bounces it: a style rejection re-opens the session, and a session
        // can die there (turns, timeout). Style enforcement may cost prose
        // quality, never a dimension, so every fallback path below salvages
        // `captured ?? provisional` — the styled acceptance when one
        // happened, else the best contract-valid submission seen.
        let provisional: Record<string, unknown> | undefined;
        // How many times the agent called submit_result at all, counted
        // BEFORE the contract check: the Stop-hook reason branches on this,
        // and a contract-bounced agent (validate non-null, so neither
        // `captured` nor `provisional` is set) is still mid-correction, not
        // an agent that never delivered.
        let submitAttempts = 0;
        const validate = request.validate;
        if (validate !== undefined) {
            options.mcpServers = {
                review: sdk.createSdkMcpServer({
                    name: "review",
                    tools: [
                        sdk.tool(
                            "submit_result",
                            "Deliver your final structured result. Pass the entire output-contract JSON object as `result`.",
                            {result: z.record(z.string(), z.unknown())},
                            async (args) => {
                                submitAttempts += 1;
                                const payload = args["result"] as Record<
                                    string,
                                    unknown
                                >;
                                const rejection = validate(payload);
                                if (rejection !== null) {
                                    return {
                                        content: [
                                            {
                                                type: "text",
                                                text: `Result rejected: ${rejection}. Call submit_result again with the full corrected result object.`,
                                            },
                                        ],
                                        isError: true,
                                    };
                                }
                                provisional = payload;
                                // The prose gate (judge-prose.ts), AFTER the
                                // contract check: the judge only ever sees
                                // payloads the collection phase could accept,
                                // and its rejection bounces to the AUTHOR the
                                // same way a contract rejection does (the
                                // plain-prose loop: the pinned judge model
                                // scores, the author rewrites in-session
                                // with its repo context intact). The gate
                                // caps its own bounces and fails open, and
                                // `provisional` above keeps the pre-style
                                // payload salvageable, so this await can
                                // slow a submission or cost prose quality,
                                // never lose one.
                                if (request.judgeProse !== undefined) {
                                    const styleRejection =
                                        await request.judgeProse(payload);
                                    if (styleRejection !== null) {
                                        return {
                                            content: [
                                                {
                                                    type: "text",
                                                    text: styleRejection,
                                                },
                                            ],
                                            isError: true,
                                        };
                                    }
                                }
                                captured = payload;
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: "Result recorded. End the turn now; no further output is needed.",
                                        },
                                    ],
                                };
                            },
                        ),
                    ],
                }),
            };
            allowedTools.push("mcp__review__submit_result");
            // The Stop hook: an agent ending its turn WITHOUT an accepted
            // submission is heading for the free-text fallback, which skips
            // both the in-session contract bounce and the prose gate. Block
            // the stop (the model sees `reason` and continues) and point it
            // back at the tool, at most twice: past the cap a confused agent
            // gets its genuine fallback rather than a loop, and dispatch.ts
            // records its findings as skipped by the gate. `captured` empty
            // does NOT mean "never called": a submission the contract or
            // prose gate bounced leaves it empty too, so the reason branches
            // on whether submit_result was ever called (either bounce kind
            // leaves the agent mid-correction, not undelivered).
            let stopBlocks = 0;
            options.hooks = {
                Stop: [
                    {
                        hooks: [
                            async () => {
                                if (
                                    captured === undefined &&
                                    stopBlocks < MAX_STOP_BLOCKS
                                ) {
                                    stopBlocks += 1;
                                    return {
                                        decision: "block" as const,
                                        reason:
                                            submitAttempts === 0
                                                ? "You have not delivered your result yet. Call the submit_result tool ONCE now, passing the ENTIRE JSON object your output contract specifies as its `result` argument; do not paste the JSON as a message."
                                                : "Your submission was rejected and must be corrected. Rewrite what the rejection message named and call submit_result again with the full corrected result object; do not paste the JSON as a message.",
                                    };
                                }
                                return {};
                            },
                        ],
                    },
                ],
            };
        }
        // The last assistant text seen. The Stop hook pushes a free-text
        // agent to keep going, so it can spend its final turns being
        // redirected and die on a non-success subtype (error_max_turns) with
        // a usable final already written; the catch below salvages this text
        // so the redirect can cost turns, never the output.
        let lastText: string | undefined;
        // Metering from a NON-success result record (error_max_turns et al.
        // still carry total_cost_usd/num_turns): captured before the throw
        // so the salvage paths report what the run really cost instead of a
        // systematic zero (the Stop hook makes non-success endings common
        // for free-text agents, so the zeros were not a rare best-effort
        // case but a standing undercount in dispatch's perAgent entries and
        // the totalUsd summed over them).
        let endedUsd = 0;
        let endedTurns = 0;
        let endedUsage: ModelTokens[] | undefined;
        let ended = false;
        try {
            const run = sdk.query({prompt: request.prompt, options});
            let output = "";
            let usd = 0;
            let usage: ModelTokens[] | undefined;
            let turns = 0;
            let stopReason: string | undefined;
            let toolCalls = 0;
            for await (const message of run) {
                // The refusal detector. Anthropic reports a usage-policy block
                // as stop_reason "refusal" on the assistant message, and the
                // agent returns no final text; the result record carries
                // neither. Without this the production refusal fallback in
                // dispatch.ts can never fire, because nothing sets `refused`.
                if (message["type"] === "assistant") {
                    const inner = (
                        message as unknown as {
                            message?: {
                                content?: {type?: string}[];
                                stop_reason?: string | null;
                            };
                        }
                    ).message;
                    if (typeof inner?.stop_reason === "string") {
                        stopReason = inner.stop_reason;
                    }
                    for (const block of inner?.content ?? []) {
                        if (block.type === "tool_use") {
                            toolCalls += 1;
                        }
                        if (block.type === "text") {
                            const text = (block as {text?: unknown}).text;
                            if (typeof text === "string" && text.length > 0) {
                                lastText = text;
                            }
                        }
                    }
                }
                if (message["type"] !== "result") {
                    continue;
                }
                if (message["subtype"] !== "success") {
                    endedUsd = Number(message["total_cost_usd"] ?? 0);
                    endedTurns = Number(message["num_turns"] ?? 0);
                    endedUsage = usageOfResultMessage(message);
                    ended = true;
                    throw new Error(
                        `sub-agent ended without success: ${String(
                            message["subtype"],
                        )}`,
                    );
                }
                output = String(message["result"] ?? "");
                usd = Number(message["total_cost_usd"] ?? 0);
                turns = Number(message["num_turns"] ?? 0);
                usage = usageOfResultMessage(message);
            }
            const salvage = captured ?? provisional;
            if (salvage !== undefined) {
                return {
                    output: JSON.stringify(salvage),
                    usd,
                    ...(usage === undefined ? {} : {usage}),
                    turns,
                    toolCalls,
                    stopReason,
                    refused: stopReason === "refusal",
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            return {
                output,
                usd,
                ...(usage === undefined ? {} : {usage}),
                turns,
                toolCalls,
                stopReason,
                refused: stopReason === "refusal",
                wallMs: Date.now() - started,
            };
        } catch (error) {
            // A payload the tool accepted (or a contract-valid one the prose
            // gate was still bouncing) is complete: salvage it even when the
            // session then dies (a hang after submission, a max-turns
            // overrun). Cost fields come from the non-success result record
            // when the SDK delivered one; they are best-effort zero only
            // when the stream died with no record at all.
            const salvage = captured ?? provisional;
            if (salvage !== undefined) {
                return {
                    output: JSON.stringify(salvage),
                    usd: endedUsd,
                    ...(endedUsage === undefined ? {} : {usage: endedUsage}),
                    turns: endedTurns,
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            // The SDK reports an abort as a generic "aborted by user";
            // surface the actual cause BEFORE the lastText salvage: a
            // timeout is a real failure whose text is mid-investigation
            // narration, and returning it as the output re-dispatches the
            // agent as "malformed" and pays for the run twice (the staged
            // error record exists because run 29901690493's two shed
            // finders were 5-minute timeouts, unreadably recorded).
            if (timedOut) {
                throw new Error(
                    `sub-agent timed out after ${request.timeoutMs}ms`,
                );
            }
            // No structured payload, but the agent did write a final AND
            // the session ended with a delivered result record (the
            // max-turns shape the Stop hook makes common): the free-text
            // fallback path. Gated on `ended`, not on any error: a hard
            // failure mid-stream has no result record and its lastText is
            // mid-investigation narration, which would fail the contract
            // parse and burn the malformed-output re-dispatch, exactly like
            // the timeout case above.
            if (ended && lastText !== undefined) {
                return {
                    output: lastText,
                    usd: endedUsd,
                    ...(endedUsage === undefined ? {} : {usage: endedUsage}),
                    turns: endedTurns,
                    wallMs: Date.now() - started,
                };
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    };
};
