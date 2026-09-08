/**
 * The eval reviewer's toolset against production's. They differ on purpose
 * today (production keeps LS and Bash for the investigation-cap CLI, plus
 * the in-process submit_result tool it pushes on after the literal; the eval
 * has no shell so the corpus stays unreadable), and this pins the difference
 * to exactly that set so the promised production follow-up cannot leave the
 * two lists silently divergent in some other way. Both the literal and every
 * `allowedTools.push("...")` are read, since the push is how production
 * already adds a tool and is how a next one would arrive.
 */

import {readFileSync} from "node:fs";

import {describe, expect, it} from "vitest";

import {READ_TOOL_POLICY, READ_TOOLS, SCOPE_RULE_VERSION} from "./read-scope";

const dispatchRunner = readFileSync(
    new URL("../lib/dispatch-runner.ts", import.meta.url),
    "utf8",
);

describe("the eval toolset vs production's", () => {
    it("production's allowedTools is the eval's read tools plus exactly LS, Bash, and submit_result", () => {
        const match = /const allowedTools = \[([^\]]*)\]/.exec(dispatchRunner);
        expect(match).not.toBeNull();
        const pushed = [
            ...dispatchRunner.matchAll(/allowedTools\.push\(\s*"([^"]+)"/g),
        ].map((m) => m[1]!);
        expect(pushed).toEqual(["mcp__review__submit_result"]);
        const prod = [
            ...match![1]!
                .split(",")
                .map((t) => t.trim().replaceAll('"', ""))
                .filter((t) => t !== ""),
            ...pushed,
        ];
        const extra = prod.filter(
            (t) => !(READ_TOOLS as readonly string[]).includes(t),
        );
        const missing = READ_TOOLS.filter((t) => !prod.includes(t));
        expect(missing).toEqual([]);
        expect(extra.sort()).toEqual([
            "Bash",
            "LS",
            "mcp__review__submit_result",
        ]);
    });

    it("production does not set `tools`, so its reachable set is wider than its allowedTools", () => {
        // The comparison above is on the pre-approval list. Under
        // bypassPermissions only `tools` restricts what the model can reach,
        // and production does not set it (that follow-up is out of this
        // PR's scope). The day it does, this goes red and the comparison
        // above starts describing the reachable set, not just the list.
        const start = dispatchRunner.indexOf(
            "const options: Record<string, unknown> = {",
        );
        const literal = dispatchRunner.slice(
            start,
            dispatchRunner.indexOf("\n        };", start),
        );
        expect(/^\s*tools:/m.test(literal)).toBe(false);
        expect(literal).toContain('permissionMode: "bypassPermissions"');
        // Nor added after the literal, the way allowedTools gets a push.
        expect(/options\[?["']?tools["']?\]?\s*=/.test(dispatchRunner)).toBe(
            false,
        );
    });

    it("stamps the toolset and the scope-rule version on the ruler", () => {
        expect(READ_TOOL_POLICY).toBe(
            `read-scoped:v${SCOPE_RULE_VERSION}:Read,Grep,Glob`,
        );
    });
});
