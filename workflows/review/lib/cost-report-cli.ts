/**
 * The cost-report post-step (review.md `post-steps`, after the
 * dispatch-conformance gate): read what the run left behind, build the
 * per-review cost report (cost-report.ts), and land it in three places:
 *
 *  1. The review body in the validated safe-output queue
 *     (`/tmp/gh-aw/agent_output.json`), as a collapsed block before the
 *     fingerprint stamp, so the PR's parent review comment carries its own
 *     price tag. The queue is edited post-ingest the same way the gate edits
 *     it (strips items). The block is code-rendered from numbers and
 *     review.md-defined names, never from model text, and every cell is
 *     escaped.
 *  2. The step summary, so the run page shows it without opening the PR.
 *  3. `/tmp/gh-aw/agent/cost-report.json`, beside the gate's report in the
 *     `agent` artifact, so the weekly counters can pool it.
 *
 * Runs here rather than inside the agent step because two of its inputs
 * only exist afterwards: the api-proxy's `token-usage.jsonl` (the whole run
 * by model, which is how the orchestrator's share is derived) and gh-aw's
 * `agent_usage.json` (the `ai_credits` the report reconciles against). Both
 * are written between "Execute Claude Code CLI" and the post-steps.
 *
 * Fail-open, like the gate: any error leaves the queue untouched, prints a
 * `::warning`, and exits 0. A review without a price tag beats a review that
 * did not post.
 */

import {
    buildCostReport,
    renderCostDetails,
    renderCostTable,
    withCostDetails,
    type AgentUsageFile,
    type CostAgentEntry,
    type CostReport,
} from "./cost-report";
import {
    parseProxyTokenUsage,
    rateCardFromProviders,
    readOverlayRates,
    type ModelTokens,
    type RateCard,
} from "./pricing";

export type CostReportFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    appendFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

const AGENT_OUTPUT_PATH = "/tmp/gh-aw/agent_output.json";
const REVIEW_DIR = "/tmp/gh-aw/review";
const DISPATCH_RESULT_PATH = `${REVIEW_DIR}/dispatch-result.json`;
/**
 * Under /tmp/gh-aw/agent/ beside the gate's report: that directory is in the
 * "Upload agent artifacts" step, which runs after the post-steps. The
 * review's own out/ artifact is staged and uploaded during the agent step,
 * so a file written there now would never leave the runner.
 */
const REPORT_DIR = "/tmp/gh-aw/agent";
export const COST_REPORT_PATH = `${REPORT_DIR}/cost-report.json`;
/**
 * gh-aw caps a queued review body at 65000 characters at ingest, and GitHub
 * rejects a body over 65536. The block is spliced in after that check, so
 * it must fit under the same cap or the whole review would fail to post.
 */
export const BODY_CAP = 65000;
const AGENT_USAGE_PATH = "/tmp/gh-aw/agent_usage.json";
/** gh-aw's merged rate table (the overlay over its catalog), when present. */
const MODELS_JSON_PATH = "/tmp/gh-aw/models.json";
/**
 * Where the firewall writes the api-proxy's per-request usage. The same
 * candidates gh-aw's parse_token_usage.cjs reads, in the same order.
 */
const TOKEN_USAGE_PATHS = [
    "/tmp/gh-aw/sandbox/firewall-audit-logs/api-proxy-logs/token-usage.jsonl",
    "/tmp/gh-aw/sandbox/firewall/audit/api-proxy-logs/token-usage.jsonl",
    "/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl",
];
const SUBMIT_TYPE = "submit_pull_request_review";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonIfPresent = (fs: CostReportFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/**
 * Khan's rate card for this run: gh-aw's models.json when the runner has it
 * (the exact table `ai_credits` were computed with), else the overlay in the
 * lib checkout's review.md (the same numbers, one hop removed).
 */
export const resolveRateCard = (
    fs: CostReportFs,
    reviewMdPath: string,
): {card: RateCard; source: string} => {
    const models = readJsonIfPresent(fs, MODELS_JSON_PATH);
    if (isRecord(models) && isRecord(models["providers"])) {
        const card = rateCardFromProviders(models["providers"]);
        if (card.size > 0) {
            return {card, source: MODELS_JSON_PATH};
        }
    }
    if (fs.existsSync(reviewMdPath)) {
        return {
            card: readOverlayRates(fs.readFileSync(reviewMdPath, "utf8")),
            source: reviewMdPath,
        };
    }
    return {card: new Map(), source: "none"};
};

const readProxyUsage = (fs: CostReportFs): ModelTokens[] | undefined => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const path of TOKEN_USAGE_PATHS) {
        if (!fs.existsSync(path)) {
            continue;
        }
        // The firewall may write the same request under more than one dir,
        // so dedupe by request_id the way gh-aw does, raw line as fallback.
        for (const line of fs.readFileSync(path, "utf8").split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "") {
                continue;
            }
            const id = /"request_id"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(trimmed);
            const key = id === null ? trimmed : id[1];
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            lines.push(trimmed);
        }
    }
    return lines.length === 0
        ? undefined
        : parseProxyTokenUsage(lines.join("\n"));
};

