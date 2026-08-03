import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, it, expect, vi, beforeEach} from "vitest";

import type {AgentRequest} from "./dispatch";
import {
    capOutput,
    createPiRunner,
    createReviewTools,
    createSubmitTool,
    finalText,
    makeSandboxedExec,
    rejectStaleRunnerSelection,
    resolveModelId,
    shellQuote,
} from "./dispatch-runner-pi";

/**
 * The Pi seam's own decision logic, exercised against mocked Pi libraries:
 * the tool surface, the `submit_result` accept/reject handler, the structured
 * final taking precedence over the free-text final, cost accumulation from
 * per-turn usage, the turn cap, the api-proxy base-URL override, the OS
 * sandbox contract (fail-closed init, the explicit off switch, the wrap of
 * every tool subprocess), and the salvage of an already-accepted payload
 * when the loop then dies.
 *
 * `pi-ai`, `pi-agent-core`, and `sandbox-runtime` are mocked; the runner,
 * its tools, and the real `execFile` run for real.
 */

type LoopArgs = {
    prompts: unknown[];
    context: Record<string, unknown>;
    config: Record<string, unknown>;
    emit: (event: Record<string, unknown>) => void;
    signal: AbortSignal | undefined;
};

/** What the fake loop does when the runner starts it. */
let loop: (args: LoopArgs) => Promise<unknown[]>;

/** Providers the runner registered, and the catalog it resolved pins against. */
let registeredProviders: unknown[];
let catalog: {id: string}[];
let createProviderInput: Record<string, unknown> | undefined;

vi.mock("@earendil-works/pi-ai", () => ({
    createModels: () => ({
        setProvider: (provider: unknown) => {
            registeredProviders.push(provider);
        },
        getModels: () => catalog,
        getModel: (_provider: string, id: string) => ({id}),
        streamSimple: () => undefined,
    }),
    createProvider: (input: Record<string, unknown>) => {
        createProviderInput = input;
        return {...input, tag: "overridden"};
    },
}));

vi.mock("@earendil-works/pi-ai/providers/anthropic", () => ({
    anthropicProvider: () => ({
        id: "anthropic",
        baseUrl: "https://api.anthropic.com",
    }),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
    runAgentLoop: (
        prompts: unknown[],
        context: Record<string, unknown>,
        config: Record<string, unknown>,
        emit: (event: Record<string, unknown>) => void,
        signal: AbortSignal | undefined,
    ) => loop({prompts, context, config, emit, signal}),
}));

/** The srt seam: init result and the wrap are both steerable per test. */
let sandboxInit: (config: unknown) => Promise<void>;
let sandboxWrapped: string[];

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
    SandboxManager: {
        initialize: (config: unknown) => sandboxInit(config),
        wrapWithSandboxArgv: (command: string) => {
            sandboxWrapped.push(command);
            // Identity wrap: run the quoted command through a plain shell so
            // the tool behavior itself stays observable.
            return Promise.resolve({argv: ["bash", "-c", command]});
        },
    },
}));

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
    name: "correctness-reviewer",
    model: "claude-opus-4-8",
    prompt: "review the diff",
    cwd: "/tmp",
    maxTurns: 30,
    timeoutMs: 60_000,
    ...overrides,
});

/** An assistant turn_end event carrying text and a cost. */
const turnEnd = (text: string, total: number): Record<string, unknown> => ({
    type: "turn_end",
    message: {
        role: "assistant",
        content: [{type: "text", text}],
        usage: {cost: {total}},
    },
    toolResults: [],
});

const findTool = (
    context: Record<string, unknown>,
    name: string,
): {
    execute: (
        id: string,
        params: Record<string, unknown>,
    ) => Promise<{content: {text: string}[]; isError?: boolean}>;
} => {
    const tools = context["tools"] as {name: string}[];
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) {
        throw new Error(`tool ${name} was not registered`);
    }
    return tool as never;
};

beforeEach(() => {
    registeredProviders = [];
    createProviderInput = undefined;
    catalog = [{id: "claude-opus-4-8"}, {id: "claude-fable-5"}];
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["REVIEW_SANDBOX"];
    loop = () => Promise.resolve([]);
    sandboxInit = () => Promise.resolve();
    sandboxWrapped = [];
});

