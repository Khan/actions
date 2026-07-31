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
 * staged checkout, no network. The investigation-cap CLI the prompts mention
 * is not runnable under this policy; the prompts' own fallback applies (a
 * denied budget request stops investigation, findings still report).
 *
 * Run one case end to end (requires ANTHROPIC_API_KEY):
 *
 *   pnpm dlx tsx workflows/review/eval/live-runner.ts --case <case-id>
 *     [--review-md workflows/review/review.md] [--stage-root /tmp/review-live]
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";

import {query} from "@anthropic-ai/claude-agent-sdk";

import {createPiRunner} from "../lib/dispatch-runner-pi";
import {extractAgents} from "./agent-extract";
import {loadLiveCorpus} from "./corpus/loader";
import {produceLive, type LiveAgentRunner} from "./live-producer";

/** Read-only investigation tools; see the module doc for the rationale. */
const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Build the SDK-backed runner. Each request becomes one `query()` run: the
 * agent's prompt, its pinned model, the staged checkout as cwd, hard turn and
 * wall-clock caps, and cost/turn accounting read off the result message.
 */
export const sdkRunner = (): LiveAgentRunner => async (request) => {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => {
        abort.abort(
            new Error(`sub-agent timed out after ${request.timeoutMs}ms`),
        );
    }, request.timeoutMs);
    try {
        const run = query({
            prompt: request.prompt,
            options: {
                cwd: request.cwd,
                model: request.model,
                maxTurns: request.maxTurns,
                allowedTools: ALLOWED_TOOLS,
                permissionMode: "bypassPermissions",
                abortController: abort,
            },
        });
        let output = "";
        let usd = 0;
        let turns = 0;
        let toolCalls = 0;
        let stopReason: string | undefined;
        let errorMessage: string | undefined;
        let tokensAtFailure: {input: number; total: number} | undefined;
        for await (const message of run) {
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
            turns,
            toolCalls,
            stopReason,
            errorMessage,
            tokensAtFailure,
            // Anthropic reports a usage-policy block as stop_reason "refusal".
            refused: stopReason === "refusal",
            wallMs: Date.now() - started,
        };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * The Pi-backed runner for the harness A/B (`REVIEW_DISPATCH_RUNNER=pi`).
 * The tool surface is pinned to `ALLOWED_TOOLS` so both arms investigate
 * through the same tools: the arm under test is the loop, not the toolbox.
 */
export const piRunner = (): LiveAgentRunner => {
    let runner: Awaited<ReturnType<typeof createPiRunner>> | undefined;
    return async (request) => {
        if (runner === undefined) {
            runner = await createPiRunner({allowedTools: ALLOWED_TOOLS});
        }
        return runner(request);
    };
};

/**
 * The runner the eval should use, chosen by the same `REVIEW_DISPATCH_RUNNER`
 * switch the production dispatcher reads (`sdk` default, `pi` opt-in).
 */
export const selectedRunner = (): LiveAgentRunner =>
    (process.env.REVIEW_DISPATCH_RUNNER ?? "sdk") === "pi"
        ? piRunner()
        : sdkRunner();

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
    const caseId = argValue("--case");
    if (caseId === undefined) {
        throw new Error("usage: live-runner.ts --case <case-id>");
    }
    const reviewMdPath =
        argValue("--review-md") ?? "workflows/review/review.md";
    const stageRoot =
        argValue("--stage-root") ?? mkdtempSync(`${tmpdir()}/review-live-`);

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
        runner: sdkRunner(),
        stageDir: `${stageRoot}/${caseId}`,
    });

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
