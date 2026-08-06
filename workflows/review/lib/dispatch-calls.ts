/**
 * Calling ONE sub-agent: the model seam, the per-agent report entry, and the
 * two recovery behaviors that wrap every dispatch — the usage-policy refusal
 * fallback and the single malformed-output retry.
 *
 * Split out of dispatch.ts for file size (the same reason dispatch-contracts,
 * dispatch-roster, and dispatch-agents live apart), but the seam is a real one:
 * everything here is about a single call and its recovery, and knows nothing
 * about rosters, phases, gating, or note lines. runDispatch owns the run;
 * this owns the call.
 */

import type {AgentDefinition} from "./dispatch-agents";
import {refusalFallbackFor} from "./refusal-fallback";

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

/** One sub-agent dispatch request (mirrors the eval's LiveAgentRequest). */
export type AgentRequest = {
    name: string;
    model: string;
    prompt: string;
    cwd: string;
    maxTurns: number;
    timeoutMs: number;
    /**
     * The structured-final contract check (trial suggestion h). When set,
     * the runner exposes a `submit_result` tool whose input is validated by
     * this function BEFORE it is accepted: null accepts the payload as the
     * agent's result; a string rejects it back to the model, which corrects
     * and re-calls in the same session (a few turns, not the $2-3 full
     * re-dispatch the malformed-output retry costs). Free-text finals stay as
     * the fallback for a model that never calls the tool.
     */
    validate?: (payload: Record<string, unknown>) => string | null;
};

export type AgentResult = {
    /** The agent's final text (expected to be its JSON contract). */
    output: string;
    usd: number;
    turns: number;
    wallMs: number;
    /**
     * Tool calls the agent made. The harness-parity signal: a loop that
     * investigates with fewer tool calls and scores lower has a toolbox
     * problem, not a model problem. Optional because a runner that cannot
     * count them reports nothing rather than a misleading zero.
     */
    toolCalls?: number;
    /**
     * The provider's stop reason for the agent's last assistant message, when
     * the runner can see one. Load-bearing for one specific diagnosis: an
     * EMPTY final on cyber-adjacent input is the signature of a refusal, which
     * #294 documents as surfacing "as a missing agent result, not an error".
     * Without this the empty result is indistinguishable from a dropped one.
     */
    stopReason?: string;
    /**
     * Why the call failed, when the runner can see it. `stopReason=error`
     * alone does not distinguish an overloaded provider from a prompt that
     * outgrew the context window, and those have opposite fixes (retries vs
     * compaction). `tokensAtFailure` is the discriminator: near the model's
     * context window means overflow.
     */
    errorMessage?: string;
    /** The provider's own stop reason, before the runner normalizes it. */
    rawStopReason?: string;
    /** Input and total tokens on the last assistant message. */
    tokensAtFailure?: {input: number; total: number};
    /**
     * The provider blocked the request under its usage policy. Distinct from
     * every other failure because it is deterministic in the model, not
     * transient: retrying the same pin returns the same refusal, so the only
     * useful response is a different model.
     */
    refused?: boolean;
    /** The output came through the structured-final tool, pre-validated. */
    structured?: boolean;
    /**
     * The turn loop ended because the run's spend ceiling was reached, not
     * because the agent finished. Load-bearing for disclosure: an agent stopped
     * for budget has usually found SOMETHING, so its output is still used, and
     * the run has to say that this dimension was cut short rather than
     * completed. Silence here would be indistinguishable from "nothing found".
     */
    stoppedForBudget?: boolean;
};

/** The model seam; the Pi-backed production runner lives in the CLI entry. */
export type AgentRunner = (request: AgentRequest) => Promise<AgentResult>;

export type PerAgentReport = {
    name: string;
    model: string;
    usd: number;
    turns: number;
    wallMs: number;
    /**
     * Tool calls the agent made, when the runner counts them. The
     * harness-parity signal: a loop that investigates with fewer tool calls
     * and scores lower has a toolbox problem, not a model problem. The runner
     * has reported this since the Pi swap; not threading it here left the
     * number unreadable outside a live transcript.
     */
    toolCalls?: number;
    /**
     * The runner's stop reason, recorded verbatim when it reports one. Two
     * diagnoses ride on it and neither is visible any other way: `refusal`
     * (an empty result that is a usage-policy block, not a dropped call) and
     * `max_turns` (a truncated result that is out-of-turns, not malformed).
     * Not interpreted here: the vocabulary is the runner's, and this report is
     * runner-agnostic.
     */
    stopReason?: string;
    /** This entry is the one malformed-output retry of the same agent. */
    retried?: boolean;
    /**
     * The pinned model refused under the provider's usage policy and this
     * dispatch ran on the fallback instead. Recorded, never silent: the whole
     * failure mode is invisibility, and a hidden model swap would just move it.
     */
    fellBackTo?: string;
    /** The result arrived via the structured-final tool (pre-validated). */
    structuredFinal?: boolean;
    /**
     * This agent's turn loop ended on the run's spend ceiling. Kept per agent
     * rather than only run-wide, because "which dimension got cut short" is the
     * question a reader of the artifact actually has.
     */
    stoppedForBudget?: boolean;
    failed?: string;
};

