/**
 * The harness probe: why does the Pi arm lose
 * `incident-sql-missing-index:dm-default-backfill`?
 *
 * The re-anchoring A/B (run 30666183461) lost that spec in BOTH repeats, and
 * the artifact rules out every mechanical cause: no failed agents, no absent
 * agents, and `droppedByProvenance` / `snappedByProvenance` / `droppedByScope`
 * / `droppedByValidation` all empty in both arms. It is not a scoring artifact
 * either — the Pi arm's second finding is a different, weaker observation
 * (repeat 0: "status is an untyped string, consider a union type"; repeat 1:
 * "listOrders silently changes contract"), where the baseline's is the seeded
 * defect ("the migration defaults every existing and new order to 'pending'
 * and no code path ever updates status, so every order stays in the work queue
 * forever"). The Pi arm made MORE tool calls and produced FEWER findings at
 * ~40% of the cost: more investigation, fewer conclusions.
 *
 * Tools were like-for-like (the eval's own SDK runner pinned the same
 * Read/Grep/Glob), so exactly two asymmetries remain between the two harnesses
 * at the A/B's sha (d62a33b):
 *
 *   1. System prompt. The eval's SDK arm passed none, so its reviewers ran on
 *      Claude Code's full default framing; the Pi runner supplies its own
 *      minimal five-line SYSTEM_PROMPT.
 *   2. Final channel. The SDK arm had no `submit_result` tool and emitted a
 *      free-text JSON final; the Pi arm exposes the validated structured-final
 *      tool, which may invite closing out as soon as the object is well-formed.
 *
 * This probe runs one case through the Pi harness in one configuration per
 * invocation, changing exactly one of those two things, and reports the
 * deterministic must-catch match. Whichever configuration recovers the spec
 * names the cause; if none does, the honest conclusion is that the difference
 * is loop-level rather than framing-level, and the plan's written acceptance
 * applies.
 *
 * Deliberately NOT wired into the A/B workflow: it answers one question about
 * one case and then its job is done.
 *
 * Usage (needs ANTHROPIC_API_KEY; ~$0.50 per config):
 *
 *   pnpm dlx tsx workflows/review/eval/harness-probe.ts --config as-is
 *   pnpm dlx tsx workflows/review/eval/harness-probe.ts --config fortified
 *   pnpm dlx tsx workflows/review/eval/harness-probe.ts --config no-submit
 *   pnpm dlx tsx workflows/review/eval/harness-probe.ts --config all
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";

import {
    SYSTEM_PROMPT,
    createPiRunner,
    rejectStaleRunnerSelection,
} from "../lib/dispatch-runner-pi";
import {extractAgents} from "./agent-extract";
import {loadLiveCorpus} from "./corpus/loader";
import {matchCase} from "./live-match";
import {produceLive, type LiveAgentRunner} from "./live-producer";
import {runCase} from "./runner";

/**
 * The tool surface the lost-finding A/B ran on, held fixed so the probe
 * varies one thing. Glob has since been removed from `createReviewTools`
 * (its `find -path` emulation was wrong), so the closest reproduction the
 * current lib can offer is Read/Grep; the probe's question (system prompt
 * vs structured final) does not turn on Glob.
 */
const ALLOWED_TOOLS = ["Read", "Grep"];

const CASE_ID = "incident-sql-missing-index";

/**
 * The SDK arm ran on Claude Code's default system prompt, which is long and
 * says a great deal about being thorough. Reproducing it is neither possible
 * nor the point: what this tests is whether ANY completeness framing recovers
 * the finding, i.e. whether the terse prompt is the shedding mechanism. Kept
 * close to the original in role and contract obligation so the only new thing
 * is the instruction to report everything found rather than the best thing
 * found.
 */
const FORTIFIED_SYSTEM_PROMPT = [
    SYSTEM_PROMPT,
    "Report EVERY defect your investigation supports, not only the most",
    "serious one: a reviewer that finds three real problems and reports one",
    "has failed. Before you conclude, re-read the diff once and ask what a",
    "careful reviewer would still object to — a data change that leaves",
    "existing rows in a state the new code path never leaves, a filter with no",
    "writer, a guard with no caller — and include each one you can support.",
].join(" ");

export type ProbeConfig = "as-is" | "fortified" | "no-submit";

export const CONFIGS: ProbeConfig[] = ["as-is", "fortified", "no-submit"];

/** What one configuration changes, in one line, for the report. */
export const describeConfig = (config: ProbeConfig): string =>
    config === "as-is"
        ? "production framing, submit_result on (the A/B's Pi arm exactly)"
        : config === "fortified"
        ? "completeness framing added, submit_result on"
        : "production framing, submit_result OFF (the SDK arm's free-text final)";

