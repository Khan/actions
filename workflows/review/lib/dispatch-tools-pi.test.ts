import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, it, expect, vi} from "vitest";

import {plainExec} from "./dispatch-exec";
import {
    capOutput,
    createReviewTools,
    createSubmitTool,
    finalText,
    windowLines,
} from "./dispatch-tools-pi";

/**
 * The reviewer tool surface on its own: the read-only grants, the Read
 * window, the output caps, the submit_result contract-and-prose gate, and
 * the free-text final. Subprocesses run for real through plainExec; how the
 * surface is wired into a live loop (allowedTools, the follow-up redirect,
 * salvage) is dispatch-runner-pi.test.ts's ground.
 */

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

    it("windows a Read with offset and limit, keeping real line numbers", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-runner-"));
        const body = Array.from({length: 50}, (_, i) => `line ${i + 1}`).join(
            "\n",
        );
        writeFileSync(join(dir, "big.ts"), `${body}\n`);
        const read = createReviewTools(dir).find(
            (tool) => tool.name === "Read",
        );
        const result = await read?.execute("1", {
            path: "big.ts",
            offset: 10,
            limit: 3,
        });
        const text = result?.content[0].text ?? "";
        expect(text).toContain("line 10");
        expect(text).toContain("line 12");
        expect(text).not.toContain("line 13");
        // `cat -n` numbering survives the window: the model can anchor
        // findings on real line numbers, not window-relative ones.
        expect(text).toMatch(/10\tline 10/);
        expect(text).toContain("[showing lines 10-12 of 50]");
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

    it("reports a spawn failure as a failure, unlike a plain non-zero exit", async () => {
        // The classification boundary: grep's exit 1 (numeric code) is an
        // ordinary miss above; a binary that cannot start has no exit code
        // and IS a failure the model needs to see.
        const out = await plainExec(["definitely-not-a-real-binary-5f3a"], ".");
        expect(out).toMatch(/^command failed: /);
        expect(out).toContain("ENOENT");
    });

    it("never windows a failed Read: the error survives verbatim", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-runner-"));
        const read = createReviewTools(dir).find(
            (tool) => tool.name === "Read",
        );
        const result = await read?.execute("1", {
            path: "missing.ts",
            offset: 40,
            limit: 5,
        });
        const text = result?.content[0].text ?? "";
        // Windowing cat's stderr to line 40 would bury the error behind
        // "(no lines in window…)".
        expect(text).toContain("missing.ts");
        expect(text).toMatch(/No such file/);
        expect(text).not.toContain("no lines in window");
    });
});

describe("windowLines", () => {
    const numbered = "     1\ta\n     2\tb\n     3\tc\n     4\td\n";

    it("returns the text untouched when no window is asked for", () => {
        expect(windowLines(numbered)).toBe(numbered);
        expect(windowLines(numbered, undefined, undefined)).toBe(numbered);
    });

    it("slices from offset and notes what was left out", () => {
        expect(windowLines(numbered, 2, 2)).toBe(
            "     2\tb\n     3\tc\n[showing lines 2-3 of 4]",
        );
    });

    it("omits the note when the window covers the whole file", () => {
        expect(windowLines(numbered, 1, 100)).toBe(
            "     1\ta\n     2\tb\n     3\tc\n     4\td",
        );
    });

    it("says so when the offset is past the end of the file", () => {
        expect(windowLines(numbered, 99)).toBe(
            "(no lines in window: the file has 4 lines, offset was 99)",
        );
    });

    it("ignores non-numeric and non-positive window params", () => {
        expect(windowLines(numbered, "2", "1")).toBe(numbered);
        expect(windowLines(numbered, 0, -5)).toBe(numbered);
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

    it("bounces a style rejection to the author AFTER the contract accepts", async () => {
        const judged: Record<string, unknown>[] = [];
        let provisional: Record<string, unknown> | undefined;
        const tool = createSubmitTool(
            () => null,
            () => {
                throw new Error("must not accept a style-rejected payload");
            },
            {
                judgeProse: (payload) => {
                    judged.push(payload);
                    return Promise.resolve('quotes "delve"');
                },
                onProvisional: (payload) => {
                    provisional = payload;
                },
            },
        );
        const result = await tool.execute("1", {result: {findings: []}});
        expect(result.isError).toBe(true);
        // The judge's problems go back verbatim: the author rewrites.
        expect(result.content[0].text).toBe('quotes "delve"');
        expect(judged).toEqual([{findings: []}]);
        // The contract-valid payload is held for salvage while it bounces.
        expect(provisional).toEqual({findings: []});
    });

    it("accepts once the prose gate passes", async () => {
        let captured: Record<string, unknown> | undefined;
        const tool = createSubmitTool(
            () => null,
            (payload) => {
                captured = payload;
            },
            {judgeProse: () => Promise.resolve(null)},
        );
        const result = await tool.execute("1", {result: {findings: []}});
        expect(result.isError).toBeUndefined();
        expect(captured).toEqual({findings: []});
    });

    it("never judges a payload the contract already rejected", async () => {
        const judgeProse = vi.fn();
        const tool = createSubmitTool(
            () => "missing `findings`",
            () => {
                throw new Error("must not accept");
            },
            {judgeProse},
        );
        const result = await tool.execute("1", {result: {}});
        expect(result.isError).toBe(true);
        expect(judgeProse).not.toHaveBeenCalled();
    });

    it("counts every attempt BEFORE the contract check", async () => {
        let attempts = 0;
        const tool = createSubmitTool(
            () => "nope",
            () => undefined,
            {
                onAttempt: () => {
                    attempts += 1;
                },
            },
        );
        await tool.execute("1", {result: {}});
        await tool.execute("2", {result: {}});
        expect(attempts).toBe(2);
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
