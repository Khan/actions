import {describe, expect, it, vi, beforeEach} from "vitest";

import {PINNED_PROSE_JUDGE_MODEL} from "./judge-prose";
import {
    createDefaultProseRunner,
    createJudgeRunner,
} from "./judge-prose-runner";

/**
 * The judge's Pi glue, against mocked Pi libraries (the same seam test
 * dispatch-runner-pi.test.ts gives its sibling): text extraction from the
 * completion, the error-stop and empty-text throws, the pinned model, and
 * the restored retry budget. A judge that silently errors on every call is
 * indistinguishable from a judge that is off, so this seam gets its own
 * coverage even though judge-prose.test.ts stubs above it.
 */

type Completion = {
    stopReason: string;
    errorMessage?: string;
    content: {type: string; text?: string}[];
};

/** What the fake registry returns for the next completeSimple call. */
let completion: () => Promise<Completion>;
/** The (model, context, options) of the last completeSimple call. */
let lastCall: {
    model: unknown;
    context: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
};
let catalog: {id: string}[];

vi.mock("@earendil-works/pi-ai", () => ({
    createModels: () => ({
        setProvider: () => undefined,
        getModels: () => catalog,
        getModel: (_provider: string, id: string) => ({id}),
        completeSimple: (
            model: unknown,
            context: Record<string, unknown>,
            options?: Record<string, unknown>,
        ) => {
            lastCall = {model, context, options};
            return completion();
        },
    }),
}));

vi.mock("@earendil-works/pi-ai/providers/anthropic", () => ({
    anthropicProvider: () => ({
        id: "anthropic",
        getModels: () => catalog,
    }),
}));

const text = (value: string): Completion => ({
    stopReason: "end_turn",
    content: [{type: "text", text: value}],
});

beforeEach(() => {
    catalog = [{id: PINNED_PROSE_JUDGE_MODEL}, {id: "judge-model"}];
    completion = () => Promise.resolve(text("ok"));
    delete process.env["ANTHROPIC_BASE_URL"];
});

describe("createJudgeRunner", () => {
    it("returns the completion's text", async () => {
        completion = () =>
            Promise.resolve(text('{"pass": true, "problems": []}'));
        const runner = await createJudgeRunner("judge-model");
        await expect(runner("prompt")).resolves.toBe(
            '{"pass": true, "problems": []}',
        );
    });

    it("throws on an error stop (the gate's error state)", async () => {
        completion = () =>
            Promise.resolve({
                stopReason: "error",
                errorMessage: "overloaded",
                content: [],
            });
        const runner = await createJudgeRunner("judge-model");
        await expect(runner("prompt")).rejects.toThrow(
            /ended without success: overloaded/,
        );
    });

    it("throws when the completion carries no text", async () => {
        completion = () =>
            Promise.resolve({stopReason: "end_turn", content: []});
        const runner = await createJudgeRunner("judge-model");
        await expect(runner("prompt")).rejects.toThrow(/produced no text/);
    });

    it("pins the model, no tools, and restored retries", async () => {
        const runner = await createJudgeRunner("judge-model");
        await runner("prompt");
        expect((lastCall.model as {id: string}).id).toBe("judge-model");
        // One user message, no tools: a bounded classification, not a loop.
        expect(lastCall.context["tools"]).toBeUndefined();
        const messages = lastCall.context["messages"] as {
            role: string;
            content: {text: string}[];
        }[];
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("user");
        expect(messages[0].content[0].text).toBe("prompt");
        // pi-ai's own default is 0 retries; the judge restores 2.
        expect(lastCall.options?.["maxRetries"]).toBe(2);
        expect(lastCall.options?.["signal"]).toBeInstanceOf(AbortSignal);
    });

    it("fails at construction on a pin the catalog cannot resolve", async () => {
        catalog = [{id: "claude-fable-5"}];
        await expect(createJudgeRunner("judge-model")).rejects.toThrow(
            /not in Pi's anthropic catalog/,
        );
    });
});

describe("createDefaultProseRunner", () => {
    it("builds a runner on the pinned judge model", async () => {
        const runner = await createDefaultProseRunner();
        expect(runner).toBeDefined();
        await expect(runner!("prompt")).resolves.toBe("ok");
        expect((lastCall.model as {id: string}).id).toBe(
            PINNED_PROSE_JUDGE_MODEL,
        );
    });

    it("fails open (undefined, with a warning) when construction throws", async () => {
        catalog = [];
        const quiet = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        try {
            const runner = await createDefaultProseRunner();
            expect(runner).toBeUndefined();
            expect(quiet).toHaveBeenCalledWith(
                expect.stringContaining("judge unavailable"),
            );
        } finally {
            quiet.mockRestore();
        }
    });
});
