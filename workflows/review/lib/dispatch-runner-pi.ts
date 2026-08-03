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
 * loop, and a cross-provider A/B measures the model instead of the harness.
 * Pi also reports usage with a per-component `cost` breakdown (input,
 * output, cacheRead, cacheWrite), so `AgentResult.usd` does not inherit the
 * api-proxy default-pricing path's known cache-write under-count.
 *
 * The tools are implemented here rather than taken from Pi's own harness
 * tool factories, for two reasons: the reviewers need exactly
 * Read/Grep/Glob/LS/Bash and must NEVER get edit or write, and the output
 * caps below were held at parity with the Claude Code harness through the
 * re-anchoring A/B (a loop that truncates differently investigates
 * differently), so they stay explicit and unit-tested rather than inherited.
 *
 * Every tool subprocess additionally runs inside an OS sandbox
 * (`@anthropic-ai/sandbox-runtime`, the engine behind Claude Code's own
 * sandbox: bubblewrap on Linux, Seatbelt on macOS) with the checkout
 * read-only and tool-level network denied. See {@link SANDBOX_CONFIG} for
 * the policy and the fail-closed contract.
 */

import {execFile} from "node:child_process";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";

import type {AgentRequest, AgentResult, AgentRunner} from "./dispatch";

/**
 * Per-tool-result output cap, in characters. A reviewer that greps a wide
 * pattern must not spend its whole context on one result. This value was a
 * measured variable of the re-anchoring A/B (it matches what the Claude Code
 * harness allowed its tools), so treat it as calibrated, not free: changing
 * it changes how the loop investigates.
 */
const MAX_TOOL_OUTPUT_CHARS = 30_000;

/** Per-tool-call wall clock. The whole-agent cap is `request.timeoutMs`. */
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
 * The OS sandbox around every tool subprocess. The runner process itself
 * stays OUTSIDE it (the loop must reach the model provider); only the
 * commands the model asks for are wrapped.
 *
 * The policy, line by line:
 *
 *  - Network deny-all. The tools investigate a checkout; none of them needs
 *    the network, and model traffic leaves from the runner process, not from
 *    a tool. In production this stacks INSIDE the awf firewall rather than
 *    replacing it; in the eval (a bare runner VM with the real API key in
 *    the environment) it is the only network boundary the tools have.
 *
 *  - Checkout read-only. "Reviewers never get edit or write" used to be a
 *    tool-surface promise that Bash could bypass (`echo > file`); read-only
 *    makes it a boundary. A prompt-injected reviewer cannot poison the
 *    checkout its sibling reviewers are reading, nor the staged inputs and
 *    outputs downstream phases trust (`routing.json`, `out/`).
 *
 *  - The investigation-cap journal is the ONE writable path in the review
 *    staging dir: the cap CLI appends one line per authorised call
 *    (investigation-cap.ts), and refusing that write would break the cap.
 *    `routing.json` (the caps) stays read-only.
 *
 *  - A scratch directory for the model's own use; nothing downstream reads
 *    from it.
 *
 * Fail-closed: when the sandbox cannot initialize (bubblewrap missing, user
 * namespaces blocked in a nested container), {@link createPiRunner} THROWS
 * rather than silently running unsandboxed. `REVIEW_SANDBOX=off` is the
 * explicit, logged escape hatch; in production the awf firewall still stands
 * around an unsandboxed runner, so "off" degrades to exactly the pre-srt
 * posture rather than to nothing.
 */
const REVIEW_SANDBOX_ENV = "REVIEW_SANDBOX";

/** The one writable file in the staging dir; see investigation-cap.ts. */
const CAP_JOURNAL_PATH = "/tmp/gh-aw/review/investigation-journal.log";

/** Model-usable scratch space; nothing downstream reads from it. */
const SCRATCH_DIR = "/tmp/review-agent-scratch";

const SANDBOX_CONFIG = {
    network: {allowedDomains: [], deniedDomains: ["*"]},
    filesystem: {
        denyRead: ["~/.ssh"],
        allowWrite: [CAP_JOURNAL_PATH, SCRATCH_DIR],
        denyWrite: [],
    },
};

/**
 * The sub-agent framing. Pi supplies no system prompt of its own, and an
 * empty one left the reviewers unframed — run 30592964392's candidate arm
 * returned prose where the contract was required on 2 of 9 cases. This is
 * deliberately minimal: the role and the output-contract obligation only,
 * because everything else the reviewer needs is in its own prompt (extracted
 * from review.md).
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

/**
 * One tool subprocess: argv in, combined output out. This is the seam the OS
 * sandbox wraps — every tool below runs its command through an injected
 * executor, so the sandboxed and unsandboxed paths differ ONLY in how the
 * argv is spawned, never in what the tools do.
 */
