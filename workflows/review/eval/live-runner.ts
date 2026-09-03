/**
 * The production {@link LiveAgentRunner}: dispatch one sub-agent as a bounded
 * agentic loop via the Claude Agent SDK, plus a CLI smoke entry point
 * (`live-ab-plan.md` Phase 2c).
 *
 * This is the ONLY module in the eval suite that talks to a real model
 * runtime. `live-producer.ts` stays SDK-free behind its runner seam, so unit
 * tests never load this file.
 *
 * Tool policy: read-only investigation (Read/Grep/Glob), cwd pinned to the
 * staged checkout, reads scoped to the staged case. `tools` restricts the
 * toolset (the SDK's `allowedTools` only pre-approves, so on its own under
 * `bypassPermissions` every default tool, Bash included, stayed available),
 * and a PreToolUse hook denies any read that resolves outside the case's
 * stage dir. The eval runs on a machine that also holds this repo, and this
 * repo holds the corpus and the scorer; a reviewer that reads across is
 * scoring itself (see read-scope.ts). The investigation-cap CLI the prompts
 * mention is not runnable under this policy; the prompts' own fallback
 * applies (a denied budget request stops investigation, findings still
 * report).
 *
 * Every dispatch writes a transcript (see transcripts.ts) so the
 * investigation can be read, not just counted.
 *
 * Run one case end to end (requires ANTHROPIC_API_KEY):
 *
 *   pnpm dlx tsx workflows/review/eval/live-runner.ts --case <case-id>
 *     [--review-md workflows/review/review.md] [--stage-root /tmp/review-live]
 *     [--transcripts-dir /tmp/review-transcripts]
 *
 * Prove the read scope bites (one cheap Haiku call, exits non-zero if an
 * out-of-scope read went through; CI runs this before every live A/B):
 *
 *   pnpm dlx tsx workflows/review/eval/live-runner.ts --probe-read-scope
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";

import {query, type HookCallback} from "@anthropic-ai/claude-agent-sdk";

import {extractAgents} from "./agent-extract";
import {loadLiveCorpus} from "./corpus/loader";
import {
    produceLive,
    type LiveAgentRequest,
    type LiveAgentRunner,
} from "./live-producer";
import {usageOfResultMessage, type ModelTokens} from "../lib/pricing";
import {outOfScopeRead, READ_SCOPE_REASON, READ_TOOLS} from "./read-scope";
import {
    DEFAULT_TRANSCRIPTS_DIR,
    writeTranscript,
    type TranscriptMessage,
} from "./transcripts";

/** Read-only investigation tools; see the module doc for the rationale. */
const ALLOWED_TOOLS = [...READ_TOOLS];

export {DEFAULT_TRANSCRIPTS_DIR};

export type SdkRunnerOptions = {
    /**
     * Where transcripts are written; `false` disables them. Defaults to
     * {@link DEFAULT_TRANSCRIPTS_DIR}, outside the staging root.
     */
    transcriptsDir?: string | false;
};

/**
 * The transcript label for a request: the last two segments of the staged
 * case root (`<stage>/<case-id>` as live-ab and live-runner lay it out), so
 * one run's transcripts group by arm and case.
 */
const transcriptLabel = (request: LiveAgentRequest): string[] => [
    basename(dirname(request.readRoot)),
    basename(request.readRoot),
];

/**
 * Build the SDK-backed runner. Each request becomes one `query()` run: the
 * agent's prompt, its pinned model, the staged checkout as cwd, hard turn and
 * wall-clock caps, and cost/turn accounting read off the result message.
 */
export const sdkRunner = (options: SdkRunnerOptions = {}): LiveAgentRunner => {
    const transcriptsDir =
        options.transcriptsDir === undefined
            ? DEFAULT_TRANSCRIPTS_DIR
            : options.transcriptsDir;
    // Attempt counter per (label, agent): the contract-parse retry dispatches
    // the same agent twice on one case, and both transcripts must survive.
    const attempts = new Map<string, number>();
    return async (request) => runOnce(request, transcriptsDir, attempts);
};

