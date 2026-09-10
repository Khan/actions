/** Generic plan/run/merge entry point, usable locally or from a CI matrix.
 * Only `run` dispatches models. Plans pin both sources before jobs fan out. */
/* eslint-disable no-console -- CLI progress and diagnostics. */
import {execFileSync, spawnSync} from "node:child_process";
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {loadLiveCorpus} from "./corpus/loader";
import {selectCases} from "./live-ab";
import type {RunHeader} from "./live-ab-report";
import {
    renderMarkdownReport,
    renderMultiMarkdownReport,
} from "./live-ab-report";
import {
    mergeShards,
    type ShardInput,
    type ShardReceipt,
} from "./live-ab-shard-merge";
import {
    contentHash,
    planShards,
    shardArgs,
    type ShardPlan,
} from "./live-ab-shards";
import {extractTierBudgets} from "./runtime-config";
import {READ_TOOL_POLICY} from "./read-scope";
import {readOverlayRates} from "../lib/pricing";

const arg = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index < 0 ? undefined : process.argv[index + 1];
};
const git = (...args: string[]): string =>
    execFileSync("git", args, {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
const writeJson = (path: string, value: unknown): void => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(value, null, 2));
};

const readHeader = (baseRef: string): RunHeader => {
    const budgets = "workflows/review/lib/budgets.ts";
    const runtime = (text: string) => ({
        tierBudgets: extractTierBudgets(text),
        disabledReviewers: [],
        reReviewMode: "full",
    });
    return {
        baseRef,
        reviewMdSha: {
            baseline: contentHash(
                git("show", `${baseRef}:workflows/review/review.md`),
            ),
            candidate: contentHash(
                readFileSync("workflows/review/review.md", "utf8"),
            ),
        },
        runtime: {
            baseline: runtime(git("show", `${baseRef}:${budgets}`)),
            candidate: runtime(readFileSync(budgets, "utf8")),
        },
        provenance: {
            matcher: "deterministic-v2+posting-v1+threads-v2+arbiter",
            corpusSha: "",
            caseCount: 0,
            toolPolicy: READ_TOOL_POLICY,
        },
    };
};

