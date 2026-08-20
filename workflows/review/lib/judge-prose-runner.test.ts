import {describe, expect, it, vi} from "vitest";

import {PINNED_PROSE_JUDGE_MODEL} from "./judge-prose";
import {
    createDefaultProseRunner,
    createJudgeRunner,
} from "./judge-prose-runner";

/**
 * The judge's SDK glue, against a mocked Agent SDK (the same seam test
 * dispatch-runner.test.ts gives its sibling): result-text extraction, the
 * non-success and no-result throws, and the env behavior the sibling pins
 * (restored retries, spread inheritance). A judge that silently errors on
 * every call is indistinguishable from a judge that is off, so this seam
 * gets its own coverage even though judge-prose.test.ts stubs above it.
 */

let session: () => AsyncGenerator<Record<string, unknown>>;
let lastOptions: Record<string, unknown>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    query: ({options}: {prompt: string; options: Record<string, unknown>}) => {
        lastOptions = options;
        return session();
    },
}));

describe("createJudgeRunner", () => {
    it("returns the result message's text", async () => {
        session = async function* () {
            yield {type: "assistant"};
            yield {
                type: "result",
                subtype: "success",
                result: '{"pass": true, "problems": []}',
            };
        };
        const runner = await createJudgeRunner("m");
        await expect(runner("prompt")).resolves.toBe(
            '{"pass": true, "problems": []}',
        );
    });

    it("throws on a non-success result (the gate's error state)", async () => {
        session = async function* () {
            yield {type: "result", subtype: "error_max_turns"};
        };
        const runner = await createJudgeRunner("m");
        await expect(runner("prompt")).rejects.toThrow(
            /ended without success: error_max_turns/,
        );
    });

    it("throws when the stream ends with no result message", async () => {
        // eslint-disable-next-line require-yield
        session = async function* () {
            return;
        };
        const runner = await createJudgeRunner("m");
        await expect(runner("prompt")).rejects.toThrow(
            /produced no result message/,
        );
    });

    it("pins the model, one turn, no tools, and restored retries", async () => {
        session = async function* () {
            yield {type: "result", subtype: "success", result: "ok"};
        };
        process.env["ANTHROPIC_MAX_RETRIES"] = "0";
        try {
            await (
                await createJudgeRunner("judge-model")
            )("prompt");
        } finally {
            delete process.env["ANTHROPIC_MAX_RETRIES"];
        }
        expect(lastOptions["model"]).toBe("judge-model");
        expect(lastOptions["maxTurns"]).toBe(1);
        expect(lastOptions["allowedTools"]).toEqual([]);
        const env = lastOptions["env"] as Record<string, string | undefined>;
        expect(env["ANTHROPIC_MAX_RETRIES"]).toBe("2");
        expect(env["PATH"]).toBe(process.env["PATH"]);
    });
});

describe("createDefaultProseRunner", () => {
    it("builds a runner on the pinned judge model", async () => {
        session = async function* () {
            yield {type: "result", subtype: "success", result: "ok"};
        };
        const runner = await createDefaultProseRunner();
        expect(runner).toBeDefined();
        await expect(runner!("prompt")).resolves.toBe("ok");
        expect(lastOptions["model"]).toBe(PINNED_PROSE_JUDGE_MODEL);
    });
});