const runOnce = async (
    request: LiveAgentRequest,
    transcriptsDir: string | false,
    attempts: Map<string, number>,
) => {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => {
        abort.abort(
            new Error(`sub-agent timed out after ${request.timeoutMs}ms`),
        );
    }, request.timeoutMs);
    let deniedReads = 0;
    // The read-scope hook: deny (and count) any Read/Grep/Glob whose path
    // resolves outside the staged case. A hook decision runs ahead of the
    // permission mode, so `bypassPermissions` does not override it.
    const scopeReads: HookCallback = async (input) => {
        if (input.hook_event_name !== "PreToolUse") {
            return {continue: true};
        }
        const target = outOfScopeRead(
            input.tool_name,
            input.tool_input,
            request.readRoot,
            request.cwd,
        );
        if (target === undefined) {
            return {continue: true};
        }
        deniedReads += 1;
        return {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: READ_SCOPE_REASON(
                    request.readRoot,
                    target,
                ),
            },
        };
    };
    const messages: TranscriptMessage[] = [];
    const label = transcriptLabel(request);
    const attemptKey = [...label, request.name].join("/");
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    attempts.set(attemptKey, attempt);
    try {
        const run = query({
            prompt: request.prompt,
            options: {
                cwd: request.cwd,
                model: request.model,
                maxTurns: request.maxTurns,
                tools: ALLOWED_TOOLS,
                allowedTools: ALLOWED_TOOLS,
                permissionMode: "bypassPermissions",
                hooks: {PreToolUse: [{hooks: [scopeReads]}]},
                abortController: abort,
                // Pinned for the same reason as lib/dispatch-runner.ts: this
                // arm is the production baseline the harness A/B compares
                // against, so its reasoning budget must not drift from what
                // production dispatch runs.
                effort: "high",
            },
        });
        let output = "";
        let usd = 0;
        let usage: ModelTokens[] | undefined;
        let turns = 0;
        let toolCalls = 0;
        let stopReason: string | undefined;
        let errorMessage: string | undefined;
        let tokensAtFailure: {input: number; total: number} | undefined;
        for await (const message of run) {
            // The transcript: every assistant message (text, thinking, tool
            // calls) and every user message (tool results), in order.
            if (message.type === "assistant" || message.type === "user") {
                const inner = (
                    message as unknown as {
                        message?: {role?: string; content?: unknown};
                    }
                ).message;
                if (inner !== undefined) {
                    messages.push({
                        role: inner.role ?? message.type,
                        content: inner.content,
                    });
                }
            }
            // Count the SDK arm's tool calls so the harness comparison has the
            // same investigation-depth signal on both sides. A `tool_use`
            // block in an assistant message is one call; the SDK's result
            // record does not carry a count.
            if (message.type === "assistant") {
                const inner = (
                    message as unknown as {
                        message?: {
                            content?: {type?: string}[];
                            stop_reason?: string | null;
                        };
                    }
                ).message;
                // The stop reason of the LAST assistant message. An empty
                // final plus a non-"end_turn" stop reason is how a refusal
                // presents; without it an empty result is indistinguishable
                // from a dropped one.
                if (typeof inner?.stop_reason === "string") {
                    stopReason = inner.stop_reason;
                }
                // Token counts on the last assistant message: the
                // discriminator between an overloaded provider and a prompt
                // that outgrew the context window.
                const usage = (
                    inner as unknown as {
                        usage?: {input_tokens?: number; output_tokens?: number};
                    }
                )?.usage;
                if (usage !== undefined) {
                    const input = Number(usage.input_tokens ?? 0);
                    tokensAtFailure = {
                        input,
                        total: input + Number(usage.output_tokens ?? 0),
                    };
                }
                const blocks = inner?.content;
                for (const block of blocks ?? []) {
                    if (block.type === "tool_use") {
                        toolCalls += 1;
                    }
                }
            }
            if (message.type !== "result") {
                continue;
            }
            const result = message as unknown as {
                subtype: string;
                result?: string;
                total_cost_usd?: number;
                num_turns?: number;
            };
            if (result.subtype !== "success") {
                throw new Error(
                    `sub-agent run ended without success: ${result.subtype}`,
                );
            }
            output = result.result ?? "";
            usd = result.total_cost_usd ?? 0;
            turns = result.num_turns ?? 0;
            // The tokens behind total_cost_usd, per model, so the report can
            // price the dispatch at Khan's rate as well as list (pricing.ts).
            usage = usageOfResultMessage(
                message as unknown as Record<string, unknown>,
            );
            // The result subtype is the runner-level outcome; keep it when no
            // assistant stop reason was seen at all.
            stopReason = stopReason ?? result.subtype;
            const err = (
                result as unknown as {error?: unknown; result?: string}
            ).error;
            if (err !== undefined) {
                errorMessage = JSON.stringify(err).slice(0, 500);
            }
        }
        return {
            output,
            usd,
            ...(usage === undefined ? {} : {usage}),
            turns,
            toolCalls,
            deniedReads,
            stopReason,
            errorMessage,
            tokensAtFailure,
            // Anthropic reports a usage-policy block as stop_reason "refusal".
            refused: stopReason === "refusal",
            wallMs: Date.now() - started,
        };
    } finally {
        clearTimeout(timer);
        // Written in finally so a timed-out or failed attempt leaves its
        // transcript too; those are the ones most worth reading.
        if (transcriptsDir !== false) {
            try {
                writeTranscript(transcriptsDir, label, {
                    agent: request.name,
                    model: request.model,
                    attempt,
                    deniedReads,
                    messages,
                });
            } catch (error) {
                console.error(
                    `transcript write failed for ${attemptKey}: ${String(
                        error instanceof Error ? error.message : error,
                    )}`,
                );
            }
        }
    }
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

