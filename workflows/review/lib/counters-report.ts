/**
 * CLI that turns a directory of downloaded per-run review artifacts into the
 * live-counters report — the "wire the counters somewhere someone looks" half
 * of `counters.ts`. The consumer repos' weekly `review-counters` workflows run:
 *
 *     npx -y tsx gh-aw-review-lib/workflows/review/lib/counters-report.ts <runs-dir>
 *
 * where `<runs-dir>` holds one subdirectory per review run (named by run id),
 * each containing whatever artifacts the workflow downloaded for that run. No
 * GitHub calls happen here — the workflow does the (bounded) artifact download
 * with `gh api`; this script is a pure aggregation over local files, so the
 * counters themselves stay deterministic and unit-testable.
 *
 * Three artifact layouts are understood, newest first:
 *
 *   1. The conventional layout `counters.ts` documents (`claims.json`,
 *      `out/claim-validator.json`, `summary.json`).
 *   2. Today's production reality: runs upload `out/**` (per-sub-agent JSON)
 *      but no `claims.json` or `summary.json`. Validator decisions then count
 *      under the `(unknown)` source, and the run summary is synthesized from
 *      two gh-aw engine artifacts every run already has:
 *        - `safeoutputs.jsonl` (the agent's emitted safe outputs) -> verdict
 *          (the `submit_pull_request_review` event) and, as a fallback,
 *          intended comment counts;
 *        - `safe-output-items.jsonl` (the processed handler log) -> comments
 *          actually posted;
 *        - `agent_usage.json` -> model cost (`ai_credits`, 1 credit = $0.01)
 *          and token totals.
 *   3. Anything older/malformed: the affected counters degrade per
 *      `counters.ts`'s normalisation rules rather than failing the report.
 *
 * Files are located by basename anywhere under the run directory (shallowest
 * match wins), which tolerates the known gh-aw artifact staging-path nesting
 * rather than assuming exact zip layouts.
 */

import {readdirSync, readFileSync, appendFileSync} from "node:fs";
import {basename, join} from "node:path";

import {
    computeRunCounters,
    normalizeRunArtifacts,
    type RunArtifacts,
    type RunCounters,
} from "./counters.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse a JSONL string into records, skipping blank/malformed lines. */
export const parseJsonl = (text: string): Record<string, unknown>[] => {
    const records: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isRecord(parsed)) {
                records.push(parsed);
            }
        } catch {
            // A malformed line drops a data point, never the report.
        }
    }
    return records;
};

/** The gh-aw engine artifacts a run summary can be synthesized from. */
export type GhAwRunFiles = {
    /** `safeoutputs.jsonl` — the agent's emitted safe outputs (with `event`). */
    safeOutputs?: string;
    /** `safe-output-items.jsonl` — the handler's log of posted items. */
    postedItems?: string;
    /** `agent_usage.json` — parsed engine usage roll-up. */
    agentUsage?: unknown;
};

const COMMENT_ITEM_TYPES = new Set([
    "create_pull_request_review_comment",
    "add_comment",
]);

/**
 * Synthesize the `summary.json`-shaped object `normalizeRunArtifacts` expects
 * from the gh-aw engine artifacts. Pure. Fields the artifacts cannot answer are
 * left absent so normalisation applies its documented fallbacks (in particular
 * a run with no submitted review normalises to `HOLD_FOR_HUMAN`; the report
 * calls those runs out separately rather than hiding them).
 */
