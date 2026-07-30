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
