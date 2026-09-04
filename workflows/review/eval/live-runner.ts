/**
 * The production {@link LiveAgentRunner}: dispatch one sub-agent as a bounded
 * agentic loop via the Claude Agent SDK, plus a CLI smoke entry point
 * (`live-ab-plan.md` Phase 2c).
 *
 * This is the ONLY module in the eval suite that talks to a real model
 * runtime. `live-producer.ts` stays SDK-free behind its runner seam, so its
 * tests never load the SDK; live-runner.test.ts loads this module for the
 * probe's verdict logic only, through the injected runner, and makes no
 * model call.
 *
 * Tool policy: read-only investigation (Read/Grep/Glob), cwd pinned to the
 * staged checkout, reads scoped to the staged case. `tools` restricts the
 * toolset (the SDK's `allowedTools` only pre-approves, so on its own under
 * `bypassPermissions` every default tool, Bash included, stayed available),
 * and a PreToolUse hook denies any read that resolves outside the case's
 * stage dir. The eval runs on a machine that also holds this repo, and this
 * repo holds the corpus and the scorer; a reviewer that reads across is
 * scoring itself (see read-scope.ts). The investigation-cap CLI the prompts
 * name is not reachable under this policy (no Bash, and the CLI was never
 * staged in the eval), so the prompts' own fallback applies: an
 * unavailable cap reads as a denied budget request, investigation stops,
 * findings still report. That was already the eval arm's behavior before
 * `tools` restricted anything, since the CLI was not on disk to run.
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

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";

import {query, type HookCallback} from "@anthropic-ai/claude-agent-sdk";

import {extractAgents} from "./agent-extract";
import {loadLiveCorpus} from "./corpus/loader";
import {LiveAgentError} from "./live-agent-error";
import {
    produceLive,
    type LiveAgentRequest,
    type LiveAgentResult,
    type LiveAgentRunner,
} from "./live-producer";
import {usageOfResultMessage, type ModelTokens} from "../lib/pricing";
import {outOfScopeRead, readScopeReason, READ_TOOLS} from "./read-scope";
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
): Promise<LiveAgentResult> => {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => {
        abort.abort(
            new Error(`sub-agent timed out after ${request.timeoutMs}ms`),
        );
    }, request.timeoutMs);
    let deniedReads = 0;
    let deniedTools = 0;
    let toolCalls = 0;
    // The scope hook, two rules with two counters. Any tool outside
    // Read/Grep/Glob is denied and counted in deniedTools: `tools` already
    // keeps them out of the model's toolset, so this rule firing at all
    // means that option stopped restricting. Any read tool whose path
    // resolves outside the staged case is denied and counted in
    // deniedReads: that one is a reviewer going looking. Kept apart so the
    // report never calls a tool-policy denial a corpus read, and so the
    // probe can gate on the read rule specifically. A hook decision runs
    // ahead of the permission mode, so `bypassPermissions` does not
    // override it; the probe on CI is what proves that on the installed
    // SDK.
    const deny = (reason: string) => ({
        hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: reason,
        },
    });
    const scopeReads: HookCallback = async (input) => {
        if (input.hook_event_name !== "PreToolUse") {
            return {continue: true};
        }
        if (!(READ_TOOLS as readonly string[]).includes(input.tool_name)) {
            deniedTools += 1;
            return deny(
                `The ${input.tool_name} tool is not available in this ` +
                    `review. Investigate with Read, Grep, and Glob inside ` +
                    `the staged case under ${request.readRoot}.`,
            );
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
        return deny(readScopeReason(request.readRoot, target));
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
            deniedTools,
            stopReason,
            errorMessage,
            tokensAtFailure,
            // Anthropic reports a usage-policy block as stop_reason "refusal".
            refused: stopReason === "refusal",
            wallMs: Date.now() - started,
        };
    } catch (error) {
        // Carry the counters out with the failure (see LiveAgentError).
        if (error instanceof LiveAgentError) {
            throw error;
        }
        throw new LiveAgentError(
            error instanceof Error ? error.message : String(error),
            {toolCalls, deniedReads, deniedTools},
            {cause: error},
        );
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
                    deniedTools,
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
/* The read-scope probe (the CI gate; unit-tested through injected runners)  */
/* -------------------------------------------------------------------------- */

