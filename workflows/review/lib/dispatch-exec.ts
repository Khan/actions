/**
 * The tool-subprocess seam for the Pi runner (dispatch-runner-pi.ts): one
 * argv in, combined output out, and the OS sandbox that wraps it
 * (`@anthropic-ai/sandbox-runtime`, the engine behind Claude Code's own
 * sandbox: bubblewrap on Linux, Seatbelt on macOS). Split out of
 * dispatch-runner-pi.ts for file size, but the seam is a real one:
 * everything here is about spawning one command under the sandbox policy,
 * and knows nothing about tools, models, or the agent loop. The policy
 * itself ({@link SANDBOX_CONFIG}) and the fail-closed contract
 * ({@link createToolExec}) live here beside the code that enforces them.
 */

import {execFile} from "node:child_process";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";

/** Per-tool-call wall clock. The whole-agent cap is `request.timeoutMs`. */
const BASH_TIMEOUT_MS = 120_000;

/**
 * The OS sandbox around every tool subprocess. The runner process itself
 * stays OUTSIDE it (the loop must reach the model provider); only the
 * commands the model asks for are wrapped.
 *
 * The policy, line by line:
 *
 *  - Network deny-all. The tools investigate a checkout; none of them needs
 *    the network, and model traffic leaves from the runner process, not from
 *    a tool. In production this stacks INSIDE the awf firewall rather than
 *    replacing it; in the eval (a bare runner VM with the real API key in
 *    the environment) it is the only network boundary the tools have.
 *
 *  - Checkout read-only. "Reviewers never get edit or write" used to be a
 *    tool-surface promise that Bash could bypass (`echo > file`); read-only
 *    makes it a boundary. A prompt-injected reviewer cannot poison the
 *    checkout its sibling reviewers are reading, nor the staged inputs and
 *    outputs downstream phases trust (`routing.json`, `out/`).
 *
 *  - The investigation-cap journal is the ONE writable path in the review
 *    staging dir: the cap CLI appends one line per authorised call
 *    (investigation-cap.ts), and refusing that write would break the cap.
 *    `routing.json` (the caps) stays read-only.
 *
 *  - A scratch directory for the model's own use; nothing downstream reads
 *    from it.
 *
 * Fail-closed: when the sandbox cannot initialize (bubblewrap missing, user
 * namespaces blocked in a nested container), {@link createPiRunner} THROWS
 * rather than silently running unsandboxed. `REVIEW_SANDBOX=off` is the
 * explicit, logged escape hatch; in production the awf firewall still stands
 * around an unsandboxed runner, so "off" degrades to exactly the pre-srt
 * posture rather than to nothing.
 */
const REVIEW_SANDBOX_ENV = "REVIEW_SANDBOX";

/**
 * The one writable file in the staging dir; see investigation-cap.ts.
 * Exported so the sandbox smoke job can assert the mount actually works
 * rather than trusting that it does.
 */
export const CAP_JOURNAL_PATH = "/tmp/gh-aw/review/investigation-journal.log";

/** Model-usable scratch space; nothing downstream reads from it. */
export const SCRATCH_DIR = "/tmp/review-agent-scratch";

const SANDBOX_CONFIG = {
    network: {allowedDomains: [], deniedDomains: ["*"]},
    filesystem: {
        denyRead: ["~/.ssh"],
        allowWrite: [CAP_JOURNAL_PATH, SCRATCH_DIR],
        denyWrite: [],
    },
};

/**
 * One tool subprocess: argv in, combined output out. This is the seam the OS
 * sandbox wraps — every tool below runs its command through an injected
 * executor, so the sandboxed and unsandboxed paths differ ONLY in how the
 * argv is spawned, never in what the tools do.
 */
export type ToolExec = (
    argv: string[],
    cwd: string,
    signal?: AbortSignal,
) => Promise<string>;

/**
 * Spawn one argv, resolving with its combined output. A non-zero exit is
 * NOT an error here: `grep` exits 1 on no-match, and the model needs to see
 * "no matches" as an ordinary result rather than a tool failure.
 */
const spawn = (
    argv: string[],
    cwd: string,
    env: Record<string, string | undefined> | undefined,
    signal?: AbortSignal,
): Promise<string> =>
    new Promise((resolve) => {
        execFile(
            argv[0],
            argv.slice(1),
            {
                cwd,
                signal,
                ...(env !== undefined ? {env} : {}),
                timeout: BASH_TIMEOUT_MS,
                maxBuffer: 64 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                const out = `${stdout}${stderr}`;
                // A plain non-zero exit carries a numeric `code` and is an
                // ordinary result: `grep` exits 1 on no-match, and reporting
                // that as a failure would tell the model its toolbox is
                // broken when the honest answer is "nothing matched". A
                // kill (timeout, signal) or a spawn error has no exit code
                // and IS a failure the model needs to see.
                const failed = error !== null && typeof error.code !== "number";
                if (failed) {
                    resolve(`command failed: ${error.message}`);
                    return;
                }
                resolve(out.trim() === "" ? "(no output)" : out);
            },
        );
    });

