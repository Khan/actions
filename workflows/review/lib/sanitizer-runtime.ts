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

/** A comparison failure, not a bootstrap exception that may fail open. */
export class SanitizerUnavailableError extends Error {
    constructor() {
        super(
            "The pinned gh-aw sanitizer could not complete the submission comparison.",
        );
    }
}

/** RUNNER_TEMP is supplied by the host. There is no agent-configured module path. */
export const loadRunnerSanitizer = (
    runnerTemp = process.env.RUNNER_TEMP,
): SanitizerRuntime => {
    try {
        if (!runnerTemp || !isAbsolute(runnerTemp)) {
            throw new SanitizerUnavailableError();
        }
        const path = join(
            runnerTemp,
            "gh-aw/actions/sanitize_content_core.cjs",
        );
        const module = {exports: {}};
        // The upstream module expects github-script globals. Give its trusted
        // code a private logger and environment, without changing process globals
        // or printing review bodies/URLs into workflow-command-bearing stdout.
        // This context is dependency plumbing, not an untrusted-code sandbox.
        runInNewContext(
            readFileSync(path, "utf8"),
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
        const runtime = module.exports as SanitizerRuntime;
        for (const name of [
            "sanitizeContentCore",
            "sanitizeUrlProtocols",
            "sanitizeUrlDomains",
            "clearRedactedDomains",
        ] as const) {
            if (typeof runtime[name] !== "function") {
                throw new SanitizerUnavailableError();
            }
        }
        return runtime;
    } catch {
        throw new SanitizerUnavailableError();
    }
};
