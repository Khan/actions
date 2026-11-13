import {execFile, spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import net from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {parse} from "yaml";

const execFileAsync = promisify(execFile);

type ActionYml = {
    inputs: Record<string, {default?: string}>;
    runs: {steps: Array<{run: string; env?: Record<string, string>}>};
};

// The real action, as published, so these tests can't drift from it.
const action = parse(
    readFileSync(path.join(__dirname, "action.yml"), "utf8"),
) as ActionYml;
const firstStep = action.runs.steps[0];
if (!firstStep) {
    throw new Error("harden-checkout has no steps to test");
}
const script = firstStep.run;

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("harden-checkout", () => {
    let dir: string;
    let githubEnv: string;

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "harden-checkout-"));
        githubEnv = path.join(dir, "github-env");
        writeFileSync(githubEnv, "");
    });

    afterEach(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    const runWithEnv = (env: Record<string, string | undefined>) =>
        spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
            input: script,
            encoding: "utf8",
            env: {PATH: process.env.PATH, GITHUB_ENV: githubEnv, ...env},
        });

    const run = (limit: string, time: string) =>
        runWithEnv({LOW_SPEED_LIMIT: limit, LOW_SPEED_TIME: time});

    it("wires each declared input, at its default, into the script", () => {
        // Arrange
        // What the runner does between the action's inputs and the step's
        // environment, which the other cases skip by setting it directly.
        const defaultByExpression = Object.fromEntries(
            Object.entries(action.inputs).map(([name, input]) => [
                `\${{ inputs.${name} }}`,
                input.default,
            ]),
        );
        const env = Object.fromEntries(
            Object.entries(firstStep.env ?? {}).map(([name, expression]) => [
                name,
                defaultByExpression[expression.trim()],
            ]),
        );

        // Act
        const result = runWithEnv(env);

        // Assert
        expect(readFileSync(githubEnv, "utf8")).toBe(
            "GIT_HTTP_LOW_SPEED_LIMIT=1000\nGIT_HTTP_LOW_SPEED_TIME=20\n",
        );
        expect(result.status).toBe(0);
    });

    it("exports both low-speed settings for later steps", () => {
        // Arrange

        // Act
        const result = run("1000", "20");

        // Assert
        expect(readFileSync(githubEnv, "utf8")).toBe(
            "GIT_HTTP_LOW_SPEED_LIMIT=1000\nGIT_HTTP_LOW_SPEED_TIME=20\n",
        );
        expect(result.status).toBe(0);
    });

    it.each([
        ["an empty limit", "", "20"],
        ["an empty time", "1000", ""],
        ["a zero limit", "0", "20"],
        ["a negative time", "1000", "-5"],
        ["a non-numeric limit", "fast", "20"],
        ["a limit with a leading zero", "01000", "20"],
        ["a limit carrying a command", "1000; echo pwned >&2", "20"],
        ["a time carrying a newline", "1000", "20\nFOO=bar"],
    ])("exports nothing, and does not fail, for %s", (_, limit, time) => {
        // Arrange

        // Act
        const result = run(limit, time);

        // Assert
        expect(readFileSync(githubEnv, "utf8")).toBe("");
        expect(result.status).toBe(0);
    });

    it("warns about a bad input", () => {
        // Arrange

        // Act
        const result = run("fast", "20");

        // Assert
        expect(result.stdout).toContain("::warning::");
    });

    // The point of the action: a transfer that stalls must abort, so that
    // actions/checkout's own retries get to run. A server that takes the
    // request and never answers stands in for the hung fetch.
    it.skipIf(!hasGit)(
        "makes git abort a stalled transfer",
        async () => {
            // Arrange
            const server = net.createServer(() => {
                // Accept the connection and say nothing back.
            });
            await new Promise<void>((resolve) =>
                server.listen(0, "127.0.0.1", resolve),
            );
            const {port} = server.address() as net.AddressInfo;
            run("1000", "2");
            const settings = Object.fromEntries(
                readFileSync(githubEnv, "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => line.split("=")),
            );
            const started = Date.now();

            // Act
            const result = await execFileAsync(
                "git",
                ["ls-remote", `http://127.0.0.1:${port}/repo.git`],
                {env: {PATH: process.env.PATH, ...settings}, timeout: 30_000},
            ).catch((error: {stderr: string}) => error);
            server.close();

            // Assert
            expect((result as {stderr: string}).stderr).toContain("too slow");
            expect(Date.now() - started).toBeLessThan(15_000);
        },
        40_000,
    );
});