/**
 * One configuration's runner. `no-submit` strips `validate` from the request,
 * which is what gates the structured-final tool in the runner — no runner
 * change needed to reproduce the SDK arm's channel.
 */
const runnerFor = (config: ProbeConfig): LiveAgentRunner => {
    rejectStaleRunnerSelection(process.env);
    let runner: ReturnType<typeof createPiRunner> | undefined;
    return async (request) => {
        runner ??= createPiRunner({
            allowedTools: ALLOWED_TOOLS,
            ...(config === "fortified"
                ? {systemPrompt: FORTIFIED_SYSTEM_PROMPT}
                : {}),
        });
        const forwarded = {...request};
        if (config === "no-submit") {
            delete forwarded.validate;
        }
        return (await runner)(forwarded);
    };
};

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

const runConfig = async (
    config: ProbeConfig,
    reviewMdPath: string,
): Promise<void> => {
    const corpusCase = loadLiveCorpus().find((entry) => entry.id === CASE_ID);
    if (corpusCase === undefined) {
        throw new Error(`no live case "${CASE_ID}"`);
    }
    const agents = extractAgents(readFileSync(reviewMdPath, "utf8"));
    const stageRoot = mkdtempSync(`${tmpdir()}/harness-probe-`);

    const produced = await produceLive(corpusCase, agents, {
        runner: runnerFor(config),
        stageDir: `${stageRoot}/${CASE_ID}`,
    });
    const usd = produced.perAgent.reduce((sum, agent) => sum + agent.usd, 0);

    // Print what the models produced BEFORE scoring it. The first version of
    // this probe matched first and died on a shape error, throwing away $1.50 of
    // completed model work because of a bug in the cheap step that followed it.
    // Expensive output gets printed the moment it exists.
    console.log(`\n=== ${config}: ${describeConfig(config)}`);
    console.log(
        `    candidates: ${produced.findings.length} | $${usd.toFixed(
            2,
        )} | tools: ${produced.perAgent
            .map((agent) => `${agent.name}=${agent.toolCalls ?? "?"}`)
            .join(" ")}`,
    );
    for (const finding of produced.findings) {
        console.log(
            `    - ${finding.id}: ${String(
                (finding as unknown as {model_authored_prose?: string})
                    .model_authored_prose,
            ).slice(0, 220)}`,
        );
    }

    // Matching scores POSTED candidates, so it needs the deterministic runner's
    // RunResult rather than the producer's output: runCase puts the produced
    // findings through the same provenance gate, scope filter, and verdict logic
    // production uses. This is how live-ab.ts wires it, and passing the
    // producer's result straight to matchCase is what broke run 30872172052.
    const result = runCase(corpusCase, {
        produceFindings: () => produced.findings,
        validation: produced.validation,
    });
    // Deterministic matching only (no fallback calls): the question is whether
    // the finding is THERE, and a judge fallback would blur that into a
    // judgement call about near-misses.
    const match = await matchCase(corpusCase, result, {maxFallbackCalls: 0});
    console.log(
        `    caught: ${match.caught
            .map((entry) => entry.specKey)
            .join(", ")} | missed: ${match.missed.join(", ") || "(none)"}`,
    );
};

const main = async (): Promise<void> => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new Error("ANTHROPIC_API_KEY is required for a live run.");
    }
    const reviewMdPath =
        argValue("--review-md") ?? "workflows/review/review.md";
    const requested = argValue("--config") ?? "all";
    const configs = requested === "all" ? CONFIGS : [requested as ProbeConfig];
    for (const config of configs) {
        if (!CONFIGS.includes(config)) {
            throw new Error(
                `unknown config "${config}"; one of ${CONFIGS.join(
                    ", ",
                )}, or all`,
            );
        }
    }
    for (const config of configs) {
        await runConfig(config, reviewMdPath);
    }
    console.log(
        "\nRead it this way: the configuration that recovers dm-default-backfill",
        "names the cause. If none does, the difference is loop-level, not",
        "framing-level.",
    );
};

/** See live-ab.ts: srt's proxy keeps the loop alive, so exit explicitly. */
const exitWhenFlushed = (code: number): void => {
    const done = (): never => process.exit(code);
    setTimeout(done, 2000).unref();
    process.stdout.write("", done);
};

// CLI entry point (mirrors live-runner.ts): run when executed, not imported.
if (process.argv[1]?.endsWith("harness-probe.ts")) {
    main().then(
        () => exitWhenFlushed(0),
        (error: unknown) => {
            console.error(error);
            exitWhenFlushed(1);
        },
    );
}