describe("resolveModelId", () => {
    it("takes an exact catalog match", () => {
        expect(
            resolveModelId("claude-opus-4-8", [
                {id: "claude-opus-4-8"},
                {id: "claude-opus-4-8-20260101"},
            ]),
        ).toBe("claude-opus-4-8");
    });

    it("falls back to the pin's latest dated release when not exact", () => {
        expect(
            resolveModelId("claude-opus-4-8", [
                {id: "claude-opus-4-8-20251201"},
                {id: "claude-opus-4-8-20260101"},
            ]),
        ).toBe("claude-opus-4-8-20260101");
    });

    it("never jumps tiers on a family-prefix pin", () => {
        // A bare startsWith fallback resolved claude-sonnet-4 to the LONGER
        // claude-sonnet-4-5 id, silently running a different model tier than
        // the pin claims.
        expect(
            resolveModelId("claude-sonnet-4", [
                {id: "claude-sonnet-4-20250514"},
                {id: "claude-sonnet-4-5-20250929"},
            ]),
        ).toBe("claude-sonnet-4-20250514");
    });

    it("throws with the candidates rather than silently running another model", () => {
        expect(() =>
            resolveModelId("claude-opus-9", [{id: "claude-fable-5"}]),
        ).toThrow(/not in Pi's Anthropic catalog.*claude-fable-5/s);
        // A non-dated extension is not a release of the pin either.
        expect(() =>
            resolveModelId("claude-opus-4-8", [{id: "claude-opus-4-8-latest"}]),
        ).toThrow(/not in Pi's Anthropic catalog/);
    });
});

describe("rejectStaleRunnerSelection", () => {
    it("accepts an unset selection and the redundant-but-accurate value", () => {
        expect(() => rejectStaleRunnerSelection({})).not.toThrow();
        expect(() =>
            rejectStaleRunnerSelection({REVIEW_DISPATCH_RUNNER: "pi"}),
        ).not.toThrow();
    });

    it("throws on a stale SDK selection rather than silently running Pi", () => {
        for (const stale of ["sdk", "sdkk", "claude", ""]) {
            expect(() =>
                rejectStaleRunnerSelection({REVIEW_DISPATCH_RUNNER: stale}),
            ).toThrow(/selects nothing/);
        }
    });
});

describe("capOutput", () => {
    it("passes short output through untouched", () => {
        expect(capOutput("two lines\nof output")).toBe("two lines\nof output");
    });

    it("truncates long output and says how much was dropped", () => {
        const capped = capOutput("x".repeat(30_050));
        expect(capped).toContain("[truncated: 50 more characters]");
        expect(capped.startsWith("x".repeat(30_000))).toBe(true);
    });
});

describe("createReviewTools", () => {
    it("grants exactly the read-only investigation surface plus Bash", () => {
        expect(createReviewTools("/tmp").map((tool) => tool.name)).toEqual([
            "Read",
            "Grep",
            "Glob",
            "LS",
            "Bash",
        ]);
    });

    it("never grants a mutation tool", () => {
        const names = createReviewTools("/tmp").map((tool) =>
            tool.name.toLowerCase(),
        );
        expect(names).not.toContain("edit");
        expect(names).not.toContain("write");
    });

    it("reads a real file with line numbers", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-runner-"));
        writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
        const read = createReviewTools(dir).find(
            (tool) => tool.name === "Read",
        );
        const result = await read?.execute("1", {path: "a.ts"});
        expect(result?.content[0].text).toContain("const a = 1;");
        expect(result?.content[0].text).toContain("1");
    });

    it("reports a grep miss as an ordinary result, not a tool failure", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-runner-"));
        writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
        const grep = createReviewTools(dir).find(
            (tool) => tool.name === "Grep",
        );
        const result = await grep?.execute("1", {pattern: "nothing-here"});
        expect(result?.content[0].text).toBe("(no output)");
        expect(result?.isError).toBeUndefined();
    });
});

