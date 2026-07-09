/**
 * CLI entry for the thumbs feedback sweep — the script the consumer repos'
 * scheduled `review-feedback` workflows run:
 *
 *     cd gh-aw-review-lib/workflows/review && npm install --omit=dev &&
 *       npx -y tsx lib/run-thumbs-sweep.ts
 *
 * (The `npm install` supplies `octokit`, this package's one runtime
 * dependency — unlike the router/investigation-cap scripts, the sweep talks to
 * the GitHub API. It is pinned exactly in `package.json`, so a consumer run
 * resolves the same client version this release was tested with.)
 *
 * All configuration is environment variables, so the consumer workflow is pure
 * YAML with no arguments to quote:
 *
 *   GITHUB_TOKEN                  required; the workflow's token
 *                                 (`pull-requests: write` is the only scope the
 *                                 sweep needs).
 *   GITHUB_REPOSITORY             `owner/repo`; provided by Actions.
 *   REVIEW_SWEEP_BOT_LOGIN        login the reviewer posts as
 *                                 (default `github-actions[bot]`).
 *   REVIEW_SWEEP_SEED_REACTIONS   `true` to seed the 👍/👎 nudge pair
 *                                 (default `false`).
 *   REVIEW_SWEEP_LOOKBACK_DAYS    PR-activity window (default 14).
 *   REVIEW_SWEEP_MAX_PULLS        traversal cap (default 200).
 *
 * Output: the full {@link SweepResult} as JSON on stdout, and — when
 * `GITHUB_STEP_SUMMARY` is set — a Markdown digest appended to the job summary
 * so every sweep run is auditable from the Actions UI.
 */

import {appendFileSync} from "node:fs";

import {Octokit} from "octokit";

import {sweepThumbs, type SweepResult} from "./thumbs-sweep.ts";
import {
    GithubThumbsSweepPort,
    type OctokitRequestFn,
    type SweepTraversalStats,
} from "./thumbs-sweep-github.ts";

const env = (name: string): string | undefined => {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value;
};

const intEnv = (name: string): number | undefined => {
    const raw = env(name);
    if (raw === undefined) {
        return undefined;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got: ${raw}`);
    }
    return value;
};

/** Render the auditable Markdown digest for the job summary. */
export const renderSweepSummary = (
    result: SweepResult,
    stats: SweepTraversalStats,
): string => {
    const byReason = new Map<string, number>();
    for (const action of result.actions) {
        byReason.set(action.reason, (byReason.get(action.reason) ?? 0) + 1);
    }
    const downvoted = result.actions.filter((a) => a.downvotes > 0);

    const lines = [
        "## Thumbs feedback sweep",
        "",
        `- Reviewer comments swept: **${result.actions.length}** across ${stats.pullsScanned} recently-active PRs`,
        `- Live thumbs observed (bot's own seeds excluded): **${stats.thumbs.up} 👍 / ${stats.thumbs.down} 👎**`,
        `- Follow-ups posted this sweep: **${result.followupsPosted}**` +
            ` (already followed up: ${
                byReason.get("already-followed-up") ?? 0
            })`,
        `- Nudge reactions seeded this sweep: **${result.reactionsSeeded}**`,
        `- GitHub API requests used: ${stats.apiRequests}`,
    ];

    if (downvoted.length > 0) {
        lines.push(
            "",
            "| Grain | Comment | 👎 | Action |",
            "| --- | --- | --- | --- |",
        );
        for (const action of downvoted) {
            lines.push(
                `| ${action.grain} | ${action.commentId} | ${action.downvotes} | ${action.reason} |`,
            );
        }
    }

    lines.push("");
    return lines.join("\n");
};

const main = async (): Promise<void> => {
    const token = env("GITHUB_TOKEN");
    if (token === undefined) {
        throw new Error("GITHUB_TOKEN is required");
    }
    const repository = env("GITHUB_REPOSITORY");
    if (repository === undefined || !repository.includes("/")) {
        throw new Error("GITHUB_REPOSITORY must be set to owner/repo");
    }
    const [owner, repo] = repository.split("/", 2) as [string, string];

    const botLogin = env("REVIEW_SWEEP_BOT_LOGIN") ?? "github-actions[bot]";
    const seedReactions = env("REVIEW_SWEEP_SEED_REACTIONS") === "true";
    const lookbackDays = intEnv("REVIEW_SWEEP_LOOKBACK_DAYS");
    const maxPulls = intEnv("REVIEW_SWEEP_MAX_PULLS");

    // `Octokit` from the `octokit` package ships the throttling/retry plugins,
    // so secondary-rate-limit pauses are handled by the client instead of
    // failing the scheduled run.
    const octokit = new Octokit({auth: token});
    const request: OctokitRequestFn = (route, params) =>
        octokit.request(route, params);

    const port = new GithubThumbsSweepPort(request, {
        owner,
        repo,
        botLogin,
        ...(lookbackDays !== undefined ? {lookbackDays} : {}),
        ...(maxPulls !== undefined ? {maxPulls} : {}),
    });

    const result = await sweepThumbs(port, {
        owner,
        repo,
        botLogin,
        seedReactions,
    });
    const stats = port.stats();

    process.stdout.write(`${JSON.stringify({result, stats}, null, 2)}\n`);

    const summaryPath = env("GITHUB_STEP_SUMMARY");
    if (summaryPath !== undefined) {
        appendFileSync(summaryPath, renderSweepSummary(result, stats));
    }
};

// Run only when invoked directly (`npx tsx lib/run-thumbs-sweep.ts`), never
// on import (tests import `renderSweepSummary`). Same guard as the other lib
// CLIs (`investigation-cap.ts`).
if (typeof require !== "undefined" && require.main === module) {
    main().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exitCode = 1;
    });
}
