import {describe, it, expect, vi, beforeEach} from "vitest";

import type {AgentRequest} from "./dispatch";
import {createSdkRunner} from "./dispatch-runner";

/**
 * The SDK seam's own decision logic (trial suggestion h), exercised against
 * a mocked Agent SDK: the `submit_result` accept/reject handler, the
 * structured final taking precedence over the free-text final, and the
 * salvage of an already-accepted payload when the session then dies. Only
 * `query`/`createSdkMcpServer`/`tool` are mocked; zod and the runner run
 * for real.
 */

type ToolHandler = (
    args: Record<string, unknown>,
    extra: unknown,
) => Promise<{content: {type: string; text: string}[]; isError?: boolean}>;

type RegisteredTool = {name: string; handler: ToolHandler};

/**
 * The fake model session: given the tools the runner registered, act like
 * the model (call submit_result, end with a result message, or die).
 */
let session: (
    tools: RegisteredTool[],
) => AsyncGenerator<Record<string, unknown>>;

/** The options the runner handed the SDK on the last query. */
let lastOptions: Record<string, unknown>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: ToolHandler,
    ): RegisteredTool => ({name, handler}),
    createSdkMcpServer: (options: {name: string; tools: RegisteredTool[]}) =>
        options,
    query: ({options}: {prompt: string; options: Record<string, unknown>}) => {
        lastOptions = options;
        const servers = options["mcpServers"] as
            | Record<string, {tools: RegisteredTool[]}>
            | undefined;
        return session(servers?.["review"]?.tools ?? []);
    },
}));

const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    name: "correctness-reviewer",
    model: "m",
    prompt: "p",
    cwd: "/repo",
    maxTurns: 30,
    timeoutMs: 60_000,
    validate: (payload) =>
        Array.isArray(payload["findings"])
            ? null
            : 'missing required array "findings"',
    ...over,
});

const success = (result: string): Record<string, unknown> => ({
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: 0.42,
    num_turns: 7,
});

describe("createSdkRunner submit_result (trial suggestion h)", () => {
    beforeEach(() => {
        session = async function* () {
            yield success("free text");
        };
    });

    it("an accepted payload IS the output, beating the free-text final", async () => {
        session = async function* (tools) {
            const response = await tools[0].handler(
                {result: {findings: [{id: "f1"}]}},
                undefined,
            );
            expect(response.isError).toBeUndefined();
            yield success("some trailing prose the model emitted anyway");
        };
        const result = await (await createSdkRunner())(request());
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: [{id: "f1"}]});
        expect(result.usd).toBe(0.42);
        expect(result.turns).toBe(7);
    });

    it("a drifted shape is rejected back into the live session with the contract message", async () => {
        session = async function* (tools) {
            const rejected = await tools[0].handler(
                {result: {finding: "singular, drifted"}},
                undefined,
            );
            expect(rejected.isError).toBe(true);
            expect(rejected.content[0].text).toContain(
                'missing required array "findings"',
            );
            expect(rejected.content[0].text).toContain(
                "Call submit_result again",
            );
            // The model corrects in-session; the free-text final is still
            // the fallback if it never re-calls.
            yield success('{"findings": []}');
        };
        const result = await (await createSdkRunner())(request());
        expect(result.structured).toBeUndefined();
        expect(result.output).toBe('{"findings": []}');
    });

    it("salvages an accepted payload when the session then dies", async () => {
        session = async function* (tools) {
            await tools[0].handler({result: {findings: []}}, undefined);
            throw new Error("session hang after submission");
            // eslint-disable-next-line no-unreachable
            yield success("never reached");
        };
        const result = await (await createSdkRunner())(request());
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: []});
        // Cost fields are best-effort zero: the SDK never delivered its
        // result record.
        expect(result.usd).toBe(0);
    });

    it("salvages the last assistant text when the session dies without success", async () => {
        // The Stop hook pushes a free-text agent to keep going, so it can
        // burn its last turns being redirected and end on error_max_turns
        // with a usable final already written; that text is the output.
        session = async function* () {
            yield {
                type: "assistant",
                message: {
                    content: [{type: "text", text: "the free-text findings"}],
                },
            };
            yield {type: "result", subtype: "error_max_turns"};
        };
        const result = await (await createSdkRunner())(request());
        expect(result.structured).toBeUndefined();
        expect(result.output).toBe("the free-text findings");
        expect(result.usd).toBe(0);
    });

    it("still throws a dead session with nothing accepted", async () => {
        session = async function* () {
            yield {type: "result", subtype: "error_max_turns"};
        };
        await expect((await createSdkRunner())(request())).rejects.toThrow(
            /ended without success: error_max_turns/,
        );
    });

    it("registers no submit_result tool without a validate contract", async () => {
        session = async function* (tools) {
            expect(tools).toEqual([]);
            yield success("free text");
        };
        const result = await (
            await createSdkRunner()
        )(request({validate: undefined}));
        expect(result.structured).toBeUndefined();
        expect(result.output).toBe("free text");
    });
});

/**
 * The sub-agent subprocess environment. gh-aw >= v0.83 puts
 * ANTHROPIC_MAX_RETRIES=0 on the engine step for the orchestrator's benefit
 * (its harness owns retry/backoff); a sub-agent has no such wrapper, so the
 * runner must not let it inherit that value.
 */