describe("shellQuote", () => {
    it("single-quotes each argv part", () => {
        expect(shellQuote(["grep", "-n", "a b"])).toBe("'grep' '-n' 'a b'");
    });

    it("escapes embedded single quotes", () => {
        expect(shellQuote(["echo", "it's"])).toBe("'echo' 'it'\\''s'");
    });

    it("round-trips through a real shell", async () => {
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            // Identity wrap: the command string srt would sandbox, run plain.
            wrapWithSandboxArgv: (command) =>
                Promise.resolve({argv: ["bash", "-c", command]}),
        });
        const out = await exec(["printf", "%s", "it's a 'quoted' $arg"], ".");
        expect(out).toBe("it's a 'quoted' $arg");
    });
});

describe("makeSandboxedExec", () => {
    it("hands srt the quoted command and the cwd, and spawns srt's argv", async () => {
        const seen: {command?: string; cwd?: string} = {};
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            wrapWithSandboxArgv: (command, _shell, _config, _signal, cwd) => {
                seen.command = command;
                seen.cwd = cwd;
                return Promise.resolve({argv: ["echo", "wrapped"]});
            },
        });
        const out = await exec(["printf", "hi"], "/tmp");
        expect(seen.command).toBe("'printf' 'hi'");
        expect(seen.cwd).toBe("/tmp");
        expect(out.trim()).toBe("wrapped");
    });

    it("spawns with the environment srt asks for", async () => {
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            wrapWithSandboxArgv: () =>
                Promise.resolve({
                    argv: ["bash", "-c", 'printf %s "$SRT_MARKER"'],
                    env: {...process.env, SRT_MARKER: "sandboxed"},
                }),
        });
        expect(await exec(["ignored"], ".")).toBe("sandboxed");
    });
});

describe("createSubmitTool", () => {
    it("bounces a rejected payload back with the rejection message", async () => {
        const tool = createSubmitTool(
            () => "missing `lens`",
            () => {
                throw new Error("must not accept");
            },
        );
        const result = await tool.execute("1", {result: {}});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("missing `lens`");
        expect(result.content[0].text).toContain("Call submit_result again");
    });

    it("records an accepted payload", async () => {
        let captured: Record<string, unknown> | undefined;
        const tool = createSubmitTool(
            () => null,
            (payload) => {
                captured = payload;
            },
        );
        const result = await tool.execute("1", {result: {lens: "security"}});
        expect(result.isError).toBeUndefined();
        expect(captured).toEqual({lens: "security"});
    });
});

describe("finalText", () => {
    it("prefers the last turn that carries a JSON object", () => {
        expect(finalText(["prose", '{"a": 1}', "thanks, done"])).toBe(
            '{"a": 1}',
        );
    });

    it("takes the latest JSON when several turns carry one", () => {
        expect(finalText(['{"a": 1}', '{"a": 2}'])).toBe('{"a": 2}');
    });

    it("falls back to the whole transcript when no turn carries JSON", () => {
        expect(finalText(["first", "second"])).toBe("first\nsecond");
    });

    it("survives an empty transcript", () => {
        expect(finalText([])).toBe("");
    });
});