/** Cheapest pinned model in the suite; the probe needs a tool call, not judgment. */
const PROBE_MODEL = "claude-haiku-4-5-20251001";

/**
 * The read-scope probe: stage a two-file case, plant a "secret" outside it,
 * and ask a model to read both and quote what it got. Passes when the
 * in-scope read went through, the out-of-scope read was denied exactly once,
 * and the secret's contents never reached the model. This is the empirical
 * check that a PreToolUse deny is honored under `bypassPermissions` on the
 * SDK version actually installed; the unit tests cover the predicate, not
 * the SDK's handling of its answer.
 */
export const probeReadScope = async (
    runner: LiveAgentRunner = sdkRunner({transcriptsDir: false}),
): Promise<{ok: boolean; detail: string}> => {
    const base = mkdtempSync(`${tmpdir()}/review-scope-probe-`);
    const readRoot = join(base, "stage", "probe-case");
    const cwd = join(readRoot, "checkout");
    mkdirSync(cwd, {recursive: true});
    mkdirSync(join(readRoot, "context"), {recursive: true});
    const inside = join(readRoot, "context", "note.txt");
    const outside = join(base, "outside", "secret.txt");
    mkdirSync(dirname(outside), {recursive: true});
    const insideToken = `inside-${Date.now().toString(36)}`;
    const outsideToken = `outside-${Date.now().toString(36)}`;
    writeFileSync(inside, `${insideToken}\n`);
    writeFileSync(outside, `${outsideToken}\n`);
    const result = await runner({
        name: "read-scope-probe",
        model: PROBE_MODEL,
        prompt: [
            "Use the Read tool on these two files, in this order, one call each:",
            `1. ${inside}`,
            `2. ${outside}`,
            "Then reply with exactly two lines: the full contents of file 1,",
            "and the full contents of file 2 (or the tool's error text if the",
            "read was refused). No other text.",
        ].join("\n"),
        cwd,
        readRoot,
        maxTurns: 6,
        timeoutMs: 90_000,
    });
    const leaked = result.output.includes(outsideToken);
    const sawInside = result.output.includes(insideToken);
    const denied = result.deniedReads ?? 0;
    const ok = !leaked && sawInside && denied >= 1;
    return {
        ok,
        detail:
            `in-scope read ${sawInside ? "returned" : "did NOT return"} its ` +
            `contents, out-of-scope read ${
                leaked ? "LEAKED" : "did not leak"
            }, ` +
            `denials=${denied}, toolCalls=${result.toolCalls ?? "?"}, ` +
            `$${result.usd.toFixed(3)}`,
    };
};

const main = async (): Promise<void> => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new Error("ANTHROPIC_API_KEY is required for a live run.");
    }
    if (process.argv.includes("--probe-read-scope")) {
        const probe = await probeReadScope();
        console.error(`read-scope probe: ${probe.detail}`);
        if (!probe.ok) {
            throw new Error(
                "read-scope probe FAILED: the runner let a read outside the " +
                    "staged case through (or the in-scope read failed). Do " +
                    "not trust this run's recall.",
            );
        }
        return;
    }
    const caseId = argValue("--case");
    if (caseId === undefined) {
        throw new Error("usage: live-runner.ts --case <case-id>");
    }
    const reviewMdPath =
        argValue("--review-md") ?? "workflows/review/review.md";
    const stageRoot =
        argValue("--stage-root") ?? mkdtempSync(`${tmpdir()}/review-live-`);
    const transcriptsDir = argValue("--transcripts-dir");

    const cases = loadLiveCorpus();
    const corpusCase = cases.find((c) => c.id === caseId);
    if (corpusCase === undefined) {
        throw new Error(
            `no live case "${caseId}"; available: ${cases
                .map((c) => c.id)
                .join(", ")}`,
        );
    }

    const agents = extractAgents(readFileSync(reviewMdPath, "utf8"));
    console.error(
        `running case ${caseId} (${agents.size} agents extracted) ` +
            `staged under ${stageRoot}`,
    );

    const result = await produceLive(corpusCase, agents, {
        runner: sdkRunner({
            ...(transcriptsDir !== undefined ? {transcriptsDir} : {}),
        }),
        stageDir: `${stageRoot}/${caseId}`,
    });
    console.error(
        `transcripts under ${transcriptsDir ?? DEFAULT_TRANSCRIPTS_DIR}`,
    );

    const totalUsd = result.perAgent.reduce((sum, a) => sum + a.usd, 0);
    console.log(
        JSON.stringify(
            {
                caseId,
                findings: result.findings,
                validation: result.validation,
                perAgent: result.perAgent,
                totalUsd,
            },
            null,
            2,
        ),
    );
    console.error(
        `done: ${result.findings.length} finding(s), ` +
            `${result.validation.length} verification(s), ` +
            `$${totalUsd.toFixed(2)}`,
    );
};

// CLI entry point (mirrors live-judge.ts): run when executed, not imported.
if (process.argv[1]?.endsWith("live-runner.ts")) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
