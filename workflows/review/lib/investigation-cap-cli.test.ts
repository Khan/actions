import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

import {afterEach, describe, expect, it} from "vitest";

const CLI = resolve(__dirname, "investigation-cap.ts");
const COMMAND =
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON workflows/review/lib/investigation-cap.ts";
const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, {recursive: true, force: true});
    }
});

// Run the real entry point, with only its fixed review directory redirected.
// A preload updates node's builtin exports before the CLI imports them, so
// these subprocesses cannot touch another review's routing or journal.
const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-cli-"));
    dirs.push(dir);
    const preload = join(dir, "redirect.mjs");
    writeFileSync(
        preload,
        `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const root = '/tmp/gh-aw/review';
for (const key of ['existsSync', 'readFileSync', 'appendFileSync', 'mkdirSync']) {
    const original = fs[key];
    fs[key] = (path, ...args) => original(
        typeof path === 'string' && (path === root || path.startsWith(root + '/'))
            ? ${JSON.stringify(dir)} + path.slice(root.length) : path,
        ...args,
    );
}
syncBuiltinESMExports();`,
    );
    writeFileSync(
        join(dir, "routing.json"),
        JSON.stringify({
            runBudget: {maxToolCallsPerFinding: 1, maxTotalToolCalls: 2},
        }),
    );
    const run = (...args: string[]) =>
        spawnSync(
            process.execPath,
            [
                "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
                "--import",
                pathToFileURL(preload).href,
                ...args,
            ],
            {encoding: "utf8", timeout: 10_000},
        );
    return {dir, run};
};

describe("native investigation-cap CLI", () => {
    it("prints decisions, enforces both caps, and journals only allowed calls", () => {
        const {dir, run} = fixture();
        const first = run(CLI, "request", "finding-a");
        expect(first.error).toBeUndefined();
        expect(first.stderr).toBe("");
        expect(first.status).toBe(0);
        expect(JSON.parse(first.stdout)).toEqual({
            allowed: true,
            remainingForFinding: 1,
            remainingForRun: 2,
        });
        const refused = run(CLI, "request", "finding-a");
        expect(refused.status).toBe(1);
        expect(JSON.parse(refused.stdout)).toMatchObject({
            allowed: false,
            reason: "per-finding-cap-exceeded",
        });
        expect(run(CLI, "request", "finding-b").status).toBe(0);
        const total = run(CLI, "request", "finding-c");
        expect(total.status).toBe(1);
        expect(JSON.parse(total.stdout)).toMatchObject({
            allowed: false,
            reason: "run-total-cap-exceeded",
        });
        expect(
            readFileSync(join(dir, "investigation-journal.log"), "utf8"),
        ).toBe("finding-a\nfinding-b\n");
    });

    it("rejects invalid arguments instead of silently exiting successfully", () => {
        const {run} = fixture();
        const result = run(CLI);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("usage: investigation-cap.ts request");
        expect(result.stdout).toBe("");
    });

    it("imports without invoking the CLI", () => {
        const {run} = fixture();
        const result = run(
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(
                pathToFileURL(CLI).href,
            )}); console.log('imported');`,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("imported\n");
        expect(result.stderr).toBe("");
    });

    it("keeps all three reviewer commands on the tested native invocation", () => {
        const md = readFileSync(resolve(__dirname, "../review.md"), "utf8");
        const commands = md
            .split("\n")
            .filter((line) => line.includes("investigation-cap.ts request"));
        expect(commands).toEqual(
            Array(3).fill(`\`cd gh-aw-review-lib && ${COMMAND} request <id>\``),
        );
    });
});
