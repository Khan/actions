import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {
    TRIM_CHARS,
    toolCallIndex,
    trimMessage,
    writeTranscript,
    type TranscriptMessage,
} from "./transcripts";

const long = "x".repeat(TRIM_CHARS + 500);

const MESSAGES: TranscriptMessage[] = [
    {
        role: "assistant",
        content: [
            {type: "thinking", thinking: long},
            {type: "text", text: "Looking at the diff."},
            {
                type: "tool_use",
                id: "t1",
                name: "Read",
                input: {file_path: "/stage/case/context/pr.diff"},
            },
            {
                type: "tool_use",
                id: "t2",
                name: "Glob",
                input: {pattern: "**/case.json", path: "/"},
            },
        ],
    },
    {
        role: "user",
        content: [
            {type: "tool_result", tool_use_id: "t1", content: long},
            {
                type: "tool_result",
                tool_use_id: "t2",
                content: [{type: "text", text: long}],
            },
        ],
    },
    {role: "assistant", content: [{type: "text", text: '{"findings":[]}'}]},
];

describe("toolCallIndex", () => {
    it("lists one line per tool call with its arguments whole", () => {
        expect(toolCallIndex(MESSAGES)).toEqual([
            'Read file_path="/stage/case/context/pr.diff"',
            'Glob pattern="**/case.json" path="/"',
        ]);
    });
});

describe("trimMessage", () => {
    it("trims text, thinking, and tool results, recording the cut", () => {
        const [assistant, user] = MESSAGES.map(trimMessage);
        const blocks = assistant!.content as Record<string, unknown>[];
        expect(blocks[0]!["thinking"]).toMatch(
            /\[trimmed 500 more characters\]$/,
        );
        expect(blocks[1]!["text"]).toBe("Looking at the diff.");
        // Tool-call inputs are never trimmed.
        expect(blocks[2]!["input"]).toEqual({
            file_path: "/stage/case/context/pr.diff",
        });
        const results = user!.content as Record<string, unknown>[];
        expect(results[0]!["content"]).toMatch(/\[trimmed 500 more/);
        const nested = results[1]!["content"] as Record<string, unknown>[];
        expect(nested[0]!["text"]).toMatch(/\[trimmed 500 more/);
    });

    it("leaves a string or non-array body alone apart from trimming", () => {
        expect(trimMessage({role: "user", content: "hi"})).toEqual({
            role: "user",
            content: "hi",
        });
        expect(trimMessage({role: "user", content: 7})).toEqual({
            role: "user",
            content: 7,
        });
    });
});

describe("writeTranscript", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "transcripts-"));
    });
    afterAll(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    it("writes <dir>/<stage>/<case>/<agent>-<attempt>.json with the index on top", () => {
        const file = writeTranscript(dir, ["candidate", "case-1"], {
            agent: "correctness-reviewer",
            model: "claude-opus-4-6",
            attempt: 2,
            deniedReads: 1,
            deniedTools: 0,
            messages: MESSAGES,
        });
        expect(file).toBe(
            join(dir, "candidate", "case-1", "correctness-reviewer-2.json"),
        );
        const body = JSON.parse(readFileSync(file, "utf8"));
        expect(Object.keys(body)).toEqual([
            "agent",
            "model",
            "attempt",
            "toolCallIndex",
            "toolCalls",
            "deniedReads",
            "deniedTools",
            "messages",
        ]);
        expect(body.toolCalls).toBe(2);
        expect(body.deniedReads).toBe(1);
        expect(body.messages).toHaveLength(3);
        expect(JSON.stringify(body)).not.toContain(long);
    });

    it("sanitizes label and agent names into path segments", () => {
        const file = writeTranscript(dir, ["a/b", "c d"], {
            agent: "x:y",
            model: "m",
            attempt: 1,
            deniedReads: 0,
            deniedTools: 0,
            messages: [],
        });
        expect(file).toBe(join(dir, "a_b", "c_d", "x_y-1.json"));
    });
});