const main = (): void => {
    const mode = process.argv[2];
    const planPath = arg("--plan") ?? "out/live-ab-plan.json";
    if (mode === "plan") {
        const baseRef = git(
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${arg("--base-ref") ?? "origin/main"}^{commit}`,
        ).trim();
        const candidateSha = git("rev-parse", "HEAD").trim();
        const plan = planShards(loadLiveCorpus(), {
            candidateSha,
            header: readHeader(baseRef),
            full: !process.argv.includes("--smoke-only"),
            ...(arg("--cases")
                ? {
                      caseFilter: arg("--cases")!
                          .split(",")
                          .map((id) => id.trim())
                          .filter(Boolean),
                  }
                : {}),
            ...(arg("--shards") ? {shards: Number(arg("--shards"))} : {}),
            ...(arg("--max-usd") ? {maxUsd: Number(arg("--max-usd"))} : {}),
            ...(arg("--repeats") ? {repeats: Number(arg("--repeats"))} : {}),
            forceArms: process.argv.includes("--force-arms"),
        });
        writeJson(planPath, plan);
        const output = process.env["GITHUB_OUTPUT"];
        if (output) {
            appendFileSync(
                output,
                `matrix=${JSON.stringify({
                    include: plan.shards.map(({id}) => ({id})),
                })}\ncandidate_sha=${candidateSha}\nenabled=true\n`,
            );
        }
        console.log(
            `${plan.caseIds.length} cases, ${plan.shards.length} shards, ${plan.repeats} repeats per arm, $${plan.maxUsd} total dispatch budget`,
        );
        return;
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as ShardPlan;
    if (
        plan.version !== 1 ||
        git("rev-parse", "HEAD").trim() !== plan.candidateSha
    ) {
        throw new Error("plan version or candidate checkout mismatch");
    }
    if (mode === "run") {
        const id = Number(arg("--shard"));
        const args = shardArgs(plan, id);
        const current = readHeader(plan.header.baseRef);
        const shard = plan.shards.find((s) => s.id === id)!;
        const selected = selectCases(loadLiveCorpus(), {
            smokeOnly: false,
            caseFilter: shard.caseIds,
        });
        if (
            JSON.stringify(current.reviewMdSha) !==
                JSON.stringify(plan.header.reviewMdSha) ||
            JSON.stringify(current.runtime) !==
                JSON.stringify(plan.header.runtime) ||
            contentHash(JSON.stringify(selected)) !== shard.corpusSha
        ) {
            throw new Error("planned inputs changed before dispatch");
        }
        const directory =
            arg("--shard-dir") ?? join("out", "shards", `live-ab-shard-${id}`);
        const receiptPath = join(directory, "receipt.json");
        const receipt: ShardReceipt = {
            id,
            planSha: contentHash(JSON.stringify(plan)),
            exitCode: null,
        };
        writeJson(receiptPath, receipt);
        const child = spawnSync(
            "pnpm",
            [
                ...args,
                "--out",
                join(directory, "live-ab-report.json"),
                "--transcripts-dir",
                arg("--transcripts-dir") ?? join(directory, "transcripts"),
            ],
            {stdio: "inherit"},
        );
        receipt.exitCode = child.status;
        writeJson(receiptPath, receipt);
        process.exitCode = child.status ?? 1;
        return;
    }
    if (mode !== "merge") {
        throw new Error("expected plan, run, or merge");
    }
    const out = arg("--out") ?? "out/live-ab-report.json";
    let payload: unknown;
    let markdown: string;
    try {
        const directory = arg("--reports-dir") ?? "out/shards";
        const inputs = plan.shards.map(({id}): ShardInput => {
            const path = join(directory, `live-ab-shard-${id}`);
            const receipt = JSON.parse(
                readFileSync(join(path, "receipt.json"), "utf8"),
            ) as ShardReceipt;
            const report = JSON.parse(
                readFileSync(join(path, "live-ab-report.json"), "utf8"),
            ) as ShardInput["report"];
            return {...receipt, report};
        });
        const merged = mergeShards(plan, inputs);
        payload = merged;
        const options = {
            khanRates: readOverlayRates(
                readFileSync("workflows/review/review.md", "utf8"),
            ),
        };
        markdown =
            "noReviewableDelta" in merged
                ? "## Review live A/B\n\nNo reviewable delta. Both arms have identical prompts and runtime config, so no model calls ran.\n"
                : "repeats" in merged
                ? renderMultiMarkdownReport(merged, options)
                : renderMarkdownReport(merged, options);
        markdown = markdown.replaceAll(
            "| Wall clock |",
            "| Arm work (summed across shards) |",
        );
        markdown += `\nMerged ${plan.shards.length} shards, ${plan.caseIds.length} cases, ${plan.repeats} repeats per arm. Elapsed time is in the workflow jobs, arm work above is summed rather than elapsed parallel time.\n`;
        if (
            !("noReviewableDelta" in merged) &&
            merged.adversarialFailures.length
        ) {
            process.exitCode = 1;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        payload = {partial: true, shardError: message, plan};
        markdown = `## Review live A/B (incomplete)\n\nShard merge failed: ${message}\n\nThis is not a complete measurement. Per-shard reports and transcripts remain in the run artifacts. No pooled results or gate pass are claimed.\n`;
        process.exitCode = 1;
    }
    writeJson(out, payload);
    writeFileSync(out.replace(/\.json$/, ".md"), markdown);
    if (process.env["GITHUB_STEP_SUMMARY"]) {
        appendFileSync(process.env["GITHUB_STEP_SUMMARY"], markdown);
    }
    console.log(markdown);
};

if (process.argv[1]?.endsWith("live-ab-shard-cli.ts")) {
    try {
        main();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