/* -------------------------------------------------------------------------- */
/* The dispatcher                                                             */
/* -------------------------------------------------------------------------- */

export type AgentDispatcherOptions = {
    runner: AgentRunner;
    /** The inline agent definitions, by name (dispatch-agents.loadAgents). */
    agents: Map<string, AgentDefinition>;
    /** Stage an agent's raw output under `out/<name>.json`. */
    writeOut: (name: string, content: string) => void;
    /** Append one entry to the run's per-agent report. */
    report: (entry: PerAgentReport) => void;
    /** The PR checkout (sub-agent cwd). */
    repoRoot: string;
    maxTurns: number;
    timeoutMs: number;
    /** The structured-final contract check for each dispatchable agent. */
    validatorFor: (
        name: string,
    ) => (payload: Record<string, unknown>) => string | null;
    /**
     * Asked before each dispatch whether the run can still afford one. The
     * spend ledger answers. Refusing here rather than aborting mid-flight is
     * the cheaper of the two disclosures: nothing is spent, and the dimension
     * is shed with a note instead of half-run.
     */
    mayDispatch?: (name: string) => boolean;
    /**
     * Called once per COMPLETED attempt with what it cost. The ledger's only
     * writer; a retry and a refusal fallback are separate attempts and each
     * one really was paid for, so each is recorded.
     */
    recordSpend?: (name: string, usd: number) => void;
};

export type AgentDispatcher = {
    /**
     * Dispatch one agent; stage its raw output; report cost and failure.
     * Returns the output text, or null when the agent produced none.
     */
    dispatchAgent: (name: string) => Promise<string | null>;
    /**
     * Parse an agent's output per its contract, re-dispatching ONCE with a
     * corrective note when the parse fails. Returns null when even the retry
     * is unusable, and the caller sheds the dimension.
     */
    parseWithRetry: <T>(
        name: string,
        output: string,
        parse: (output: string) => T,
    ) => Promise<T | null>;
};