export type ToolExec = (
    argv: string[],
    cwd: string,
    signal?: AbortSignal,
) => Promise<string>;

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
 * Spawn one argv, resolving with its combined output. A non-zero exit is
 * NOT an error here: `grep` exits 1 on no-match, and the model needs to see
 * "no matches" as an ordinary result rather than a tool failure.
 */
const spawn = (
    argv: string[],
    cwd: string,
    env: Record<string, string | undefined> | undefined,
    signal?: AbortSignal,
): Promise<string> =>
    new Promise((resolve) => {
        execFile(
            argv[0],
            argv.slice(1),
            {
                cwd,
                signal,
                ...(env !== undefined ? {env} : {}),
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

/** The unsandboxed executor: exactly the pre-srt behavior. */
export const plainExec: ToolExec = (argv, cwd, signal) =>
    spawn(argv, cwd, undefined, signal);

/**
 * POSIX single-quote each part so an argv survives the shell round-trip
 * through the sandbox wrapper (srt takes a command STRING and returns the
 * bwrap/seatbelt argv to spawn).
 */
export const shellQuote = (argv: string[]): string =>
    argv.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");

/** What this runner needs from srt's `SandboxManager`. */
type SandboxWrapper = {
    initialize: (config: unknown) => Promise<void>;
    wrapWithSandboxArgv: (
        command: string,
        binShell?: string,
        customConfig?: unknown,
        abortSignal?: AbortSignal,
        cwd?: string,
    ) => Promise<{
        argv: string[];
        env?: Record<string, string | undefined>;
    }>;
};

/**
 * The sandboxed executor: quote the argv back into a command string, have
 * srt wrap it in the platform sandbox, and spawn the wrapped argv with the
 * environment srt asks for.
 */
export const makeSandboxedExec =
    (sandbox: SandboxWrapper): ToolExec =>
    async (argv, cwd, signal) => {
        const wrapped = await sandbox.wrapWithSandboxArgv(
            shellQuote(argv),
            undefined,
            undefined,
            signal,
            cwd,
        );
        return spawn(wrapped.argv, cwd, wrapped.env, signal);
    };

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
 * edit, no write — and with the sandboxed executor that is a mount-level
 * boundary on Bash too, not just a tool-surface promise.
 */
export const createReviewTools = (
    cwd: string,
    exec: ToolExec = plainExec,
): PiTool[] => [
    {
        name: "Read",
        label: "Read",
        // KNOWN LIMIT: no offset/limit windowing; the whole file is read and
        // truncated at MAX_TOOL_OUTPUT_CHARS, so a sub-agent reading a large
        // file gets a silently narrower view than a windowing Read would
        // give. Relevant when a reviewer "misses" something in a big file.
        description:
            "Read a file from the repository. Returns the file with 1-indexed line numbers.",
        parameters: schema(
            {path: str("Path to the file, relative to the repository root.")},
            ["path"],
        ),
        execute: async (_id, params, signal) => {
            const path = String(params["path"] ?? "");
            return ok(await exec(["cat", "-n", "--", path], cwd, signal));
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
                await exec(
                    [
                        "grep",
                        "-rIn",
                        "--exclude-dir=.git",
                        "-E",
                        "--",
                        pattern,
                        path,
                    ],
                    cwd,
                    signal,
                ),
            );
        },
    },
    {
        name: "Glob",
        label: "Glob",
        // KNOWN LIMIT: `find -path` matches `*` ACROSS `/`, so `src/*.ts`
        // also matches nested files that a real glob library would exclude,
        // and `**` differs too. Documented rather than normalized because it
        // widens rather than narrows the view.
        description: "Find files whose path matches a glob pattern.",
        parameters: schema(
            {pattern: str("Glob pattern, e.g. 'src/**/*.ts'.")},
            ["pattern"],
        ),
        execute: async (_id, params, signal) => {
            const pattern = String(params["pattern"] ?? "");
            return ok(
                await exec(
                    [
                        "find",
                        ".",
                        "-not",
                        "-path",
                        "./.git/*",
                        "-path",
                        `./${pattern}`,
                    ],
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
            return ok(await exec(["ls", "-la", "--", path], cwd, signal));
        },
    },
    {
        name: "Bash",
        label: "Bash",
        description:
            "Run a shell command in the repository. Use for the investigation-cap CLI and other read-only checks. Commands run inside an OS sandbox: the repository is read-only and there is no network access.",
        parameters: schema({command: str("The shell command to run.")}, [
            "command",
        ]),
        execute: async (_id, params, signal) => {
            const command = String(params["command"] ?? "");
            return ok(await exec(["bash", "-lc", command], cwd, signal));
        },
    },
];

/**
 * The structured-final tool: the payload is validated by `request.validate`
 * BEFORE it is accepted, and a drifted shape bounces back to the model with
 * the exact rejection message while the session is still alive.
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
 * registered and the agent falls back to free text).
 *
 * Pi emits one assistant message per turn, so the final is not simply the
 * last one: a reviewer that emitted its JSON and then added a closing
 * sentence would lose the JSON, which is exactly how run 30592964392's
 * candidate arm failed. Prefer the last turn that actually carries a JSON
 * object, and fall back to the whole transcript's assistant text so a
 * downstream extractor can still find it.
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
 * exact miss falls back to the pin's own dated releases — `pin-YYYYMMDD`
 * exactly, latest date first. A bare `startsWith` fallback would let a
 * family pin jump tiers (`claude-sonnet-4` longest-matching
 * `claude-sonnet-4-5-<date>`), and the contract here is "never silently run
 * a different model than the pin claims": an unresolvable pin throws with
 * the candidates listed.
 */
export const resolveModelId = (
    pin: string,
    available: readonly {id: string}[],
): string => {
    const exact = available.find((model) => model.id === pin);
    if (exact !== undefined) {
        return exact.id;
    }
    const dated = available.filter(
        (model) =>
            model.id.startsWith(pin) &&
            /^-\d{8}$/.test(model.id.slice(pin.length)),
    );
    if (dated.length > 0) {
        // Dated suffixes are equal-length, so lexicographic IS chronological.
        return dated.sort((a, b) => b.id.localeCompare(a.id))[0].id;
    }
    throw new Error(
        `model pin "${pin}" is not in Pi's Anthropic catalog (candidates: ${available
            .map((model) => model.id)
            .join(", ")})`,
    );
};

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
     * Restrict the tool surface to these names. Used by the eval harness,
     * which allows only Read/Grep/Glob (the corpus was measured on that
     * three-tool surface). Omitted in production, where the full surface
     * (including Bash, which the investigation-cap CLI needs) is granted.
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

    // The OS sandbox around the tool subprocesses (see SANDBOX_CONFIG).
    // Fail-closed: an initialization failure throws rather than degrading to
    // unsandboxed tools; REVIEW_SANDBOX=off is the explicit escape hatch.
    let exec: ToolExec;
    if (process.env[REVIEW_SANDBOX_ENV] === "off") {
        // eslint-disable-next-line no-console
        console.error(
            "review dispatch: tool sandbox OFF (REVIEW_SANDBOX=off); tool subprocesses run unwrapped.",
        );
        exec = plainExec;
    } else {
        const srt = (await import("@anthropic-ai/sandbox-runtime")) as {
            SandboxManager: SandboxWrapper;
        };
        try {
            // Pre-create the writable bind targets so the sandbox can mount
            // them: the cap journal may not exist yet on a fresh run, and
            // its first append must not be the thing that fails.
            mkdirSync(SCRATCH_DIR, {recursive: true});
            mkdirSync(dirname(CAP_JOURNAL_PATH), {recursive: true});
            if (!existsSync(CAP_JOURNAL_PATH)) {
                writeFileSync(CAP_JOURNAL_PATH, "");
            }
            await srt.SandboxManager.initialize(SANDBOX_CONFIG);
        } catch (error) {
            throw new Error(
                `the review tool sandbox failed to initialize; refusing to ` +
                    `run sub-agents with unsandboxed tools (set ` +
                    `${REVIEW_SANDBOX_ENV}=off to explicitly accept that): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
        }
        exec = makeSandboxedExec(srt.SandboxManager);
    }

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
        const tools = createReviewTools(request.cwd, exec).filter(
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
                     * The turn cap. Pi's loop has no turn limit of its own,
                     * so the cap is enforced here; an agent that has already
                     * submitted its result also stops, matching the tool's
                     * "end the turn now".
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
                    refused:
                        stopReason === "refusal" || rawStopReason === "refusal",
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
                refused:
                    stopReason === "refusal" || rawStopReason === "refusal",
                wallMs: Date.now() - started,
            };
        } catch (error) {
            // A payload the tool already accepted is complete and validated:
            // salvage it even when the session then dies. The cost
            // accumulated so far is real (Pi reports per-turn usage), so it
            // is kept rather than zeroed.
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
