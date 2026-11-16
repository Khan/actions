/** Load only gh-aw's pinned, agent-read-only host runtime, never the workspace. */
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {isAbsolute, join} from "node:path";
import {runInNewContext} from "node:vm";
import {URL} from "node:url";

export type SanitizerRuntime = {
    sanitizeContentCore: (text: string) => string;
    sanitizeUrlProtocols: (text: string) => string;
    sanitizeUrlDomains: (text: string, allowed: string[]) => string;
    clearRedactedDomains: () => void;
};

/** Safe diagnostics only: never attach raw exceptions, paths, or input text. */
export type SanitizerFailureCategory =
    | "config"
    | "missing"
    | "module-load"
    | "exports"
    | "invocation";

/** A comparison failure, not a bootstrap exception that may fail open. */
export class SanitizerUnavailableError extends Error {
    constructor(readonly category: SanitizerFailureCategory) {
        super(`The pinned gh-aw sanitizer is unavailable (${category}).`);
        this.name = "SanitizerUnavailableError";
    }
}

/** RUNNER_TEMP is supplied by the host. There is no agent-configured module path. */
export const loadRunnerSanitizer = (
    runnerTemp = process.env.RUNNER_TEMP,
): SanitizerRuntime => {
    if (!runnerTemp || !isAbsolute(runnerTemp)) {
        throw new SanitizerUnavailableError("config");
    }
    const path = join(runnerTemp, "gh-aw/actions/sanitize_content_core.cjs");
    let source: string;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        throw new SanitizerUnavailableError(
            error instanceof Error && "code" in error && error.code === "ENOENT"
                ? "missing"
                : "module-load",
        );
    }
    const module = {exports: {}};
    try {
        // The upstream module expects github-script globals. Give its trusted
        // code a private logger and environment, without changing process globals
        // or printing review bodies/URLs into workflow-command-bearing stdout.
        // This context is dependency plumbing, not an untrusted-code sandbox.
        runInNewContext(
            source,
            {
                module,
                exports: module.exports,
                require: createRequire(path),
                process: {env: {...process.env}},
                URL,
                core: {info() {}, debug() {}, warning() {}},
            },
            {filename: path, timeout: 1000},
        );
    } catch {
        throw new SanitizerUnavailableError("module-load");
    }
    try {
        const runtime = module.exports as SanitizerRuntime;
        for (const name of [
            "sanitizeContentCore",
            "sanitizeUrlProtocols",
            "sanitizeUrlDomains",
            "clearRedactedDomains",
        ] as const) {
            if (typeof runtime[name] !== "function") {
                throw new SanitizerUnavailableError("exports");
            }
        }
        return runtime;
    } catch {
        throw new SanitizerUnavailableError("exports");
    }
};