export const synthesizeSummaryFromGhAw = (
    files: GhAwRunFiles,
): Record<string, unknown> => {
    const summary: Record<string, unknown> = {};

    const emitted =
        files.safeOutputs === undefined ? [] : parseJsonl(files.safeOutputs);
    const posted =
        files.postedItems === undefined ? [] : parseJsonl(files.postedItems);

    // Verdict: the review-submission event the agent emitted. (The processed
    // items log records the posted review's URL but not its event, so the
    // emitted output is the only artifact that carries APPROVE vs
    // REQUEST_CHANGES.)
    for (const entry of emitted) {
        if (entry["type"] !== "submit_pull_request_review") {
            continue;
        }
        const event = entry["event"];
        if (event === "APPROVE" || event === "REQUEST_CHANGES") {
            summary["verdict"] = event;
        }
    }

    // Posted comments: prefer the handler's log of what actually landed;
    // fall back to the agent's emitted intent when the log is absent.
    const countComments = (entries: Record<string, unknown>[]): number =>
        entries.filter((entry) => {
            const type = entry["type"];
            return typeof type === "string" && COMMENT_ITEM_TYPES.has(type);
        }).length;
    summary["postedCommentCount"] =
        files.postedItems !== undefined
            ? countComments(posted)
            : countComments(emitted);

    // Cost: gh-aw's agent_usage.json (ai_credits are cents).
    if (isRecord(files.agentUsage)) {
        const credits = files.agentUsage["ai_credits"];
        const inputTokens = files.agentUsage["input_tokens"];
        const outputTokens = files.agentUsage["output_tokens"];
        const cost: Record<string, unknown> = {};
        if (typeof credits === "number" && Number.isFinite(credits)) {
            cost["usd"] = credits / 100;
        }
        if (
            typeof inputTokens === "number" &&
            typeof outputTokens === "number" &&
            Number.isFinite(inputTokens) &&
            Number.isFinite(outputTokens)
        ) {
            cost["tokens"] = inputTokens + outputTokens;
        }
        if (Object.keys(cost).length > 0) {
            summary["cost"] = cost;
        }
    }

    return summary;
};

/**
 * Source label for validator decisions that cannot be joined to a claim
 * (production artifacts do not include `claims.json`; see module docs).
 */
export const UNATTRIBUTED_SOURCE = "(unknown)";

/** One loaded run plus provenance the report footnotes. */
export type LoadedRun = {
    run: RunArtifacts;
    /** Whether the run carried (or could synthesize) a real verdict. */
    hasVerdict: boolean;
};

type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * Find a file by basename anywhere under `dir`, shallowest first (tolerates
 * the gh-aw artifact staging-path nesting). Returns the path or undefined.
 */
export const findArtifactFile = (
    dir: string,
    name: string,
): string | undefined => {
    let frontier: string[] = [dir];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const current of frontier) {
            let entries;
            try {
                entries = readdirSync(current, {withFileTypes: true});
            } catch {
                continue;
            }
            for (const entry of entries) {
                const path = join(current, entry.name);
                if (entry.isFile() && entry.name === name) {
                    return path;
                }
                if (entry.isDirectory()) {
                    next.push(path);
                }
            }
        }
        frontier = next;
    }
    return undefined;
};

const readIfFound = (
    dir: string,
    name: string,
    readFile: ReadFile,
): string | undefined => {
    const path = findArtifactFile(dir, name);
    if (path === undefined) {
        return undefined;
    }
    try {
        return readFile(path);
    } catch {
        return undefined;
    }
};