describe("createSdkRunner sub-agent environment", () => {
    beforeEach(() => {
        session = async function* () {
            yield success("free text");
        };
    });

    it("restores SDK retries instead of inheriting the engine step's 0", async () => {
        process.env["ANTHROPIC_MAX_RETRIES"] = "0";
        try {
            await (
                await createSdkRunner()
            )(request());
        } finally {
            delete process.env["ANTHROPIC_MAX_RETRIES"];
        }
        const env = lastOptions["env"] as Record<string, string | undefined>;
        expect(env["ANTHROPIC_MAX_RETRIES"]).toBe("2");
    });

    it("spreads the inherited environment, since `env` replaces rather than merges", async () => {
        process.env["GH_AW_DISPATCH_RUNNER_PROBE"] = "inherited";
        try {
            await (
                await createSdkRunner()
            )(request());
        } finally {
            delete process.env["GH_AW_DISPATCH_RUNNER_PROBE"];
        }
        const env = lastOptions["env"] as Record<string, string | undefined>;
        expect(env["GH_AW_DISPATCH_RUNNER_PROBE"]).toBe("inherited");
        expect(env["PATH"]).toBe(process.env["PATH"]);
    });
});

type HookCallback = (
    input?: unknown,
    toolUseID?: unknown,
    extra?: unknown,
) => Promise<Record<string, unknown>>;

/** The Stop hook the runner registered on the last query, if any. */
const stopHook = (): HookCallback | undefined => {
    const hooks = lastOptions["hooks"] as
        | Record<string, {hooks: HookCallback[]}[]>
        | undefined;
    return hooks?.["Stop"]?.[0]?.hooks[0];
};

describe("createSdkRunner prose gate (PRA-45)", () => {
    it("bounces a style rejection to the author AFTER the contract accepts", async () => {
        const judged: string[] = [];
        session = async function* (tools) {
            const bounced = await tools[0].handler(
                {result: {findings: [{id: "f1"}]}},
                undefined,
            );
            expect(bounced.isError).toBe(true);
            expect(bounced.content[0].text).toBe("Result rejected: style");
            // The author rewrites and re-calls; second submission passes.
            const accepted = await tools[0].handler(
                {result: {findings: [{id: "f1-rewritten"}]}},
                undefined,
            );
            expect(accepted.isError).toBeUndefined();
            yield success("trailing prose");
        };
        const result = await (
            await createSdkRunner()
        )(
            request({
                judgeProse: (payload) => {
                    judged.push(JSON.stringify(payload));
                    return Promise.resolve(
                        judged.length === 1 ? "Result rejected: style" : null,
                    );
                },
            }),
        );
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({
            findings: [{id: "f1-rewritten"}],
        });
        expect(judged).toHaveLength(2);
    });

    it("salvages the contract-valid payload when the session dies mid style bounce", async () => {
        session = async function* (tools) {
            const bounced = await tools[0].handler(
                {result: {findings: [{id: "pre-style"}]}},
                undefined,
            );
            expect(bounced.isError).toBe(true);
            throw new Error("session died before the rewrite came back");
            // eslint-disable-next-line no-unreachable
            yield success("never reached");
        };
        const result = await (
            await createSdkRunner()
        )(
            request({
                judgeProse: () => Promise.resolve("Result rejected: style"),
            }),
        );
        // Style enforcement may cost prose quality, never a dimension: the
        // pre-style payload posts rather than the lens being shed.
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({
            findings: [{id: "pre-style"}],
        });
    });

    it("prefers the contract-valid provisional over an unvalidated free-text final", async () => {
        session = async function* (tools) {
            await tools[0].handler(
                {result: {findings: [{id: "pre-style"}]}},
                undefined,
            );
            yield success("free text the model pasted instead of re-calling");
        };
        const result = await (
            await createSdkRunner()
        )(
            request({
                judgeProse: () => Promise.resolve("Result rejected: style"),
            }),
        );
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({
            findings: [{id: "pre-style"}],
        });
    });

    it("never judges a payload the contract already rejected", async () => {
        let judgeCalls = 0;
        session = async function* (tools) {
            const rejected = await tools[0].handler(
                {result: {finding: "drifted"}},
                undefined,
            );
            expect(rejected.isError).toBe(true);
            yield success('{"findings": []}');
        };
        await (
            await createSdkRunner()
        )(
            request({
                judgeProse: () => {
                    judgeCalls += 1;
                    return Promise.resolve(null);
                },
            }),
        );
        expect(judgeCalls).toBe(0);
    });
});

describe("createSdkRunner Stop hook (the free-text fallback funnel)", () => {
    it("blocks a stop without a submission, twice, then lets the fallback proceed", async () => {
        session = async function* () {
            yield success("free text");
        };
        await (
            await createSdkRunner()
        )(request());
        const hook = stopHook();
        expect(hook).toBeDefined();
        const first = await hook!();
        expect(first).toMatchObject({decision: "block"});
        expect(String(first["reason"])).toContain("submit_result");
        expect(await hook!()).toMatchObject({decision: "block"});
        // Cap spent: the third stop goes through (the genuine fallback).
        expect(await hook!()).toEqual({});
    });

    it("lets a stop through once a payload was accepted", async () => {
        session = async function* (tools) {
            await tools[0].handler({result: {findings: []}}, undefined);
            yield success("done");
        };
        await (
            await createSdkRunner()
        )(request());
        const hook = stopHook();
        expect(await hook!()).toEqual({});
    });

    it("registers no Stop hook without a validate contract (no tool to point at)", async () => {
        session = async function* () {
            yield success("free text");
        };
        await (
            await createSdkRunner()
        )(request({validate: undefined}));
        expect(stopHook()).toBeUndefined();
    });
});
