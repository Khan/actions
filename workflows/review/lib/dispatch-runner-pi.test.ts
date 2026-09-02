import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, it, expect, vi, beforeEach} from "vitest";

import type {AgentRequest} from "./dispatch";
import {createPiRunner, rejectStaleRunnerSelection} from "./dispatch-runner-pi";

/**
 * The Pi seam's own decision logic, exercised against mocked Pi libraries:
 * the structured final taking precedence over the free-text final, the
 * prose-gate salvage order, the follow-up redirect, cost accumulation from
 * per-turn usage, the turn cap, provider routing and the api-proxy
 * base-URL override, and the OS sandbox contract (fail-closed init, the
 * explicit off switch, the wrap of every tool subprocess). The extracted
 * layers carry their own unit tests (dispatch-models.test.ts,
 * dispatch-exec.test.ts, dispatch-tools-pi.test.ts); this file is about how
 * the runner wires them into a live loop.
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
    /** The stream function the runner supplies; Pi calls it per turn. */
    streamFn: (
        model: unknown,
        context: unknown,
        options?: Record<string, unknown>,
    ) => unknown;
};

/** What the fake loop does when the runner starts it. */
let loop: (args: LoopArgs) => Promise<unknown[]>;

/** Providers the runner registered, and the catalog it resolved pins against. */
type RegisteredProvider = {
    id: string;
    getModels: () => readonly {id: string; baseUrl?: string}[];
};
let registeredProviders: RegisteredProvider[];
let catalog: {id: string}[];
let googleCatalog: {id: string}[];
/** Every (provider, id) pair the runner loaded, for the routing assertions. */
let getModelCalls: [string, string][];

/** Stream options per `streamSimple` call, for the retry-budget assertion. */
let streamSimpleOptions: (Record<string, unknown> | undefined)[];

const registered = (id: string): RegisteredProvider => {
    const provider = registeredProviders.find((entry) => entry.id === id);
    if (provider === undefined) {
        throw new Error(`provider ${id} was not registered`);
    }
    return provider;
};

vi.mock("@earendil-works/pi-ai", () => ({
    createModels: () => ({
        setProvider: (provider: unknown) => {
            registeredProviders.push(provider as RegisteredProvider);
        },
        // Like the real ModelsImpl: the registry answers from the REGISTERED
        // provider's getModels, so a provider the runner rebased or extended
        // answers with its rebased or extended catalog.
        getModels: (provider?: string) => {
            const entry = registeredProviders.find(
                (candidate) => candidate.id === provider,
            );
            return entry === undefined ? catalog : entry.getModels();
        },
        getModel: (provider: string, id: string) => {
            getModelCalls.push([provider, id]);
            return {id};
        },
        streamSimple: (
            _model: unknown,
            _context: unknown,
            options?: Record<string, unknown>,
        ) => {
            streamSimpleOptions.push(options);
            return undefined;
        },
    }),
}));

vi.mock("@earendil-works/pi-ai/providers/anthropic", () => ({
    anthropicProvider: () => ({
        id: "anthropic",
        baseUrl: "https://api.anthropic.com",
        getModels: () =>
            catalog.map((model) => ({
                ...model,
                baseUrl: "https://api.anthropic.com",
            })),
    }),
}));

vi.mock("@earendil-works/pi-ai/providers/google", () => ({
    googleProvider: () => ({
        id: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        getModels: () => googleCatalog,
    }),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
    runAgentLoop: (
        prompts: unknown[],
        context: Record<string, unknown>,
        config: Record<string, unknown>,
        emit: (event: Record<string, unknown>) => void,
        signal: AbortSignal | undefined,
        streamFn: LoopArgs["streamFn"],
    ) => loop({prompts, context, config, emit, signal, streamFn}),
}));

