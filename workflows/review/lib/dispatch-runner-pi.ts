/**
 * The Pi-backed AgentRunner for the scripted dispatcher (`dispatch.ts`), a
 * sibling of the Claude-Agent-SDK runner in `dispatch-runner.ts` and
 * contract-identical to it: same `AgentResult` fields, same timeout and
 * abort semantics, same salvage of an already-accepted `submit_result`
 * payload, same tool surface. Selected at the CLI entry by
 * `REVIEW_DISPATCH_RUNNER=pi`; the SDK runner stays the default.
 *
 * Why a second runner at all: Pi's libraries (`@earendil-works/pi-ai` +
 * `@earendil-works/pi-agent-core`) are multi-provider, so once this harness
 * is anchored against the SDK harness on the SAME model pins, moving a role
 * to a non-Anthropic model becomes a pin change rather than a second bespoke
 * agent loop. Both arms then share one loop, which is what makes a
 * cross-provider A/B measure the model instead of measuring the harness.
 *
 * Pi also reports usage with a per-component `cost` breakdown (input,
 * output, cacheRead, cacheWrite), so `AgentResult.usd` stops inheriting the
 * api-proxy default-pricing path's known cache-write under-count.
 *
 * The tools are implemented here rather than taken from Pi's own harness
 * tool factories, for two reasons: the reviewers need exactly
 * Read/Grep/Glob/LS/Bash and must NEVER get edit or write, and the output
 * caps below are the harness-parity variable the re-anchoring A/B is reading
 * (a loop that truncates differently investigates differently). Keeping them
 * explicit and unit-testable here makes that variable visible instead of
 * inherited.
 */

import {execFile} from "node:child_process";

import type {AgentRequest, AgentResult, AgentRunner} from "./dispatch";

/**
 * Per-tool-result output cap, in characters. A reviewer that greps a wide
 * pattern must not spend its whole context on one result; the SDK arm's
 * tools truncate too, so an uncapped tool here would make the Pi arm look
 * better on investigation depth and worse on context exhaustion for reasons
 * that have nothing to do with the model.
 */
const MAX_TOOL_OUTPUT_CHARS = 30_000;

/** Per-Bash-call wall clock. The whole-agent cap is `request.timeoutMs`. */
const BASH_TIMEOUT_MS = 120_000;

/**
 * The provider id Pi registers Anthropic models under, and the env var the
 * sandbox uses to steer Anthropic traffic at the firewall api-proxy. The
 * agent container deliberately runs WITHOUT `ANTHROPIC_API_KEY` (the awf
 * invocation passes `--exclude-env ANTHROPIC_API_KEY`); the proxy sidecar
 * holds the credential and injects it. Pi's bundled Anthropic provider
 * hardcodes `https://api.anthropic.com`, so the provider is re-registered
 * with the steered base URL when one is present. Without this the runner
 * would bypass the proxy, lose credit metering, and fail auth.
 */
const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

/**
 * The sub-agent framing. The SDK arm inherits Claude Code's system prompt;
 * Pi supplies none, and an empty one left the reviewers unframed — run
 * 30592964392's candidate arm returned prose where the contract was required
 * on 2 of 9 cases. This is deliberately minimal: the role and the
 * output-contract obligation only, because everything else the reviewer needs
 * is in its own prompt (extracted from review.md). It is NOT a reproduction of
 * Claude Code's system prompt, so it stays a documented harness difference
 * between the arms rather than a claim of parity.
 */
const SYSTEM_PROMPT = [
    "You are a code-review sub-agent investigating a pull request in the",
    "working directory. Investigate with the read-only tools before you",
    "conclude. Your final message must be your output contract and nothing",
    "else: emit the JSON object your instructions specify, with no prose",
    "before or after it.",
].join(" ");

type TextBlock = {type: "text"; text: string};

type PiToolResult = {
    content: TextBlock[];
    details: Record<string, unknown>;
    isError?: boolean;
};

type PiTool = {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
    ) => Promise<PiToolResult>;
};

