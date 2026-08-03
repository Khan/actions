/**
 * The production {@link LiveAgentRunner}: dispatch one sub-agent as a bounded
 * agentic loop via the Pi runner (`lib/dispatch-runner-pi.ts`, the same
 * harness production dispatch uses), plus a CLI smoke entry point
 * (`live-ab-plan.md` Phase 2c).
 *
 * This is the ONLY module in the eval suite that talks to a real model
 * runtime. `live-producer.ts` stays runner-free behind its seam, so unit
 * tests never load Pi's libraries.
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

import {
    createPiRunner,
    rejectStaleRunnerSelection,
} from "../lib/dispatch-runner-pi";
import {extractAgents} from "./agent-extract";
import {loadLiveCorpus} from "./corpus/loader";
import {produceLive, type LiveAgentRunner} from "./live-producer";

/** Read-only investigation tools; see the module doc for the rationale. */
const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/**
 * The eval runner: the production Pi harness pinned to the eval's three-tool
 * surface (the corpus was measured on Read/Grep/Glob). Lazily constructed so
 * importing this module never requires Pi's libraries; both A/B arms share
 * one instance, which also shares its lazy sandbox initialization.
 *
 * There is no runner selection anymore: the Claude Agent SDK harness was
 * removed after the re-anchoring A/B (run 30666183461; see PR #305), and a
 * leftover `REVIEW_DISPATCH_RUNNER` would select nothing — fail loudly
 * rather than let an operator believe a harness switch happened.
 */
export const piRunner = (): LiveAgentRunner => {
    rejectStaleRunnerSelection(process.env);
    let runner: Awaited<ReturnType<typeof createPiRunner>> | undefined;
    return async (request) => {
        if (runner === undefined) {
            runner = await createPiRunner({allowedTools: ALLOWED_TOOLS});
        }
        return runner(request);
    };
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
        runner: piRunner(),
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