/** The srt seam: init result and the wrap are both steerable per test. */
let sandboxInit: (config: unknown) => Promise<void>;
let sandboxWrapped: string[];
/** Every config handed to `initialize`; the policy itself is under test. */
let sandboxConfigs: unknown[];

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
    SandboxManager: {
        initialize: (config: unknown) => {
            sandboxConfigs.push(config);
            return sandboxInit(config);
        },
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
    getModelCalls = [];
    catalog = [{id: "claude-opus-4-8"}, {id: "claude-fable-5"}];
    googleCatalog = [{id: "gemini-3.6-flash"}];
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["REVIEW_SANDBOX"];
    loop = () => Promise.resolve([]);
    sandboxInit = () => Promise.resolve();
    sandboxWrapped = [];
    sandboxConfigs = [];
    streamSimpleOptions = [];
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
            allowedTools: ["Read", "Grep"],
        });
        await runner(request());
        expect(names).toEqual(["Read", "Grep"]);
        // The excluded tool must not reach the agent at all: an unregistered
        // tool cannot be called, which is the guarantee this seam rests on
        // (Pi has no permission layer to fall back to).
        expect(names).not.toContain("Bash");
    });

    it("grants the full surface when allowedTools is omitted", async () => {
        let names: string[] = [];
        loop = ({context}) => {
            names = (context["tools"] as {name: string}[]).map((t) => t.name);
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request());
        expect(names).toEqual(["Read", "Grep", "Bash"]);
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

    it("salvages the contract-valid payload when the loop dies mid style bounce", async () => {
        loop = async ({context}) => {
            const submit = findTool(context, "submit_result");
            // Contract accepts; the prose gate bounces; the session dies
            // before the rewrite lands.
            await submit.execute("1", {result: {findings: ["valid"]}});
            throw new Error("session died mid bounce");
        };
        const runner = await createPiRunner();
        const result = await runner(
            request({
                validate: () => null,
                judgeProse: () => Promise.resolve("too poetic"),
            }),
        );
        // Style enforcement may cost prose quality, never a dimension.
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: ["valid"]});
    });

    it("prefers the contract-valid provisional over an unvalidated free-text final", async () => {
        loop = async ({context, emit}) => {
            const submit = findTool(context, "submit_result");
            await submit.execute("1", {result: {findings: ["valid"]}});
            // The bounced author gives up on the tool and narrates instead.
            emit(turnEnd('{"findings": ["unvalidated prose rewrite"]}', 0.1));
            return [];
        };
        const runner = await createPiRunner();
        const result = await runner(
            request({
                validate: () => null,
                judgeProse: () => Promise.resolve("too poetic"),
            }),
        );
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: ["valid"]});
    });

    it("redirects a turn-ending agent to submit_result, twice, then lets the fallback proceed", async () => {
        const redirects: string[][] = [];
        loop = async ({config}) => {
            const followUps = config["getFollowUpMessages"] as () => {
                content: {text: string}[];
            }[];
            // Three natural stops without a submission: two redirects, then
            // the genuine fallback.
            for (let i = 0; i < 3; i += 1) {
                redirects.push(
                    followUps().map((message) => message.content[0].text),
                );
            }
            return [];
        };
        const runner = await createPiRunner();
        await runner(request({validate: () => null}));
        expect(redirects[0]).toEqual([
            expect.stringContaining("You have not delivered your result yet"),
        ]);
        expect(redirects[1]).toEqual([
            expect.stringContaining("You have not delivered your result yet"),
        ]);
        expect(redirects[2]).toEqual([]);
    });

    it("names the mid-bounce state when a rejected submission exists", async () => {
        loop = async ({context, config}) => {
            const submit = findTool(context, "submit_result");
            await submit.execute("1", {result: {}});
            const followUps = config["getFollowUpMessages"] as () => {
                content: {text: string}[];
            }[];
            const messages = followUps();
            expect(messages[0].content[0].text).toContain(
                "Your submission was rejected and must be corrected",
            );
            return [];
        };
        const runner = await createPiRunner();
        await runner(
            request({validate: () => 'missing required array "findings"'}),
        );
    });

    it("lets a stop through once a payload was accepted", async () => {
        loop = async ({context, config}) => {
            const submit = findTool(context, "submit_result");
            await submit.execute("1", {result: {findings: []}});
            const followUps = config["getFollowUpMessages"] as () => unknown[];
            expect(followUps()).toEqual([]);
            return [];
        };
        const runner = await createPiRunner();
        const result = await runner(request({validate: () => null}));
        expect(result.structured).toBe(true);
    });

    it("never redirects without a validate contract (no tool to point at)", async () => {
        loop = async ({config}) => {
            const followUps = config["getFollowUpMessages"] as () => unknown[];
            expect(followUps()).toEqual([]);
            return [];
        };
        const runner = await createPiRunner();
        await runner(request());
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

    it("reports the turn cap as max_turns, not as a clean finish", async () => {
        // Out of turns and finished-with-prose otherwise return the same
        // shape, and `dispatch.ts` would spend its one re-dispatch correcting
        // an output shape that was never the problem.
        loop = ({emit}) => {
            emit(turnEnd("partial investigation", 0));
            emit(turnEnd("still working", 0));
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        const result = await runner(request({maxTurns: 2}));
        expect(result.stopReason).toBe("max_turns");
        expect(result.structured).toBeUndefined();
    });

    it("keeps the provider's own stop reason for a finish under the cap", async () => {
        loop = ({emit}) => {
            emit({
                type: "turn_end",
                message: {
                    role: "assistant",
                    content: [{type: "text", text: "{}"}],
                    usage: {cost: {total: 0}},
                    stopReason: "end_turn",
                },
            });
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        const result = await runner(request({maxTurns: 30}));
        expect(result.stopReason).toBe("end_turn");
    });

    it("keeps the tool count and failure detail on a salvaged payload", async () => {
        // The salvage path is a session that died mid-flight, which is exactly
        // when "what killed it" is worth reporting: dropping the diagnostics
        // made a salvaged result look like a clean one.
        loop = async ({context, emit}) => {
            emit({type: "tool_execution_end"});
            emit({
                type: "turn_end",
                message: {
                    role: "assistant",
                    content: [],
                    usage: {cost: {total: 0.25}},
                    stopReason: "error",
                    errorMessage: "provider overloaded",
                },
            });
            const submit = findTool(context, "submit_result");
            await submit.execute("1", {result: {findings: []}});
            throw new Error("stream died after submission");
        };
        const runner = await createPiRunner();
        const result = await runner(request({validate: () => null}));
        expect(result.structured).toBe(true);
        expect(result.toolCalls).toBe(1);
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toContain("provider overloaded");
        expect(result.usd).toBeCloseTo(0.25);
    });

    it("folds a diagnostics array into the error message", async () => {
        // `stopReason=error` alone was the whole diagnosis for three runs;
        // Pi carries the detail on the assistant message.
        loop = ({emit}) => {
            emit({
                type: "turn_end",
                message: {
                    role: "assistant",
                    content: [],
                    usage: {cost: {total: 0}},
                    stopReason: "error",
                    errorMessage: "stream failed",
                    diagnostics: [
                        {code: "overloaded_error", detail: "retry later"},
                    ],
                },
            });
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        const result = await runner(request());
        expect(result.errorMessage).toContain("stream failed");
        expect(result.errorMessage).toContain("overloaded_error");
    });

    it("gives every sub-agent turn a bounded transient-failure retry budget", async () => {
        // Nothing upstream supplies one: gh-aw pins ANTHROPIC_MAX_RETRIES=0
        // and pi-ai does not read it, defaulting its own retry helper to 0. At
        // 0 a single 429/529 on any turn sheds a whole review lens.
        loop = ({streamFn}) => {
            streamFn({id: "claude-opus-4-8"}, []);
            streamFn({id: "claude-opus-4-8"}, [], {maxRetries: 5});
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request());
        expect(streamSimpleOptions[0]?.["maxRetries"]).toBe(2);
        // An explicit caller budget still wins.
        expect(streamSimpleOptions[1]?.["maxRetries"]).toBe(5);
    });

    it("requests an explicit thinking level on every turn, for every provider", async () => {
        // Never let a pin reach streamSimple without one: pi-ai's
        // no-reasoning path DISABLES thinking on anthropic (the SDK harness
        // ran adaptive-high by default, so that was a silent parity
        // regression) and sends gemini 3.7+ a MINIMAL level the API 400s on
        // (run 33664981308: every candidate dispatch died $0 in 2s).
        loop = ({streamFn}) => {
            streamFn({id: "gemini-3.8-flash", api: "google-generative-ai"}, []);
            streamFn({id: "claude-opus-4-8", api: "anthropic-messages"}, []);
            streamFn(
                {id: "gemini-3.8-flash", api: "google-generative-ai"},
                [],
                {reasoning: "low"},
            );
            return Promise.resolve([]);
        };
        const runner = await createPiRunner();
        await runner(request());
        expect(streamSimpleOptions[0]?.["reasoning"]).toBe("high");
        expect(streamSimpleOptions[1]?.["reasoning"]).toBe("high");
        // An explicit caller level still wins.
        expect(streamSimpleOptions[2]?.["reasoning"]).toBe("low");
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

    it("hands srt a deny-all network policy and a two-path write surface", async () => {
        // The wrap tests prove the sandbox is USED; this one pins what it
        // enforces, which is the actual boundary. Deliberately literal: a
        // future edit that adds the checkout to `allowWrite` or drops the
        // network denial must break a test, not just change a constant.
        await createPiRunner();
        expect(sandboxConfigs).toHaveLength(1);
        expect(sandboxConfigs[0]).toEqual({
            network: {allowedDomains: [], deniedDomains: ["*"]},
            filesystem: {
                denyRead: ["~/.ssh"],
                // The cap journal (the CLI appends to it) and a scratch dir,
                // and nothing else: not the checkout, not routing.json, not
                // out/ (the staged inputs downstream phases trust).
                allowWrite: [
                    "/tmp/gh-aw/review/investigation-journal.log",
                    "/tmp/review-agent-scratch",
                ],
                denyWrite: [],
            },
        });
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
        const models = registered("anthropic").getModels();
        expect(models.map((model) => model.baseUrl)).toEqual([
            "https://api.anthropic.com",
            "https://api.anthropic.com",
        ]);
    });

    it("re-registers Anthropic with every model rebased onto the api-proxy URL when steered", async () => {
        process.env["ANTHROPIC_BASE_URL"] = "http://api-proxy:10001";
        await createPiRunner();
        const models = registered("anthropic").getModels();
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
            // model.baseUrl is the field the API layer reads; the provider's
            // own baseUrl is advisory.
            expect(model.baseUrl).toBe("http://api-proxy:10001");
        }
    });

    it("registers Google with gemini-3.8-flash appended to a catalog that predates it", async () => {
        await createPiRunner();
        const ids = registered("google")
            .getModels()
            .map((model) => model.id);
        expect(ids).toEqual(["gemini-3.6-flash", "gemini-3.8-flash"]);
    });

    it("lets a pi-ai catalog that already carries gemini-3.8-flash win over the local entry", async () => {
        googleCatalog = [{id: "gemini-3.8-flash", own: true} as never];
        await createPiRunner();
        const models = registered("google").getModels();
        expect(models).toEqual([{id: "gemini-3.8-flash", own: true}]);
    });

    it("routes a gemini pin to the Google provider", async () => {
        loop = async () => [];
        const runner = await createPiRunner();
        await runner(request({model: "gemini-3.8-flash"}));
        expect(getModelCalls).toEqual([["google", "gemini-3.8-flash"]]);
    });

    it("routes a claude pin to the Anthropic provider", async () => {
        loop = async () => [];
        const runner = await createPiRunner();
        await runner(request({model: "claude-opus-4-8"}));
        expect(getModelCalls).toEqual([["anthropic", "claude-opus-4-8"]]);
    });

    it("fails loudly when the pin is missing from Pi's catalog", async () => {
        catalog = [{id: "claude-fable-5"}];
        const runner = await createPiRunner();
        await expect(
            runner(request({model: "claude-opus-4-8"})),
        ).rejects.toThrow(/not in Pi's anthropic catalog/);
    });

    it("fails loudly on a gemini pin the Google catalog does not carry", async () => {
        googleCatalog = [{id: "gemini-3.6-flash"}];
        const runner = await createPiRunner();
        await expect(
            runner(request({model: "gemini-9-flash"})),
        ).rejects.toThrow(/not in Pi's google catalog.*gemini-3.8-flash/s);
    });
});
