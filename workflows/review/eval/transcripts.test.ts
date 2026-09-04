import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {tokenTotals, writeTranscript} from "./transcripts";

describe("writeTranscript", () => {
    it("indexes every tool call and counts the distinct ones", () => {
        const dir = mkdtempSync(join(tmpdir(), "transcripts-"));
        const read = (path: string) => ({
            role: "assistant",
            content: [{type: "toolCall", name: "Read", arguments: {path}}],
        });
        const path = writeTranscript(
            "case/one",
            {
                name: "correctness-reviewer",
                model: "gemini-3.8-flash",
                cwd: "/tmp/case",
                messages: [
                    read("a.ts"),
                    {
                        role: "toolResult",
                        toolName: "Read",
                        content: [{type: "text", text: "x".repeat(5000)}],
                    },
                    read("a.ts"),
                    read("b.ts"),
                ],
                turns: 3,
                toolCalls: 3,
                usd: 0.5,
                wallMs: 1000,
                ended: "submitted",
            },
            dir,
        );
        expect(path).toBe(join(dir, "case_one", "correctness-reviewer.json"));
        const written = JSON.parse(readFileSync(path, "utf8"));
        // 3 calls, 2 distinct: the loop-vs-exploration signal.
        expect(written.toolCalls).toBe(3);
        expect(written.distinctToolCalls).toBe(2);
        expect(written.toolCallIndex).toEqual([
            'Read path="a.ts"',
            'Read path="a.ts"',
            'Read path="b.ts"',
        ]);
        // Long tool results are trimmed and say so.
        expect(written.messages[1].content[0].text).toMatch(
            /\[trimmed 3000 more characters\]$/,
        );
        // Tool-call arguments are kept whole.
        expect(written.messages[0].content[0].arguments).toEqual({
            path: "a.ts",
        });
    });
});

describe("tokenTotals", () => {
    it("sums every assistant turn's usage and ignores tool results", () => {
        const totals = tokenTotals([
            {
                role: "assistant",
                content: [],
                usage: {
                    input: 1000,
                    output: 50,
                    reasoning: 400,
                    cacheRead: 800,
                    cacheWrite: 0,
                },
            },
            {role: "toolResult", content: [], usage: {input: 999999}},
            {
                role: "assistant",
                content: [],
                usage: {
                    input: 1200,
                    output: 70,
                    reasoning: 300,
                    cacheRead: 900,
                    cacheWrite: 100,
                },
            },
            {role: "assistant", content: []},
        ]);
        expect(totals).toEqual({
            input: 2200,
            output: 120,
            reasoning: 700,
            cacheRead: 1700,
            cacheWrite: 100,
        });
    });
});
