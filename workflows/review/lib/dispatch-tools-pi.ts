/**
 * The reviewer tool surface for the Pi runner (dispatch-runner-pi.ts): Read
 * and Grep for investigation, Bash for the cap CLI, the `submit_result`
 * structured final with its prose gate, and the output caps. Split out of
 * dispatch-runner-pi.ts for file size, but the seam is a real one:
 * everything here defines what a sub-agent can DO with one tool call, and
 * knows nothing about providers or the agent loop. Every subprocess these
 * tools spawn goes through the injected {@link ToolExec} (dispatch-exec.ts),
 * which is what makes the sandbox policy total.
 */

import {plainExec, type ToolExec} from "./dispatch-exec";

/**
 * Per-tool-result output cap, in characters. A reviewer that greps a wide
 * pattern must not spend its whole context on one result. This value was a
 * measured variable of the re-anchoring A/B (it matches what the Claude Code
 * harness allowed its tools), so treat it as calibrated, not free: changing
 * it changes how the loop investigates.
 */
const MAX_TOOL_OUTPUT_CHARS = 30_000;

export type TextBlock = {type: "text"; text: string};

export type PiToolResult = {
    content: TextBlock[];
    details: Record<string, unknown>;
    isError?: boolean;
};

export type PiTool = {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
    ) => Promise<PiToolResult>;
};

