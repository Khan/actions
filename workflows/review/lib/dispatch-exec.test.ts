import {describe, it, expect} from "vitest";

import {makeSandboxedExec, shellQuote} from "./dispatch-exec";

/**
 * The subprocess seam on its own: argv quoting, the srt wrap, and the
 * credential scrub, each against stub wrappers. The runner-level tests
 * (dispatch-runner-pi.test.ts) cover the fail-closed init, the off switch,
 * and the policy handed to a real-shaped srt mock; here the unit is one
 * spawn.
 */

describe("shellQuote", () => {
    it("single-quotes each argv part", () => {
        expect(shellQuote(["grep", "-n", "a b"])).toBe("'grep' '-n' 'a b'");
    });

    it("escapes embedded single quotes", () => {
        expect(shellQuote(["echo", "it's"])).toBe("'echo' 'it'\\''s'");
    });

    it("round-trips through a real shell", async () => {
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            // Identity wrap: the command string srt would sandbox, run plain.
            wrapWithSandboxArgv: (command) =>
                Promise.resolve({argv: ["bash", "-c", command]}),
        });
        const out = await exec(["printf", "%s", "it's a 'quoted' $arg"], ".");
        expect(out).toBe("it's a 'quoted' $arg");
    });
});

describe("makeSandboxedExec", () => {
    it("hands srt the quoted command and the cwd, and spawns srt's argv", async () => {
        const seen: {command?: string; cwd?: string} = {};
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            wrapWithSandboxArgv: (command, _shell, _config, _signal, cwd) => {
                seen.command = command;
                seen.cwd = cwd;
                return Promise.resolve({argv: ["echo", "wrapped"]});
            },
        });
        const out = await exec(["printf", "hi"], "/tmp");
        expect(seen.command).toBe("'printf' 'hi'");
        expect(seen.cwd).toBe("/tmp");
        expect(out.trim()).toBe("wrapped");
    });

    it("spawns with the environment srt asks for", async () => {
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            wrapWithSandboxArgv: () =>
                Promise.resolve({
                    argv: ["bash", "-c", 'printf %s "$SRT_MARKER"'],
                    env: {...process.env, SRT_MARKER: "sandboxed"},
                }),
        });
        expect(await exec(["ignored"], ".")).toBe("sandboxed");
    });

    it("scrubs credentials from the subprocess environment", async () => {
        // The sandbox is a mount/network boundary, not an env boundary: srt's
        // env extends process.env, so without the scrub a prompt-injected
        // `env` through Bash reads every secret the runner holds.
        const exec = makeSandboxedExec({
            initialize: () => Promise.resolve(),
            wrapWithSandboxArgv: () =>
                Promise.resolve({
                    argv: [
                        "bash",
                        "-c",
                        'printf %s "${ANTHROPIC_API_KEY:-scrubbed}:${KEEP_ME:-lost}"',
                    ],
                    env: {
                        ...process.env,
                        ANTHROPIC_API_KEY: "sk-secret",
                        KEEP_ME: "kept",
                    },
                }),
        });
        expect(await exec(["ignored"], ".")).toBe("scrubbed:kept");
    });
});