export const createAgentDispatcher = (
    options: AgentDispatcherOptions,
): AgentDispatcher => {
    const {
        runner,
        agents,
        writeOut,
        report,
        repoRoot,
        maxTurns,
        timeoutMs,
        validatorFor,
        mayDispatch,
        recordSpend,
    } = options;

    /**
     * The stop reason of each agent's most recent dispatch. Read by exactly
     * one decision: what the single contract-parse retry tells the agent it
     * did wrong (see parseWithRetry). Keyed by name because the retry is
     * always the same agent.
     */
    const lastStopReason = new Map<string, string>();

    /**
     * Dispatch one agent; stage its raw output; report cost and failure.
     * `malformedNote` marks the one contract-parse retry: it appends the
     * corrective instruction to the prompt and flags the report entry.
     */
    const dispatchAgent = async (
        name: string,
        malformedNote?: string,
        modelOverride?: string,
    ): Promise<string | null> => {
        if (mayDispatch !== undefined && !mayDispatch(name)) {
            // Refused before spending. Staged as an out-file like every other
            // outcome so the dispatch gate reads one shape, and reported as a
            // failure cause so the run's own artifact names the reason.
            writeOut(
                name,
                JSON.stringify({
                    error: "spend ceiling reached before dispatch",
                }),
            );
            report({
                name,
                model: agents.get(name)?.model ?? "",
                usd: 0,
                turns: 0,
                wallMs: 0,
                failed: "budget",
            });
            return null;
        }
        const definition = agents.get(name);
        if (definition === undefined) {
            writeOut(name, JSON.stringify({error: "agent definition missing"}));
            report({
                name,
                model: "",
                usd: 0,
                turns: 0,
                wallMs: 0,
                failed: "definition-missing",
            });
            return null;
        }
        try {
            const corrective =
                malformedNote === undefined
                    ? ""
                    : `\n\nYour previous reply could not be used (${malformedNote}). Submit again now, and this time deliver the complete corrected JSON object through the submit_result tool (or, if that tool is unavailable, as your ENTIRE message: no prose before or after it, no code fence).`;
            const model = modelOverride ?? definition.model;
            const result = await runner({
                name,
                model,
                prompt: `${definition.prompt}\n\nProceed now per your definition. Deliver your result by calling the submit_result tool ONCE, passing the ENTIRE JSON object your definition's output contract specifies as its \`result\` argument; if the tool rejects it, correct the object and call the tool again. After it is accepted, end the turn without repeating the JSON. If the submit_result tool is unavailable, your final message must be exactly that JSON object, nothing else.${corrective}`,
                cwd: repoRoot,
                maxTurns,
                timeoutMs,
                validate: validatorFor(name),
            });
            // A usage-policy refusal is intermittent (probe 30658862532 saw
            // the same pin clear cases it blocked in 30656579898), but the
            // contract-parse retry still cannot recover it: that retry appends
            // a corrective note about output shape, and a blocked request
            // never had one. Only a different refusal profile reliably helps.
            // Production is where this actually costs coverage — a refused
            // reviewer emits no error, just nothing, and the review proceeds
            // without it (run 30656579898: correctness-reviewer on Fable 5,
            // blocked on security-adjacent diffs).
            const fallback =
                result.refused === true && modelOverride === undefined
                    ? refusalFallbackFor(model)
                    : undefined;
            if (fallback !== undefined) {
                // Record the refused attempt before recursing. It really ran
                // and really cost money, and `totalUsd` sums over `perAgent`,
                // so dropping it undercounts the run. A separate entry also
                // keeps the refusal itself visible rather than letting the
                // fallback's success paper over it (the malformed-output
                // retry pushes its own entry for the same reason).
                report({
                    name,
                    model,
                    usd: result.usd,
                    turns: result.turns,
                    wallMs: result.wallMs,
                    ...(result.toolCalls === undefined
                        ? {}
                        : {toolCalls: result.toolCalls}),
                    ...(result.stopReason === undefined
                        ? {}
                        : {stopReason: result.stopReason}),
                    failed: "refused",
                });
                recordSpend?.(name, result.usd);
                return dispatchAgent(name, malformedNote, fallback);
            }
            writeOut(name, result.output);
            // The contract-parse retry reads this to tell "wrong shape" apart
            // from "ran out of turns" (see parseWithRetry).
            if (result.stopReason !== undefined) {
                lastStopReason.set(name, result.stopReason);
            }
            report({
                name,
                model,
                usd: result.usd,
                turns: result.turns,
                wallMs: result.wallMs,
                ...(result.toolCalls === undefined
                    ? {}
                    : {toolCalls: result.toolCalls}),
                ...(result.stopReason === undefined
                    ? {}
                    : {stopReason: result.stopReason}),
                ...(malformedNote === undefined ? {} : {retried: true}),
                ...(modelOverride === undefined ? {} : {fellBackTo: model}),
                ...(result.structured === true ? {structuredFinal: true} : {}),
                ...(result.stoppedForBudget === true
                    ? {stoppedForBudget: true}
                    : {}),
            });
            recordSpend?.(name, result.usd);
            return result.output;
        } catch (error) {
            writeOut(
                name,
                JSON.stringify({
                    error:
                        error instanceof Error ? error.message : String(error),
                }),
            );
            report({
                name,
                model: modelOverride ?? definition.model,
                usd: 0,
                turns: 0,
                wallMs: 0,
                ...(modelOverride === undefined
                    ? {}
                    : {fellBackTo: modelOverride}),
                failed: "run-failed",
            });
            return null;
        }
    };

    /**
     * Parse an agent's output per its contract, re-dispatching ONCE with a
     * corrective note when the parse fails (the eval producer's
     * malformed-output rule). The retry's output overwrites the staged
     * out-file, so the gate reads whatever the run actually acted on. A
     * second failure returns null and the caller sheds the dimension with
     * its disclosure note; without the retry, one prose-wrapped reply
     * silently voids a dispatched (and paid-for) reviewer, which is how the
     * mandatory correctness pass went missing in trial run 29893634730.
     */
    const parseWithRetry = async <T>(
        name: string,
        output: string,
        parse: (output: string) => T,
    ): Promise<T | null> => {
        try {
            return parse(output);
        } catch (error) {
            const parseNote =
                error instanceof Error ? error.message : String(error);
            // An agent that hit the turn cap did not get the output SHAPE
            // wrong; it stopped mid-investigation. Telling it to "deliver the
            // complete corrected JSON object" is then the wrong instruction,
            // and this is the run's only retry: say what actually happened so
            // the second attempt spends its turns concluding rather than
            // re-investigating.
            const note =
                lastStopReason.get(name) === "max_turns"
                    ? `${parseNote}; the previous attempt also stopped at its turn cap before finishing, so conclude from what you have already found instead of investigating further`
                    : parseNote;
            const second = await dispatchAgent(name, note);
            if (second === null) {
                return null;
            }
            try {
                return parse(second);
            } catch {
                return null;
            }
        }
    };

    return {
        dispatchAgent: (name: string) => dispatchAgent(name),
        parseWithRetry,
    };
};