const parseIfFound = (
    dir: string,
    name: string,
    readFile: ReadFile,
): unknown => {
    const text = readIfFound(dir, name, readFile);
    if (text === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
};

/** Load one run directory into {@link RunArtifacts}, best-effort. */
export const loadRunDir = (
    dir: string,
    readFile: ReadFile = defaultReadFile,
): LoadedRun => {
    const claims = parseIfFound(dir, "claims.json", readFile);
    const validator = parseIfFound(dir, "claim-validator.json", readFile);

    let summary = parseIfFound(dir, "summary.json", readFile);
    if (!isRecord(summary)) {
        const files: GhAwRunFiles = {};
        const safeOutputs = readIfFound(dir, "safeoutputs.jsonl", readFile);
        if (safeOutputs !== undefined) {
            files.safeOutputs = safeOutputs;
        }
        const postedItems = readIfFound(
            dir,
            "safe-output-items.jsonl",
            readFile,
        );
        if (postedItems !== undefined) {
            files.postedItems = postedItems;
        }
        const agentUsage = parseIfFound(dir, "agent_usage.json", readFile);
        if (agentUsage !== undefined) {
            files.agentUsage = agentUsage;
        }
        summary = synthesizeSummaryFromGhAw(files);
    }

    const hasVerdict = isRecord(summary) && summary["verdict"] !== undefined;
    const run = normalizeRunArtifacts(
        {claims, validator, summary},
        basename(dir),
        UNATTRIBUTED_SOURCE,
    );
    return {run, hasVerdict};
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Render the weekly counters report as job-summary Markdown. */
export const renderCountersMarkdown = (
    counters: RunCounters,
    runsWithoutVerdict: number,
): string => {
    const lines = [
        "## Review live counters",
        "",
        `Aggregated over **${counters.runCount}** review runs.`,
        "",
        "### Verdict mix",
        "",
        "| APPROVE | REQUEST_CHANGES | HOLD_FOR_HUMAN* |",
        "| --- | --- | --- |",
        `| ${counters.verdictMix.APPROVE} | ${counters.verdictMix.REQUEST_CHANGES} | ${counters.verdictMix.HOLD_FOR_HUMAN} |`,
        "",
        `*${runsWithoutVerdict} run(s) submitted no review this window (e.g. the` +
            " redundant-approval skip) and count under the HOLD_FOR_HUMAN fallback.",
        "",
        "### Comments and validator",
        "",
        `- Posted comments: **${counters.totalComments}** total,` +
            ` **${counters.commentsPerRun.toFixed(2)}**/run`,
        `- Validator drop rate (all sources): **${pct(
            counters.overallValidatorDropRate,
        )}**`,
    ];

    if (counters.validatorDropBySource.length > 0) {
        lines.push(
            "",
            "| Source | Judged | Dropped | Drop rate |",
            "| --- | --- | --- | --- |",
        );
        for (const source of counters.validatorDropBySource) {
            lines.push(
                `| ${source.source} | ${source.total} | ${
                    source.dropped
                } | ${pct(source.dropRate)} |`,
            );
        }
    }

    lines.push("", "### Thumbs and cost", "");
    lines.push(
        counters.thumbs.agreeRate === null
            ? "- Thumbs: none recorded in per-run artifacts (live tallies are" +
                  " reported by each thumbs-sweep run's job summary)"
            : `- Thumbs: ${counters.thumbs.up} 👍 / ${counters.thumbs.down} 👎` +
                  ` (agree rate ${pct(counters.thumbs.agreeRate)})`,
    );
    lines.push(
        counters.cost.usdPerRun === null
            ? "- Cost: not recorded"
            : `- Cost: $${(counters.cost.totalUsd ?? 0).toFixed(2)} total,` +
                  ` $${counters.cost.usdPerRun.toFixed(2)}/run`,
    );
    lines.push("");
    return lines.join("\n");
};

const main = (): void => {
    const runsDir = process.argv[2];
    if (runsDir === undefined) {
        throw new Error("usage: counters-report.ts <runs-dir>");
    }

    const runDirs = readdirSync(runsDir, {withFileTypes: true})
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(runsDir, entry.name))
        .sort();

    const loaded = runDirs.map((dir) => loadRunDir(dir));
    const counters = computeRunCounters(loaded.map(({run}) => run));
    const runsWithoutVerdict = loaded.filter(
        ({hasVerdict}) => !hasVerdict,
    ).length;

    const markdown = renderCountersMarkdown(counters, runsWithoutVerdict);
    process.stdout.write(`${JSON.stringify(counters, null, 2)}\n`);

    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath !== undefined && summaryPath.trim() !== "") {
        appendFileSync(summaryPath, markdown);
    } else {
        process.stderr.write(markdown);
    }
};

// Run only when invoked directly, never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    main();
}
