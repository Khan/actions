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

/** The SDK's per-model usage on a result record, as the runner reads it. */
const MODEL_USAGE = {
    "claude-opus-5": {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 200,
        costUSD: 0.42,
    },
};
const USAGE = [
    {
        model: "claude-opus-5",
        input: 1000,
        output: 100,
        cacheRead: 5000,
        cacheWrite: 200,
    },
];

const success = (result: string): Record<string, unknown> => ({
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: 0.42,
    num_turns: 7,
    modelUsage: MODEL_USAGE,
});

describe("createSdkRunner submit_result (trial suggestion h)", () => {
    beforeEach(() => {
        session = async function* () {
            yield success("free text");
        };
    });

    it("reports the result record's per-model tokens beside its dollars", async () => {
        // The cost report prices from these; the SDK's dollar figure is
        // list and cannot be re-priced.
        const result = await (await createSdkRunner())(request());
        expect(result.usd).toBe(0.42);
        expect(result.usage).toEqual(USAGE);
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
        // Cost fields are best-effort zero ONLY here: the stream died with
        // no result record of any subtype, so there is nothing to report,
        // and no tokens either (absent, so the report reads it as untracked
        // rather than as free).
        expect(result.usd).toBe(0);
        expect(result.usage).toBeUndefined();
    });

    it("salvages the last assistant text when the session dies without success", async () => {
        // The Stop hook pushes a free-text agent to keep going, so it can
        // burn its last turns being redirected and end on error_max_turns
        // with a usable final already written; that text is the output, and
        // the metering comes from the non-success result record rather than
        // a systematic zero (the record still carries cost and turns).
        session = async function* () {
            yield {
                type: "assistant",
                message: {
                    content: [{type: "text", text: "the free-text findings"}],
                },
            };
            yield {
                type: "result",
                subtype: "error_max_turns",
                total_cost_usd: 1.5,
                num_turns: 100,
                modelUsage: MODEL_USAGE,
            };
        };
        const result = await (await createSdkRunner())(request());
        expect(result.structured).toBeUndefined();
        expect(result.output).toBe("the free-text findings");
        expect(result.usd).toBe(1.5);
        expect(result.turns).toBe(100);
        // The tokens ride the non-success record the same way the dollars do.
        expect(result.usage).toEqual(USAGE);
    });

    it("the LAST assistant text wins when several were emitted", async () => {
        // "last" was previously unasserted: an agent narrates before its
        // final, and salvaging the narration instead of the final would
        // silently ship the wrong text.
        session = async function* () {
            for (const text of ["narration", "the real final"]) {
                yield {
                    type: "assistant",
                    message: {content: [{type: "text", text}]},
                };
            }
            yield {type: "result", subtype: "error_max_turns"};
        };
        const result = await (await createSdkRunner())(request());
        expect(result.output).toBe("the real final");
    });

    it("does not salvage lastText on a hard failure with no result record", async () => {
        // The gate on the lastText salvage: a session that dies mid-stream
        // (no result record of any subtype) left narration, not a final;
        // returning it would fail the contract parse and burn the
        // malformed-output re-dispatch, exactly like the timeout case.
        session = async function* () {
            yield {
                type: "assistant",
                message: {content: [{type: "text", text: "narration"}]},
            };
            throw new Error("stream died");
        };
        await expect((await createSdkRunner())(request())).rejects.toThrow(
            /stream died/,
        );
    });

    it("a bounced provisional payload outranks lastText and reports the run's metering", async () => {
        // provisional-beats-lastText in the catch path: a contract-valid
        // submission the prose gate was still bouncing salvages as the
        // structured output even though a later free-text final exists.
        session = async function* (tools) {
            const bounced = await tools[0].handler(
                {result: {findings: [{id: "styled"}]}},
                undefined,
            );
            expect(bounced.isError).toBe(true);
            yield {
                type: "assistant",
                message: {content: [{type: "text", text: "free-text final"}]},
            };
            yield {
                type: "result",
                subtype: "error_max_turns",
                total_cost_usd: 2.25,
                num_turns: 42,
                modelUsage: MODEL_USAGE,
            };
        };
        const result = await (
            await createSdkRunner()
        )(
            request({
                judgeProse: async () => "prose rejected: too poetic",
            }),
        );
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: [{id: "styled"}]});
        expect(result.usd).toBe(2.25);
        expect(result.turns).toBe(42);
        expect(result.usage).toEqual(USAGE);
    });

    it("reports a timeout instead of salvaging mid-investigation narration", async () => {
        // Nearly every agent emits assistant text before it finishes, so a
        // lastText salvage that outranks the timeout check would make the
        // timeout error unreachable: the narration would come back as the
        // output, fail the contract parse, and burn the one
        // malformed-output re-dispatch (paying for the timed-out run
        // twice). The timeout must win over lastText.
        session = async function* () {
            yield {
                type: "assistant",
                message: {
                    content: [{type: "text", text: "still investigating..."}],
                },
            };
            await new Promise((resolve) => setTimeout(resolve, 25));
            throw new Error("aborted by user");
        };
        await expect(
            (
                await createSdkRunner()
            )(request({timeoutMs: 5})),
        ).rejects.toThrow(/timed out after 5ms/);
    });

    it("still salvages an ACCEPTED payload past the timeout", async () => {
        // A payload submit_result accepted is complete and validated; the
        // session then hanging until the timeout should not discard it.
        session = async function* (tools) {
            await tools[0].handler({result: {findings: []}}, undefined);
            await new Promise((resolve) => setTimeout(resolve, 25));
            throw new Error("aborted by user");
            // eslint-disable-next-line no-unreachable
            yield success("never reached");
        };
        const result = await (await createSdkRunner())(request({timeoutMs: 5}));
        expect(result.structured).toBe(true);
        expect(JSON.parse(result.output)).toEqual({findings: []});
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

    it("pins effort high explicitly instead of riding the SDK default", async () => {
        // The SDK default IS adaptive thinking at effort high for opus-4.6+,
        // so this is behavior-neutral; it exists because the invisible
        // default let the Pi harness port disable thinking without anyone
        // noticing (PR #406).
        await (
            await createSdkRunner()
        )(request());
        expect(lastOptions["effort"]).toBe("high");
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

    it("names the mid-bounce state when a prose-gate-rejected submission exists", async () => {
        session = async function* (tools) {
            const bounced = await tools[0].handler(
                {result: {findings: [{id: "pre-style"}]}},
                undefined,
            );
            expect(bounced.isError).toBe(true);
            yield success("free text");
        };
        await (
            await createSdkRunner()
        )(
            request({
                judgeProse: () => Promise.resolve("Result rejected: style"),
            }),
        );
        const blocked = await stopHook()!();
        expect(blocked).toMatchObject({decision: "block"});
        // The contract-valid payload is mid-bounce: telling the agent it
        // never delivered is the falsehood this branch removes.
        expect(String(blocked["reason"])).toContain("was rejected");
        expect(String(blocked["reason"])).not.toContain("have not delivered");
    });

    it("names the mid-bounce state for a CONTRACT bounce too (no provisional exists)", async () => {
        // A contract bounce sets neither captured nor provisional; only the
        // attempt counter knows the agent already called the tool.
        session = async function* (tools) {
            const bounced = await tools[0].handler(
                {result: {finding: "singular, drifted"}},
                undefined,
            );
            expect(bounced.isError).toBe(true);
            yield success("free text");
        };
        await (
            await createSdkRunner()
        )(request());
        const blocked = await stopHook()!();
        expect(blocked).toMatchObject({decision: "block"});
        expect(String(blocked["reason"])).toContain("was rejected");
        expect(String(blocked["reason"])).not.toContain("have not delivered");
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
