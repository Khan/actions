/**
 * CLI entry for the thumbs feedback sweep — the script the consumer repos'
 * scheduled `review-feedback` workflows run:
 *
 *     cd gh-aw-review-lib/workflows/review && npm ci --omit=dev &&
 *       npx -y tsx lib/run-thumbs-sweep.ts
 *
 * (The `npm ci` supplies `octokit`, this package's one runtime
 * dependency — unlike the router/investigation-cap scripts, the sweep talks to
 * the GitHub API. It is pinned exactly in `package.json` and its transitive
 * tree is locked by the committed `package-lock.json`, so a consumer run
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
 *   REVIEW_SWEEP_LOOKBACK_DAYS    PR-activity window (default 14).
 *   REVIEW_SWEEP_MAX_PULLS        traversal cap (default 200).
 *   REVIEW_SWEEP_CLOSED_GRACE_DAYS  days a closed/merged PR stays in the
 *                                 sweep after closing (default 3).
 *   REVIEW_SWEEP_DRY_RUN          `true` to traverse and decide without
 *                                 posting anything (first-run
 *                                 audit; default `false`).
 *   REVIEW_SWEEP_WORKFLOW_IDS     comma-separated gh-aw workflow ids whose
 *                                 call-id markers identify the summary
 *                                 comment (default `review`).
 *
 * Output: the full {@link SweepResult} as JSON on stdout, and — when
 * `GITHUB_STEP_SUMMARY` is set — a Markdown digest appended to the job summary
 * so every sweep run is auditable from the Actions UI.
 */

import {appendFileSync} from "node:fs";

import {
    sweepThumbs,
    type SweepResult,
    type ThumbsSweepPort,
} from "./thumbs-sweep.ts";
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
    options: {dryRun?: boolean} = {},
): string => {
    const byReason = new Map<string, number>();
    for (const action of result.actions) {
        byReason.set(action.reason, (byReason.get(action.reason) ?? 0) + 1);
    }
    const downvoted = result.actions.filter((a) => a.downvotes > 0);

    const lines = [
        options.dryRun === true
            ? "## Thumbs feedback sweep (DRY RUN — nothing was posted)"
            : "## Thumbs feedback sweep",
        "",
        `- Reviewer comments swept: **${result.actions.length}** across ${stats.pullsScanned} recently-active PRs`,
        `- Live reactions observed (bot's own excluded; 👍/❤️/🎉/🚀 vs 👎/😕): **${stats.reactions.positive} positive / ${stats.reactions.negative} negative**`,
        `- Reviewer inline threads resolved: **${stats.resolvedInlineThreads}**`,
        `- Follow-ups posted this sweep: **${result.followupsPosted}**` +
            ` (already followed up: ${
                byReason.get("already-followed-up") ?? 0
            })`,
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
    const lookbackDays = intEnv("REVIEW_SWEEP_LOOKBACK_DAYS");
    const maxPulls = intEnv("REVIEW_SWEEP_MAX_PULLS");
    const closedGraceDays = intEnv("REVIEW_SWEEP_CLOSED_GRACE_DAYS");
    const dryRun = env("REVIEW_SWEEP_DRY_RUN") === "true";
    const reviewWorkflowIds = (env("REVIEW_SWEEP_WORKFLOW_IDS") ?? "review")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");

    // `Octokit` from the `octokit` package ships the throttling/retry plugins,
    // so secondary-rate-limit pauses are handled by the client instead of
    // failing the scheduled run. Loaded with a dynamic import because the
    // package is ESM-only while tsx runs this script as CJS (no `"type":
    // "module"` in this package); `import()` crosses that boundary, a static
    // import cannot.
    const {Octokit} = await import("octokit");
    const octokit = new Octokit({auth: token});
    const request: OctokitRequestFn = (route, params) =>
        octokit.request(route, params);

    const port = new GithubThumbsSweepPort(request, {
        owner,
        repo,
        botLogin,
        reviewWorkflowIds,
        ...(lookbackDays !== undefined ? {lookbackDays} : {}),
        ...(maxPulls !== undefined ? {maxPulls} : {}),
        ...(closedGraceDays !== undefined ? {closedGraceDays} : {}),
    });

    // Dry-run mode (`REVIEW_SWEEP_DRY_RUN=true`): traverse and decide exactly
    // as a real sweep would, but swallow the write call. Useful for a
    // first-run audit of what a repo's sweep WOULD post.
    const effectivePort: ThumbsSweepPort = dryRun
        ? {
              listBotComments: (grain) => port.listBotComments(grain),
              listExistingFollowups: () => port.listExistingFollowups(),
              postFollowup: async () => {},
          }
        : port;

    const result = await sweepThumbs(effectivePort, {
        owner,
        repo,
        botLogin,
    });
    const stats = port.stats();

    process.stdout.write(
        `${JSON.stringify({dryRun, result, stats}, null, 2)}\n`,
    );

    const summaryPath = env("GITHUB_STEP_SUMMARY");
    if (summaryPath !== undefined) {
        appendFileSync(
            summaryPath,
            renderSweepSummary(result, stats, {dryRun}),
        );
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