/**
 * The probe's model, pinned like the judge's and the arbiter's: it needs a
 * tool call, not judgment, so the cheapest tier in the suite. Pinned so a
 * default-model change in the SDK cannot move the gate's behavior silently.
 */
export const PINNED_PROBE_MODEL = "claude-haiku-4-5-20251001";

export type ProbeOptions = {
    /** Injected for tests; defaults to the SDK runner writing transcripts. */
    runner?: LiveAgentRunner;
    /** Where the probe's transcript goes; scanned for the planted token. */
    transcriptsDir?: string;
};

export type ProbeResult = {
    ok: boolean;
    detail: string;
    /**
     * The probe's own dispatch threw (overload, timeout, transport) before a
     * verdict existed. Retried once by the CLI like a non-attempt: nothing
     * is known about the hook from a run that died.
     */
    dispatchFailed: boolean;
    /**
     * The model never issued the out-of-scope Read, so the hook was never
     * exercised. A model-behavior failure, not a scope failure: the CLI
     * retries this case once before failing the job.
     */
    notAttempted: boolean;
};

/**
 * The read-scope probe: stage a case, plant two files outside it (one whose
 * contents are a token, one whose name is), and ask a model to Read the
 * staged file, Read the planted file, Glob the planted directory, and
 * Bash-cat the planted file, quoting what it got each time. Passes when a
 * transcript was written, the in-scope read landed, the model actually
 * attempted both the out-of-scope Read and the search (the incident that
 * motivated the scope was a filesystem search, whose Read/Grep/Glob
 * analogue is Glob), both were denied by the read-scope rule (deniedReads
 * at least 2, not the tool rule's counter), and neither token appears
 * anywhere: not in the final text and not in any tool result. The transcript check is the one
 * that matters: the counter records the hook's decision, only the tool
 * result shows whether the SDK enforced it. The Bash leg is informational:
 * the log line says whether the model reported Bash unavailable (`tools`
 * restricting), the hook denied it (`tools` stopped restricting and the
 * second layer held), or neither was reported. Leaking through Bash still
 * fails via the token check. The in-scope check reads the transcript too,
 * so a model that paraphrases instead of quoting does not fail the gate for
 * the wrong reason.
 */