/** The unsandboxed executor: exactly the pre-srt behavior. */
export const plainExec: ToolExec = (argv, cwd, signal) =>
    spawn(argv, cwd, undefined, signal);

/**
 * POSIX single-quote each part so an argv survives the shell round-trip
 * through the sandbox wrapper (srt takes a command STRING and returns the
 * bwrap/seatbelt argv to spawn).
 */
export const shellQuote = (argv: string[]): string =>
    argv.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");

/** What this runner needs from srt's `SandboxManager`. */
type SandboxWrapper = {
    initialize: (config: unknown) => Promise<void>;
    wrapWithSandboxArgv: (
        command: string,
        binShell?: string,
        customConfig?: unknown,
        abortSignal?: AbortSignal,
        cwd?: string,
    ) => Promise<{
        argv: string[];
        env?: Record<string, string | undefined>;
    }>;
};

/**
 * The sandboxed executor: quote the argv back into a command string, have
 * srt wrap it in the platform sandbox, and spawn the wrapped argv with the
 * environment srt asks for.
 */
/**
 * Credentials scrubbed from every sandboxed tool subprocess. The sandbox is a
 * mount/network boundary, not an environment boundary: spawn defaults to
 * process.env and srt's returned env extends it, so without this a
 * prompt-injected `env` through Bash reads every secret the runner holds.
 * Model traffic leaves from the runner process, so no tool needs a
 * credential.
 */
export const SCRUBBED_ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_MCP_SERVER_TOKEN",
    "MCP_GATEWAY_API_KEY",
] as const;

const scrubSecrets = (
    env: Record<string, string | undefined>,
): Record<string, string | undefined> => {
    const out = {...env};
    for (const key of SCRUBBED_ENV_KEYS) {
        delete out[key];
    }
    return out;
};

export const makeSandboxedExec =
    (sandbox: SandboxWrapper): ToolExec =>
    async (argv, cwd, signal) => {
        const wrapped = await sandbox.wrapWithSandboxArgv(
            shellQuote(argv),
            undefined,
            undefined,
            signal,
            cwd,
        );
        return spawn(
            wrapped.argv,
            cwd,
            scrubSecrets(wrapped.env ?? process.env),
            signal,
        );
    };

/**
 * The tool executor production runs: srt-wrapped, or the explicit unwrapped
 * escape hatch. Fail-closed — an initialization failure throws rather than
 * degrading to unsandboxed tools; `REVIEW_SANDBOX=off` is the loud opt-out.
 *
 * Exported for the sandbox smoke job (review-eval-ab), which probes the
 * boundary through this exact function. A probe that built its own sandbox
 * would be testing a second policy, and the only interesting question is
 * whether THIS one holds.
 */
/**
 * Caller additions to the sandbox policy. `denyRead` extends the read denial:
 * the eval passes its own repo root, because the runner VM has this repo
 * checked out and a reviewer that searches the filesystem finds the eval
 * corpus (each case's must-catch spec), the matcher, and the contracts
 * source. Run 33795650180's gemini correctness-reviewer did exactly that
 * (`find / -name investigation-cap.ts`, then read the case's own case.json
 * and live-match.ts), so the eval's answer key was reachable on every run.
 * Production passes nothing: the lib checkout beside the PR is what the
 * reviewer prompts invoke the cap CLI from.
 */
export type SandboxOptions = {
    denyRead?: readonly string[];
};

export const createToolExec = async (
    sandbox: SandboxOptions = {},
): Promise<ToolExec> => {
    if (process.env[REVIEW_SANDBOX_ENV] === "off") {
        // eslint-disable-next-line no-console
        console.error(
            "review dispatch: tool sandbox OFF (REVIEW_SANDBOX=off); tool subprocesses run unwrapped.",
        );
        return plainExec;
    }
    const srt = (await import("@anthropic-ai/sandbox-runtime")) as {
        SandboxManager: SandboxWrapper;
    };
    try {
        // Pre-create the writable bind targets so the sandbox can mount
        // them: the cap journal may not exist yet on a fresh run, and
        // its first append must not be the thing that fails.
        mkdirSync(SCRATCH_DIR, {recursive: true});
        mkdirSync(dirname(CAP_JOURNAL_PATH), {recursive: true});
        if (!existsSync(CAP_JOURNAL_PATH)) {
            writeFileSync(CAP_JOURNAL_PATH, "");
        }
        await srt.SandboxManager.initialize({
            ...SANDBOX_CONFIG,
            filesystem: {
                ...SANDBOX_CONFIG.filesystem,
                denyRead: [
                    ...SANDBOX_CONFIG.filesystem.denyRead,
                    ...(sandbox.denyRead ?? []),
                ],
            },
        });
    } catch (error) {
        throw new Error(
            `the review tool sandbox failed to initialize; refusing to ` +
                `run sub-agents with unsandboxed tools (set ` +
                `${REVIEW_SANDBOX_ENV}=off to explicitly accept that): ${
                    error instanceof Error ? error.message : String(error)
                }`,
        );
    }
    return makeSandboxedExec(srt.SandboxManager);
};
