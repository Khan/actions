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
        };
        // The structured-final channel (trial suggestion h): an in-process
        // MCP tool whose handler runs the same contract parse the collection
        // phase will, so a drifted shape bounces back to the model with the
        // exact rejection message while the session is still alive. The
        // captured payload IS the agent's output; the free-text final
        // remains the fallback.
        let captured: Record<string, unknown> | undefined;
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
                            (args) => {
                                const payload = args["result"] as Record<
                                    string,
                                    unknown
                                >;
                                const rejection = validate(payload);
                                if (rejection !== null) {
                                    return Promise.resolve({
                                        content: [
                                            {
                                                type: "text",
                                                text: `Result rejected: ${rejection}. Call submit_result again with the full corrected result object.`,
                                            },
                                        ],
                                        isError: true,
                                    });
                                }
                                captured = payload;
                                return Promise.resolve({
                                    content: [
                                        {
                                            type: "text",
                                            text: "Result recorded. End the turn now; no further output is needed.",
                                        },
                                    ],
                                });
                            },
                        ),
                    ],
                }),
            };
            allowedTools.push("mcp__review__submit_result");
        }
        try {
            const run = sdk.query({prompt: request.prompt, options});
            let output = "";
            let usd = 0;
            let turns = 0;
            for await (const message of run) {
                if (message["type"] !== "result") {
                    continue;
                }
                if (message["subtype"] !== "success") {
                    throw new Error(
                        `sub-agent ended without success: ${String(
                            message["subtype"],
                        )}`,
                    );
                }
                output = String(message["result"] ?? "");
                usd = Number(message["total_cost_usd"] ?? 0);
                turns = Number(message["num_turns"] ?? 0);
            }
            if (captured !== undefined) {
                return {
                    output: JSON.stringify(captured),
                    usd,
                    turns,
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            return {output, usd, turns, wallMs: Date.now() - started};
        } catch (error) {
            // A payload the tool already accepted is complete and validated:
            // salvage it even when the session then dies (a hang after
            // submission, a max-turns overrun). Cost fields are best-effort
            // zero here; the metered proxy still charged the run, but the
            // SDK never delivered its result record.
            if (captured !== undefined) {
                return {
                    output: JSON.stringify(captured),
                    usd: 0,
                    turns: 0,
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            // The SDK reports an abort as a generic "aborted by user";
            // surface the actual cause so the staged error record and the
            // run report say what happened (run 29901690493's two shed
            // finders were 5-minute timeouts, unreadably recorded).
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