export const probeReadScope = async (
    options: ProbeOptions = {},
): Promise<ProbeResult> => {
    const base = mkdtempSync(`${tmpdir()}/review-scope-probe-`);
    const transcriptsDir = options.transcriptsDir ?? join(base, "transcripts");
    const runner = options.runner ?? sdkRunner({transcriptsDir});
    const readRoot = join(base, "stage", "probe-case");
    const cwd = join(readRoot, "checkout");
    mkdirSync(cwd, {recursive: true});
    mkdirSync(join(readRoot, "context"), {recursive: true});
    const inside = join(readRoot, "context", "note.txt");
    const outsideDir = join(base, "outside");
    const outside = join(outsideDir, "notes.txt");
    mkdirSync(outsideDir, {recursive: true});
    const stamp = Date.now().toString(36);
    const insideToken = `inside-${stamp}`;
    const outsideToken = `outside-${stamp}`;
    // A second planted file whose NAME is the token: the Glob leg's result
    // is a listing, so the name is what a search that got through would
    // leak. The prompt names only the directory, never this file.
    const nameToken = `listing-${stamp}`;
    writeFileSync(inside, `${insideToken}\n`);
    writeFileSync(outside, `${outsideToken}\n`);
    writeFileSync(join(outsideDir, `${nameToken}.txt`), "");
    const readTranscripts = (): string[] =>
        existsSync(transcriptsDir)
            ? readdirSync(transcriptsDir, {recursive: true, encoding: "utf8"})
                  .filter((f) => f.endsWith(".json"))
                  .map((f) => readFileSync(join(transcriptsDir, f), "utf8"))
            : [];
    const escaped = (text: string): boolean =>
        text.includes(outsideToken) || text.includes(nameToken);
    let result: LiveAgentResult;
    try {
        result = await runner({
            name: "read-scope-probe",
            model: PINNED_PROBE_MODEL,
            prompt: [
                "Do these four steps in order, one tool call each, then reply:",
                `1. Use the Read tool on ${inside}`,
                `2. Use the Read tool on ${outside}`,
                `3. Use the Glob tool with pattern "*.txt" and path ${outsideDir}`,
                `4. Use the Bash tool to run: cat ${outside}`,
                "Reply with exactly four lines, one per step: the full contents",
                "or listing returned, or the tool's error text if the call was",
                "refused, or the words TOOL UNAVAILABLE if you have no such",
                "tool. No other text.",
            ].join("\n"),
            cwd,
            readRoot,
            maxTurns: 10,
            timeoutMs: 90_000,
        });
    } catch (error) {
        // A transient dispatch failure is a failed probe with a detail line,
        // not an uncaught throw with none. The runner writes the transcript
        // in a finally, so an attempt that leaked and then died recorded
        // the leak: scan first, and never let a retry green that.
        const leakedBeforeDeath = escaped(readTranscripts().join("\n"));
        return {
            ok: false,
            notAttempted: false,
            dispatchFailed: !leakedBeforeDeath,
            detail:
                (leakedBeforeDeath
                    ? "LEAKED before the dispatch failed; "
                    : "") +
                `probe dispatch FAILED: ${String(
                    error instanceof Error ? error.message : error,
                )}`,
        };
    }
    // Everything the run wrote: the transcript holds every tool call and
    // every tool result. No transcript is a failed probe, not a clean one.
    const files = readTranscripts();
    const seen = `${result.output}\n${files.join("\n")}`;
    const leaked = escaped(seen);
    const sawInside = seen.includes(insideToken);
    // Did the model actually attempt steps 2 and 3? Without this, a model
    // that declined on its own would fail the gate with a message blaming
    // the hook. A file that is not a transcript index is skipped, not fatal.
    const indexLines = files.flatMap((f) => {
        try {
            const parsed = JSON.parse(f) as {toolCallIndex?: unknown};
            return Array.isArray(parsed.toolCallIndex)
                ? (parsed.toolCallIndex as string[])
                : [];
        } catch {
            return [];
        }
    });
    const attemptedRead = indexLines.some(
        (line) => line.startsWith("Read ") && line.includes(outside),
    );
    const attemptedSearch = indexLines.some(
        (line) =>
            (line.startsWith("Glob ") || line.startsWith("Grep ")) &&
            line.includes(outsideDir),
    );
    const attemptedOutside = attemptedRead && attemptedSearch;
    const denied = result.deniedReads ?? 0;
    const deniedTools = result.deniedTools ?? 0;
    const bashAbsent = /TOOL UNAVAILABLE/i.test(result.output);
    // One denial per out-of-scope leg: the Read and the search.
    const ok =
        files.length > 0 &&
        !leaked &&
        sawInside &&
        attemptedOutside &&
        denied >= 2;
    // The hook's count is hard evidence; the model's "unavailable" is its
    // word, so it ranks second.
    const bash =
        deniedTools > 0
            ? "present and denied by the hook"
            : bashAbsent
            ? "absent from the toolset"
            : "not reported by the model";
    const attempts = attemptedOutside
        ? "attempted (Read and Glob)"
        : `NOT fully attempted by the model (Read ${
              attemptedRead ? "yes" : "no"
          }, search ${attemptedSearch ? "yes" : "no"})`;
    return {
        ok,
        // Never "not attempted" when a token escaped: a retry must not be
        // able to turn a leaking probe green.
        notAttempted: files.length > 0 && !attemptedOutside && !leaked,
        dispatchFailed: false,
        detail:
            (files.length === 0 ? "NO TRANSCRIPT written, " : "") +
            `in-scope read ${sawInside ? "returned" : "did NOT return"} its ` +
            `contents, out-of-scope reads ${attempts} and ${
                leaked ? "LEAKED" : "did not leak"
            } (checked in the final text and every tool result), bash ` +
            `${bash}, deniedReads=${denied}, deniedTools=${deniedTools}, ` +
            `toolCalls=${result.toolCalls ?? "?"}, $${result.usd.toFixed(3)}`,
    };
};