describe("createPiRunner", () => {
    it("returns the structured final and sums per-turn cost", async () => {
        loop = async ({context, emit}) => {
            const submit = findTool(context, "submit_result");
            await submit.execute("1", {result: {findings: []}});
            emit(turnEnd("prose the model also wrote", 0.25));
            emit(turnEnd("", 0.75));
            return [];
        };
        const runner = await createPiRunner();
        const result = await runner(request({validate: () => null}));
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: []});
        expect(result.usd).toBeCloseTo(1.0);
        expect(result.turns).toBe(2);
    });

    it("falls back to the free-text final when the tool was never called", async () => {
        loop = async ({emit}) => {
            emit(turnEnd("the whole answer as prose", 0.1));
            return [];
        };
        const runner = await createPiRunner();
        const result = await runner(request());
        expect(result.structured).toBeUndefined();
        expect(result.output).toBe("the whole answer as prose");
    });

    it("keeps the contract when the model signs off after emitting it", async () => {
        // Run 30592964392: the candidate arm returned "no parseable JSON
        // object" because the JSON landed a turn before the closing sentence.
        loop = async ({emit}) => {
            emit(turnEnd('{"findings": []}', 0.1));
            emit(turnEnd("I have completed the review above.", 0.1));
            return [];
        };
        const runner = await createPiRunner();
        const result = await runner(request());
        expect(JSON.parse(result.output)).toEqual({findings: []});
    });

    it("counts tool calls so the harness comparison has an investigation signal", async () => {
        loop = async ({emit}) => {
            emit({type: "tool_execution_end", toolName: "Grep"});
            emit({type: "tool_execution_end", toolName: "Read"});
            emit(turnEnd('{"findings": []}', 0.1));
            return [];
        };
        const runner = await createPiRunner();
        const result = await runner(request());
        expect(result.toolCalls).toBe(2);
        // A tool_execution_end must not be counted as a turn.
        expect(result.turns).toBe(1);
    });

    it("carries the stop reason so an empty final can be diagnosed", async () => {
        loop = ({emit}) => {
            emit({
                type: "turn_end",
                message: {
                    role: "assistant",
                    content: [],
                    stopReason: "refusal",
                    usage: {cost: {total: 0.02}},
                },
                toolResults: [],
            });
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        const result = await runner(request());
        // The empty-final signature: no text, and a stop reason that says why.
        expect(result.output).toBe("");
        expect(result.stopReason).toBe("refusal");
        // Either field trips it; the sibling runners key off the normalized one.
        expect(result.refused).toBe(true);
    });

    it("keeps the provider failure detail behind stopReason=error", async () => {
        // Run 30654062900 reported only `stopReason=error`, which cannot tell
        // an overloaded provider from a prompt past the context window.
        loop = ({emit}) => {
            emit({
                type: "turn_end",
                message: {
                    role: "assistant",
                    content: [],
                    stopReason: "error",
                    rawStopReason: "invalid_request_error",
                    errorMessage: "prompt is too long: 210000 tokens",
                    usage: {
                        input: 209_000,
                        totalTokens: 210_000,
                        cost: {total: 0.03},
                    },
                },
                toolResults: [],
            });
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        const result = await runner(request());
        expect(result.stopReason).toBe("error");
        expect(result.rawStopReason).toBe("invalid_request_error");
        expect(result.errorMessage).toContain("prompt is too long");
        expect(result.tokensAtFailure).toEqual({
            input: 209_000,
            total: 210_000,
        });
    });

    it("honors allowedTools, the boundary on what a sub-agent can touch", async () => {
        let names: string[] = [];
        loop = ({context}) => {
            names = (context["tools"] as {name: string}[]).map((t) => t.name);
            return Promise.resolve([]);
        };
        const runner = await createPiRunner({
            allowedTools: ["Read", "Grep", "Glob"],
        });
        await runner(request());
        expect(names).toEqual(["Read", "Grep", "Glob"]);
        // The excluded tools must not reach the agent at all: an unregistered
        // tool cannot be called, which is the guarantee this seam rests on
        // (Pi has no permission layer to fall back to).
        expect(names).not.toContain("Bash");
        expect(names).not.toContain("LS");
    });

    it("grants the full surface when allowedTools is omitted", async () => {
        let names: string[] = [];
        loop = ({context}) => {
            names = (context["tools"] as {name: string}[]).map((t) => t.name);
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request());
        expect(names).toEqual(["Read", "Grep", "Glob", "LS", "Bash"]);
    });

    it("keeps submit_result available under a restricted surface", async () => {
        // The contract channel is not an investigation tool; restricting the
        // toolbox must not cost the agent its only way to deliver a result.
        let names: string[] = [];
        loop = ({context}) => {
            names = (context["tools"] as {name: string}[]).map((t) => t.name);
            return Promise.resolve([]);
        };
        const runner = await createPiRunner({allowedTools: ["Read"]});
        await runner(request({validate: () => null}));
        expect(names).toEqual(["Read", "submit_result"]);
    });

    it("frames the sub-agent with a system prompt", async () => {
        let systemPrompt = "unset";
        loop = ({context}) => {
            systemPrompt = String(context["systemPrompt"]);
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request());
        expect(systemPrompt).toContain("code-review sub-agent");
        expect(systemPrompt).not.toBe("");
    });

    it("registers no submit_result tool when the request has no contract", async () => {
        let names: string[] = [];
        loop = ({context}) => {
            names = (context["tools"] as {name: string}[]).map(
                (tool) => tool.name,
            );
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request());
        expect(names).not.toContain("submit_result");
    });

    it("salvages an accepted payload when the loop then dies", async () => {
        loop = async ({context}) => {
            const submit = findTool(context, "submit_result");
            await submit.execute("1", {result: {findings: ["one"]}});
            throw new Error("stream died after submission");
        };
        const runner = await createPiRunner();
        const result = await runner(request({validate: () => null}));
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: ["one"]});
    });

    it("reports a timeout as a timeout, not as a generic abort", async () => {
        loop = ({signal}) =>
            new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                    reject(new Error("aborted by user"));
                });
            });
        const runner = await createPiRunner();
        await expect(runner(request({timeoutMs: 10}))).rejects.toThrow(
            "sub-agent timed out after 10ms",
        );
    });

    it("stops at the turn cap", async () => {
        let stopped = false;
        loop = ({config, emit}) => {
            const shouldStop = config["shouldStopAfterTurn"] as () => boolean;
            emit(turnEnd("one", 0));
            emit(turnEnd("two", 0));
            stopped = shouldStop();
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request({maxTurns: 2}));
        expect(stopped).toBe(true);
    });

    it("wraps every tool subprocess in the OS sandbox", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-runner-"));
        writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
        let text = "";
        loop = async ({context}) => {
            const read = findTool(context, "Read");
            const result = await read.execute("1", {path: "a.ts"});
            text = result.content[0].text;
            return [];
        };
        const runner = await createPiRunner();
        await runner(request({cwd: dir}));
        // The command reached srt quoted, and its output still flowed back.
        expect(sandboxWrapped).toEqual(["'cat' '-n' '--' 'a.ts'"]);
        expect(text).toContain("const a = 1;");
    });

    it("fails closed when the sandbox cannot initialize", async () => {
        sandboxInit = () => Promise.reject(new Error("bwrap missing"));
        await expect(createPiRunner()).rejects.toThrow(
            /sandbox failed to initialize.*REVIEW_SANDBOX=off.*bwrap missing/s,
        );
    });

    it("runs unwrapped only on the explicit REVIEW_SANDBOX=off", async () => {
        process.env["REVIEW_SANDBOX"] = "off";
        const quiet = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        try {
            let initialized = false;
            sandboxInit = () => {
                initialized = true;
                return Promise.resolve();
            };
            const dir = mkdtempSync(join(tmpdir(), "pi-runner-"));
            writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
            let text = "";
            loop = async ({context}) => {
                const read = findTool(context, "Read");
                const result = await read.execute("1", {path: "a.ts"});
                text = result.content[0].text;
                return [];
            };
            const runner = await createPiRunner();
            await runner(request({cwd: dir}));
            expect(initialized).toBe(false);
            expect(sandboxWrapped).toEqual([]);
            expect(text).toContain("const a = 1;");
            // The bypass is loud, never silent.
            expect(quiet).toHaveBeenCalledWith(
                expect.stringContaining("REVIEW_SANDBOX=off"),
            );
        } finally {
            quiet.mockRestore();
        }
    });

    it("keeps Pi's bundled provider when the sandbox sets no base URL", async () => {
        await createPiRunner();
        expect(createProviderInput).toBeUndefined();
        expect(registeredProviders).toEqual([
            {id: "anthropic", baseUrl: "https://api.anthropic.com"},
        ]);
    });

    it("re-registers Anthropic on the api-proxy base URL when steered", async () => {
        process.env["ANTHROPIC_BASE_URL"] = "http://api-proxy:10001";
        await createPiRunner();
        expect(createProviderInput?.["baseUrl"]).toBe("http://api-proxy:10001");
    });

    it("fails loudly when the pin is missing from Pi's catalog", async () => {
        catalog = [{id: "claude-fable-5"}];
        const runner = await createPiRunner();
        await expect(
            runner(request({model: "claude-opus-4-8"})),
        ).rejects.toThrow(/not in Pi's Anthropic catalog/);
    });
});