/** Truncate a tool result, saying so, so the model knows it was cut. */
export const capOutput = (text: string): string =>
    text.length <= MAX_TOOL_OUTPUT_CHARS
        ? text
        : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[truncated: ${
              text.length - MAX_TOOL_OUTPUT_CHARS
          } more characters]`;

const ok = (text: string): PiToolResult => ({
    content: [{type: "text", text: capOutput(text)}],
    details: {},
});

/**
 * Window a `cat -n` capture to `limit` lines starting at the 1-indexed
 * `offset`, saying what was left out. The subprocess always reads the whole
 * file (the sandbox boundary lives on the subprocess, so the window is about
 * the model's view, not about I/O). Without this, a large file was silently
 * truncated at MAX_TOOL_OUTPUT_CHARS and its tail was unreachable — a recall
 * defect in a reviewer, not a nicety.
 */
export const windowLines = (
    text: string,
    offset?: unknown,
    limit?: unknown,
): string => {
    const start =
        typeof offset === "number" && offset > 0 ? Math.floor(offset) : 1;
    const max =
        typeof limit === "number" && limit > 0 ? Math.floor(limit) : undefined;
    if (start === 1 && max === undefined) {
        return text;
    }
    const lines = text.replace(/\n$/, "").split("\n");
    const total = lines.length;
    const window = lines.slice(
        start - 1,
        max === undefined ? undefined : start - 1 + max,
    );
    if (window.length === 0) {
        return `(no lines in window: the file has ${total} lines, offset was ${start})`;
    }
    const end = start + window.length - 1;
    const note =
        start > 1 || end < total
            ? `\n[showing lines ${start}-${end} of ${total}]`
            : "";
    return window.join("\n") + note;
};

const schema = (
    properties: Record<string, unknown>,
    required: string[],
): unknown => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
});

const str = (description: string): unknown => ({type: "string", description});

/**
 * The reviewer tool surface: Read and Grep for investigation, plus Bash (the
 * investigation-cap CLI the sub-agent prompts invoke runs through it). No
 * edit, no write — and with the sandboxed executor that is a mount-level
 * boundary on Bash too, not just a tool-surface promise.
 *
 * Deliberately small. Every tool here runs through the same sandboxed
 * executor as Bash, so a named tool earns its place on model ergonomics, not
 * on containment: Read gives windowed, line-numbered file views, and Grep's
 * structured params avoid the shell-quoting failure class (a model quoting a
 * regex into `bash -lc` botches it often enough to add noise). Two former
 * tools were removed as adding nothing over Bash: LS (`ls -la` verbatim) and
 * Glob, whose `find -path` emulation was wrong, not just limited (`*`
 * matched across `/`, so reviewers got a wider file list than they asked
 * for). Raised by mojadem on #305.
 */
export const createReviewTools = (
    cwd: string,
    exec: ToolExec = plainExec,
): PiTool[] => [
    {
        name: "Read",
        label: "Read",
        description:
            "Read a file from the repository. Returns the file with 1-indexed line numbers. Use offset and limit to window large files.",
        parameters: schema(
            {
                path: str("Path to the file, relative to the repository root."),
                offset: {
                    type: "number",
                    description: "1-indexed line number to start reading from.",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of lines to return.",
                },
            },
            ["path"],
        ),
        execute: async (_id, params, signal) => {
            const path = String(params["path"] ?? "");
            const out = await exec(["cat", "-n", "--", path], cwd, signal);
            // The exec seam resolves failures as ordinary text ("command
            // failed: …", or cat's own stderr). Never window those: slicing
            // an error message to an offset deep in a file the read never
            // opened masks the actual error behind "(no lines in window…)".
            const failed =
                out.startsWith("command failed: ") || /^\s*cat: /.test(out);
            return ok(
                failed
                    ? out
                    : windowLines(out, params["offset"], params["limit"]),
            );
        },
    },
    {
        name: "Grep",
        label: "Grep",
        description:
            "Search file contents with a regular expression. Returns matching lines prefixed with file:line.",
        parameters: schema(
            {
                pattern: str("Extended regular expression to search for."),
                path: str("Optional directory or file to scope the search to."),
            },
            ["pattern"],
        ),
        execute: async (_id, params, signal) => {
            const pattern = String(params["pattern"] ?? "");
            const path = String(params["path"] ?? ".");
            return ok(
                await exec(
                    [
                        "grep",
                        "-rIn",
                        "--exclude-dir=.git",
                        "-E",
                        "--",
                        pattern,
                        path,
                    ],
                    cwd,
                    signal,
                ),
            );
        },
    },
    {
        name: "Bash",
        label: "Bash",
        description:
            "Run a shell command in the repository. Use for the investigation-cap CLI, listing or finding files, and other read-only checks. Commands run inside an OS sandbox: the repository is read-only and there is no network access.",
        parameters: schema({command: str("The shell command to run.")}, [
            "command",
        ]),
        execute: async (_id, params, signal) => {
            const command = String(params["command"] ?? "");
            return ok(await exec(["bash", "-lc", command], cwd, signal));
        },
    },
];

/**
 * The structured-final tool: the payload is validated by `request.validate`
 * BEFORE it is accepted, and a drifted shape bounces back to the model with
 * the exact rejection message while the session is still alive.
 *
 * The prose gate (judge-prose.ts) runs AFTER the contract check: the judge
 * only ever sees payloads the collection phase could accept, and its
 * rejection bounces to the AUTHOR the same way a contract rejection does
 * (the plain-prose loop: the pinned judge model scores, the author rewrites
 * in-session with its repo context intact). The gate caps its own bounces
 * and fails open, and `onProvisional` hands the caller the last
 * CONTRACT-VALID payload before the style verdict, so a session that dies
 * mid-bounce salvages the pre-style payload: style enforcement may cost
 * prose quality, never a dimension.
 */
export const createSubmitTool = (
    validate: (payload: Record<string, unknown>) => string | null,
    onAccept: (payload: Record<string, unknown>) => void,
    hooks: {
        judgeProse?: (
            payload: Record<string, unknown>,
        ) => Promise<string | null>;
        /** The last contract-valid payload, held while the prose gate bounces. */
        onProvisional?: (payload: Record<string, unknown>) => void;
        /**
         * Every call, counted BEFORE the contract check: the follow-up
         * redirect's reason branches on whether the tool was ever called (a
         * bounced agent is mid-correction, not undelivered).
         */
        onAttempt?: () => void;
    } = {},
): PiTool => ({
    name: "submit_result",
    label: "submit_result",
    description:
        "Deliver your final structured result. Pass the entire output-contract JSON object as `result`.",
    parameters: schema(
        {
            result: {
                type: "object",
                description: "The full output-contract object.",
            },
        },
        ["result"],
    ),
    execute: async (_id, params) => {
        hooks.onAttempt?.();
        const payload = (params["result"] ?? {}) as Record<string, unknown>;
        const rejection = validate(payload);
        if (rejection !== null) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Result rejected: ${rejection}. Call submit_result again with the full corrected result object.`,
                    },
                ],
                details: {},
                isError: true,
            };
        }
        hooks.onProvisional?.(payload);
        if (hooks.judgeProse !== undefined) {
            const styleRejection = await hooks.judgeProse(payload);
            if (styleRejection !== null) {
                return {
                    content: [{type: "text" as const, text: styleRejection}],
                    details: {},
                    isError: true,
                };
            }
        }
        onAccept(payload);
        return {
            content: [
                {
                    type: "text" as const,
                    text: "Result recorded. End the turn now; no further output is needed.",
                },
            ],
            details: {},
        };
    },
});

/**
 * The free-text final, for a request with no output contract (the eval path:
 * `LiveAgentRequest` carries no `validate`, so `submit_result` is never
 * registered and the agent falls back to free text).
 *
 * Pi emits one assistant message per turn, so the final is not simply the
 * last one: a reviewer that emitted its JSON and then added a closing
 * sentence would lose the JSON, which is exactly how run 30592964392's
 * candidate arm failed. Prefer the last turn that actually carries a JSON
 * object, and fall back to the whole transcript's assistant text so a
 * downstream extractor can still find it.
 */
export const finalText = (texts: string[]): string => {
    for (let i = texts.length - 1; i >= 0; i -= 1) {
        if (texts[i].includes("{") && texts[i].includes("}")) {
            return texts[i];
        }
    }
    return texts.join("\n");
};