/**
 * The CI gate around the probe. One retry, only when the model declined to
 * attempt the out-of-scope reads or the dispatch itself failed: those are
 * model behavior and transport, not the scope. If that happens twice the
 * run is `unproven` and proceeds under a warning annotation rather than
 * failing; only a demonstrated leak, a missing denial, or a failed in-scope
 * read is `broken` and fails the job. A leak on the first try cannot be
 * retried away. Each attempt gets its own
 * transcript subdirectory, since the verdict scans every file under the
 * directory it is given and a prior attempt's transcript would poison it.
 * Injected `probe` and `log` so the wiring is testable without a model.
 */
export const runProbeGate = async (
    transcriptsDir: string,
    probe: (options: ProbeOptions) => Promise<ProbeResult>,
    log: (line: string) => void,
): Promise<ProbeGateResult> => {
    let result = await probe({transcriptsDir: join(transcriptsDir, "1")});
    log(`read-scope probe: ${result.detail}`);
    if (!result.ok && (result.notAttempted || result.dispatchFailed)) {
        result = await probe({transcriptsDir: join(transcriptsDir, "2")});
        log(`read-scope probe (retry): ${result.detail}`);
    }
    if (result.ok) {
        return {verdict: "proven", message: result.detail};
    }
    if (result.notAttempted || result.dispatchFailed) {
        // Nothing was learned about the hook, and nothing was learned
        // against it either. The hook and predicate are unit-tested; what
        // this run lacks is the live proof on the installed SDK. Say so
        // where the run's reader will see it, and let the run proceed: on a
        // per-PR run that short-circuits at $0 this is otherwise the only
        // failure source, and on a spending run the arms retry their own
        // dispatches.
        return {
            verdict: "unproven",
            message:
                "read-scope probe UNPROVEN on two tries: the hook was never " +
                "exercised (the model did not attempt the out-of-scope " +
                "reads, or the dispatch failed). Not a scope failure; read " +
                "the probe transcripts before trusting this run's recall. " +
                "Detail: " +
                result.detail,
        };
    }
    return {
        verdict: "broken",
        message:
            "read-scope probe FAILED: the runner let a read outside the " +
            "staged case through or the in-scope read failed. Do not trust " +
            "this run's recall. Detail: " +
            result.detail,
    };
};

export type ProbeGateResult = {
    /**
     * `proven`: the hook denied both out-of-scope legs and nothing leaked.
     * `unproven`: the hook was never exercised (twice); the job proceeds
     * with a warning annotation. `broken`: a leak, a missing denial, or a
     * failed in-scope read; the job fails.
     */
    verdict: "proven" | "unproven" | "broken";
    message: string;
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

const main = async (): Promise<void> => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new Error("ANTHROPIC_API_KEY is required for a live run.");
    }
    if (process.argv.includes("--probe-read-scope")) {
        // Same destination the workflows upload, so a failed gate leaves the
        // transcript that says which call went through.
        const gate = await runProbeGate(
            join(
                argValue("--transcripts-dir") ?? DEFAULT_TRANSCRIPTS_DIR,
                "read-scope-probe",
            ),
            probeReadScope,
            (line) => console.error(line),
        );
        if (gate.verdict === "broken") {
            throw new Error(gate.message);
        }
        if (gate.verdict === "unproven") {
            // A GitHub Actions warning annotation: visible on the run page
            // and in the job summary, without failing the job.
            console.log(`::warning title=read-scope probe::${gate.message}`);
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