/** Truncate a tool result, saying so, so the model knows it was cut. */
export const capOutput = (text: string): string =>
    text.length <= MAX_TOOL_OUTPUT_CHARS
        ? text
        : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[truncated: ${
              text.length - MAX_TOOL_OUTPUT_CHARS
          } more characters]`;

const ok = (text: string): PiToolResult => ({
    content: [{type: "text", text: capOutput(text)}],
    details: {},
});

/**
 * Run one command, resolving with its combined output. A non-zero exit is
 * NOT an error here: `grep` exits 1 on no-match, and the model needs to see
 * "no matches" as an ordinary result rather than a tool failure.
 */
const run = (
    file: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
): Promise<string> =>
    new Promise((resolve) => {
        execFile(
            file,
            args,
            {
                cwd,
                signal,
                timeout: BASH_TIMEOUT_MS,
                maxBuffer: 64 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                const out = `${stdout}${stderr}`;
                // A plain non-zero exit carries a numeric `code` and is an
                // ordinary result: `grep` exits 1 on no-match, and reporting
                // that as a failure would tell the model its toolbox is
                // broken when the honest answer is "nothing matched". A
                // kill (timeout, signal) or a spawn error has no exit code
                // and IS a failure the model needs to see.
                const failed = error !== null && typeof error.code !== "number";
                if (failed) {
                    resolve(`command failed: ${error.message}`);
                    return;
                }
                resolve(out.trim() === "" ? "(no output)" : out);
            },
        );
    });

const schema = (
    properties: Record<string, unknown>,
    required: string[],
): unknown => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
});

const str = (description: string): unknown => ({type: "string", description});

/**
 * The reviewer tool surface: read-only investigation plus Bash (the
 * investigation-cap CLI the sub-agent prompts invoke runs through it). No
 * edit, no write — a reviewer that can mutate the checkout it is reviewing
 * is a correctness hazard, and the SDK arm does not grant them either.
 */
export const createReviewTools = (cwd: string): PiTool[] => [
    {
        name: "Read",
        label: "Read",
        description:
            "Read a file from the repository. Returns the file with 1-indexed line numbers.",
        parameters: schema(
            {path: str("Path to the file, relative to the repository root.")},
            ["path"],
        ),
        execute: async (_id, params, signal) => {
            const path = String(params["path"] ?? "");
            return ok(await run("cat", ["-n", "--", path], cwd, signal));
        },
    },
    {
        name: "Grep",
        label: "Grep",
        description:
            "Search file contents with a regular expression. Returns matching lines prefixed with file:line.",
        parameters: schema(
            {
                pattern: str("Extended regular expression to search for."),
                path: str("Optional directory or file to scope the search to."),
            },
            ["pattern"],
        ),
        execute: async (_id, params, signal) => {
            const pattern = String(params["pattern"] ?? "");
            const path = String(params["path"] ?? ".");
            return ok(
                await run(
                    "grep",
                    ["-rIn", "--exclude-dir=.git", "-E", "--", pattern, path],
                    cwd,
                    signal,
                ),
            );
        },
    },
    {
        name: "Glob",
        label: "Glob",
        description: "Find files whose path matches a glob pattern.",
        parameters: schema(
            {pattern: str("Glob pattern, e.g. 'src/**/*.ts'.")},
            ["pattern"],
        ),
        execute: async (_id, params, signal) => {
            const pattern = String(params["pattern"] ?? "");
            return ok(
                await run(
                    "find",
                    [".", "-not", "-path", "./.git/*", "-path", `./${pattern}`],
                    cwd,
                    signal,
                ),
            );
        },
    },
    {
        name: "LS",
        label: "LS",
        description: "List the entries of a directory.",
        parameters: schema(
            {path: str("Directory to list, relative to the repository root.")},
            ["path"],
        ),
        execute: async (_id, params, signal) => {
            const path = String(params["path"] ?? ".");
            return ok(await run("ls", ["-la", "--", path], cwd, signal));
        },
    },
    {
        name: "Bash",
        label: "Bash",
        description:
            "Run a shell command in the repository. Use for the investigation-cap CLI and other read-only checks.",
        parameters: schema({command: str("The shell command to run.")}, [
            "command",
        ]),
        execute: async (_id, params, signal) => {
            const command = String(params["command"] ?? "");
            return ok(await run("bash", ["-lc", command], cwd, signal));
        },
    },
];

/**
 * The structured-final tool, the same contract as the SDK runner's in-process
 * MCP tool: the payload is validated by `request.validate` BEFORE it is
 * accepted, and a drifted shape bounces back to the model with the exact
 * rejection message while the session is still alive.
 */
export const createSubmitTool = (
    validate: (payload: Record<string, unknown>) => string | null,
    onAccept: (payload: Record<string, unknown>) => void,
): PiTool => ({
    name: "submit_result",
    label: "submit_result",
    description:
        "Deliver your final structured result. Pass the entire output-contract JSON object as `result`.",
    parameters: schema(
        {
            result: {
                type: "object",
                description: "The full output-contract object.",
            },
        },
        ["result"],
    ),
    execute: (_id, params) => {
        const payload = (params["result"] ?? {}) as Record<string, unknown>;
        const rejection = validate(payload);
        if (rejection !== null) {
            return Promise.resolve({
                content: [
                    {
                        type: "text" as const,
                        text: `Result rejected: ${rejection}. Call submit_result again with the full corrected result object.`,
                    },
                ],
                details: {},
                isError: true,
            });
        }
        onAccept(payload);
        return Promise.resolve({
            content: [
                {
                    type: "text" as const,
                    text: "Result recorded. End the turn now; no further output is needed.",
                },
            ],
            details: {},
        });
    },
});

/**
 * The free-text final, for a request with no output contract (the eval path:
 * `LiveAgentRequest` carries no `validate`, so `submit_result` is never
 * registered and both arms fall back to free text).
 *
 * The SDK arm's free-text final is Claude Code's assembled result message. Pi
 * emits one assistant message per turn, so the equivalent is not simply the
 * last one: a reviewer that emitted its JSON and then added a closing sentence
 * would lose the JSON, which is exactly how run 30592964392's candidate arm
 * failed. Prefer the last turn that actually carries a JSON object, and fall
 * back to the whole transcript's assistant text so a downstream extractor can
 * still find it.
 */
export const finalText = (texts: string[]): string => {
    for (let i = texts.length - 1; i >= 0; i -= 1) {
        if (texts[i].includes("{") && texts[i].includes("}")) {
            return texts[i];
        }
    }
    return texts.join("\n");
};

/**
 * Resolve a review.md model pin against Pi's Anthropic catalog. The pins are
 * tier aliases (`claude-opus-4-8`); Pi's catalog may carry dated ids, so an
 * exact miss falls back to a prefix match. An unresolvable pin throws with
 * the candidates listed rather than silently running a different model than
 * the arm claims to be testing.
 */
export const resolveModelId = (
    pin: string,
    available: readonly {id: string}[],
): string => {
    const exact = available.find((model) => model.id === pin);
    if (exact !== undefined) {
        return exact.id;
    }
    const prefixed = available.filter((model) => model.id.startsWith(pin));
    if (prefixed.length > 0) {
        // Longest id wins: a dated release id is more specific than a bare alias.
        return prefixed.sort((a, b) => b.id.length - a.id.length)[0].id;
    }
    throw new Error(
        `model pin "${pin}" is not in Pi's Anthropic catalog (candidates: ${available
            .map((model) => model.id)
            .join(", ")})`,
    );
};

/**
 * Build the production Pi runner. The libraries are imported lazily, matching
 * the SDK runner: unit tests and the task-mode path never require them.
 */
export type PiRunnerOptions = {
    /**
     * Restrict the tool surface to these names. Used by the eval harness,
     * whose SDK arm allows only Read/Grep/Glob; a Pi arm with a wider surface
     * would out-investigate its own baseline and the A/B would read that as a
     * harness win. Omitted in production, where the full surface (including
     * Bash, which the investigation-cap CLI needs) is granted.
     */
    allowedTools?: string[];
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
        createProvider: (input: Record<string, unknown>) => unknown;
    };
    // `anthropicProvider` is not on pi-ai's index; it lives behind the
    // package's `./providers/*` export subpath.
    const {anthropicProvider} = (await import(
        "@earendil-works/pi-ai/providers/anthropic"
    )) as {anthropicProvider: () => Record<string, unknown>};
    const core = (await import("@earendil-works/pi-agent-core")) as {
        runAgentLoop: (
            prompts: unknown[],
            context: Record<string, unknown>,
            config: Record<string, unknown>,
            emit: (event: Record<string, unknown>) => void,
            signal: AbortSignal | undefined,
            streamFn: unknown,
        ) => Promise<unknown[]>;
    };

    const models = ai.createModels();
    const baseUrl = process.env[ANTHROPIC_BASE_URL_ENV];
    // Re-register Anthropic on the steered base URL when the sandbox provides
    // one; otherwise Pi's bundled provider (direct to api.anthropic.com) stands.
    models.setProvider(
        baseUrl === undefined || baseUrl === ""
            ? anthropicProvider()
            : ai.createProvider({...anthropicProvider(), baseUrl}),
    );

    return async (request: AgentRequest): Promise<AgentResult> => {
        const started = Date.now();
        const abort = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            abort.abort(new Error(`timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);

        let captured: Record<string, unknown> | undefined;
        const allowed = options.allowedTools;
        const tools = createReviewTools(request.cwd).filter(
            (tool) => allowed === undefined || allowed.includes(tool.name),
        );
        if (request.validate !== undefined) {
            const validate = request.validate;
            tools.push(
                createSubmitTool(validate, (payload) => {
                    captured = payload;
                }),
            );
        }

        let usd = 0;
        let turns = 0;
        let toolCalls = 0;
        let stopReason: string | undefined;
        let errorMessage: string | undefined;
        let rawStopReason: string | undefined;
        let tokensAtFailure: {input: number; total: number} | undefined;
        const texts: string[] = [];
        try {
            const modelId = resolveModelId(
                request.model,
                models.getModels(ANTHROPIC_PROVIDER_ID),
            );
            const model = models.getModel(ANTHROPIC_PROVIDER_ID, modelId);
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
                {systemPrompt: SYSTEM_PROMPT, messages: [], tools},
                {
                    model,
                    // The transcript is already LLM-shaped; nothing to convert.
                    convertToLlm: (messages: unknown[]) => messages,
                    /**
                     * The turn cap, `maxTurns` in the SDK arm. Pi's loop has
                     * no turn limit of its own, so the cap is enforced here;
                     * an agent that has already submitted its result also
                     * stops, matching the SDK arm's "end the turn now".
                     */
                    shouldStopAfterTurn: () =>
                        captured !== undefined || turns >= request.maxTurns,
                },
                (event: Record<string, unknown>) => {
                    if (event["type"] === "tool_execution_end") {
                        toolCalls += 1;
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
                (model_: unknown, context: unknown, options?: unknown) =>
                    models.streamSimple(model_, context, options),
            );
            if (captured !== undefined) {
                return {
                    output: JSON.stringify(captured),
                    usd,
                    turns,
                    toolCalls,
                    stopReason,
                    errorMessage,
                    rawStopReason,
                    tokensAtFailure,
                    refused: rawStopReason === "refusal",
                    wallMs: Date.now() - started,
                    structured: true,
                };
            }
            return {
                output: finalText(texts),
                usd,
                turns,
                toolCalls,
                stopReason,
                errorMessage,
                rawStopReason,
                tokensAtFailure,
                refused: rawStopReason === "refusal",
                wallMs: Date.now() - started,
            };
        } catch (error) {
            // A payload the tool already accepted is complete and validated:
            // salvage it even when the session then dies. Same reasoning as the
            // SDK arm, and the cost accumulated so far is real here (Pi reports
            // per-turn usage), so it is kept rather than zeroed.
            if (captured !== undefined) {
                return {
                    output: JSON.stringify(captured),
                    usd,
                    turns,
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