const readPerAgent = (fs: CostReportFs): CostAgentEntry[] | undefined => {
    const result = readJsonIfPresent(fs, DISPATCH_RESULT_PATH);
    if (!isRecord(result) || !Array.isArray(result["perAgent"])) {
        return undefined;
    }
    return result["perAgent"].filter(
        (entry): entry is CostAgentEntry =>
            isRecord(entry) &&
            typeof entry["name"] === "string" &&
            typeof entry["model"] === "string" &&
            typeof entry["usd"] === "number",
    );
};

export type CostReportCliOutcome = {
    report: CostReport;
    rateSource: string;
    /** Whether a review body in the queue received the block. */
    bodyUpdated: boolean;
};

/**
 * Build the report and write it everywhere. Pure in `fs`, the entry point
 * below binds node's. Throws when there is nothing to report (no
 * dispatch-result.json), which the entry point turns into a warning.
 */
export const runCostReportCli = (
    fs: CostReportFs,
    options: {reviewMdPath: string; stepSummaryPath?: string},
): CostReportCliOutcome => {
    const perAgent = readPerAgent(fs);
    if (perAgent === undefined) {
        throw new Error(
            `no dispatch result to price (${DISPATCH_RESULT_PATH} missing or unparseable)`,
        );
    }
    const {card, source} = resolveRateCard(fs, options.reviewMdPath);
    const proxyUsage = readProxyUsage(fs);
    const agentUsageRaw = readJsonIfPresent(fs, AGENT_USAGE_PATH);
    const report = buildCostReport({
        perAgent,
        khan: card,
        ...(proxyUsage === undefined ? {} : {proxyUsage}),
        ...(isRecord(agentUsageRaw)
            ? {agentUsage: agentUsageRaw as AgentUsageFile}
            : {}),
    });
    if (card.size === 0) {
        report.notes.push(
            "No Khan-rate table was readable on the runner, so Cost (Khan rate) equals the SDK's list figure.",
        );
    }

    // The review body in the queue, decided first so a block that does not
    // fit is noted in the artifact and summary too. A gate-stripped queue
    // has no submit item and that is fine: the other two surfaces carry it.
    let bodyUpdated = false;
    const queue = readJsonIfPresent(fs, AGENT_OUTPUT_PATH);
    const details = renderCostDetails(report);
    const items =
        isRecord(queue) && Array.isArray(queue["items"])
            ? queue["items"].map((item) => {
                  if (
                      !isRecord(item) ||
                      item["type"] !== SUBMIT_TYPE ||
                      typeof item["body"] !== "string"
                  ) {
                      return item;
                  }
                  const body = withCostDetails(item["body"], details);
                  if (body.length > BODY_CAP) {
                      // A review that posts without its price tag beats one
                      // that GitHub rejects.
                      report.notes.push(
                          "The cost block would have pushed the review body " +
                              `${body.length - BODY_CAP} characters over ` +
                              `gh-aw's ${BODY_CAP}-character cap, so it was ` +
                              "left out of the body.",
                      );
                      return item;
                  }
                  bodyUpdated = true;
                  return {...item, body};
              })
            : undefined;

    // The artifact, before the queue write: it is the record even if that
    // write fails.
    fs.mkdirSync(REPORT_DIR, {recursive: true});
    fs.writeFileSync(
        COST_REPORT_PATH,
        `${JSON.stringify({...report, rateSource: source}, null, 2)}\n`,
    );

    // The step summary.
    if (
        options.stepSummaryPath !== undefined &&
        options.stepSummaryPath !== ""
    ) {
        fs.appendFileSync(
            options.stepSummaryPath,
            `## Review cost\n\n${renderCostTable(report)}\n\n`,
        );
    }

    // The queue, last.
    if (bodyUpdated && isRecord(queue) && items !== undefined) {
        fs.writeFileSync(
            AGENT_OUTPUT_PATH,
            `${JSON.stringify({...queue, items}, null, 2)}\n`,
        );
    }
    return {report, rateSource: source, bodyUpdated};
};

// Run only when executed directly (review.md post-steps), never on import.
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs") as CostReportFs;
    try {
        const outcome = runCostReportCli(nodeFs, {
            reviewMdPath: "workflows/review/review.md",
            ...(process.env.GITHUB_STEP_SUMMARY === undefined
                ? {}
                : {stepSummaryPath: process.env.GITHUB_STEP_SUMMARY}),
        });
        // eslint-disable-next-line no-console
        console.log(
            `cost report: $${outcome.report.total.khanUsd.toFixed(
                2,
            )} at Khan's rate over ${outcome.report.agents.length} agent(s)` +
                `${
                    outcome.report.engine === undefined
                        ? ""
                        : " plus orchestrator"
                }` +
                `, rates from ${outcome.rateSource}, review body ${
                    outcome.bodyUpdated ? "updated" : "not in queue"
                }`,
        );
    } catch (error) {
        // eslint-disable-next-line no-console
        console.log(
            `::warning title=review cost report::not produced (review posts without it): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    process.exit(0);
}
