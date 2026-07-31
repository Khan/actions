/**
 * Deterministic staging: fetch everything the plan needs, in code, in one step.
 *
 * This module exists because the first live run measured the cost of NOT having
 * it. Step 1 used to be prose telling the agent which five files to write; the
 * agent improvised, and staging alone burned roughly fifteen of the run's 131
 * assistant turns (seven creating a directory, five hand-assembling JSON through
 * repeated `node -e` scripts, three reading this workflow's own library source
 * to work out what the plan would decide). Turns are what autofix costs: each
 * one re-reads the whole accumulated context, so 131 turns over a ~43k-token
 * context read 5.6M cached tokens and 61% of the run's bill was cache reads.
 * Caching was working near-optimally (a 40:1 read-to-write ratio); there were
 * simply too many turns.
 *
 * So staging moves across the determinism boundary to join the plan. CODE
 * fetches and writes; the MODEL reads the result. That is the same split
 * `plan.ts` already draws, and the same one the reviewer draws throughout; it
 * was an oversight that staging sat on the wrong side of it.
 *
 * Correctness matters here as much as cost. The old prose had to ask the agent
 * to stage each comment body "verbatim as the tool returned it", because a
 * reformatted body breaks the `**label:**` parse that decides whether a finding
 * is in scope. An instruction like that is a hope. Code copying a string is a
 * guarantee.
 *
 * No new runtime dependency: this talks to the GitHub API with the global
 * `fetch` Node provides, unlike the thumbs sweep, which predates that and pulls
 * in octokit. Network access sits behind {@link StagePort} so the whole module
 * is unit-testable without a socket.
 *
 * The unified diff is rebuilt by the reviewer's own `buildUnifiedDiff`
 * (`stage-pr.ts`, the orchestrator's staging slice) rather than a local copy.
 * An earlier local copy emitted `diff --git a/<name> b/<name>` from `filename`
 * alone, which is wrong for a rename and for an add or delete; the shared one
 * carries `previous_filename` and the `/dev/null` sides. One rebuilder also
 * means one thing for `splitUnifiedDiff` to keep parsing.
 */

import {buildUnifiedDiff} from "../../review/lib/stage-pr.ts";
import type {StagedThread} from "../../review/lib/rereview.ts";
import type {PriorReview} from "../../review/lib/rereview-mode.ts";
import {
    assertNoGraphqlErrors,
    collectUnresolvedThreads,
    sameLogin,
} from "../../review/lib/threads.ts";

// Re-exported for the CLI transport below and for this module's tests: the
// guard moved to the shared module with the fetch it protects, and both callers
// still want it by this name.
export {assertNoGraphqlErrors};

/** The five files the plan CLI reads, plus the head SHA the prompt re-checks. */
export type StagedInputs = {
    labels: string[];
    threads: StagedThread[];
    priorReviews: PriorReview[];
    diffText: string;
    commitMessages: string[];
    /**
     * The SHA the agent's edits are actually made against.
     *
     * Read from the job's checkout, not from the API. Khan/actions#298 review:
     * comparing an API read against a checkout taken earlier leaves a window in
     * which a push lands between the two, and both reads then agree while the
     * working tree is already stale. The checkout's own HEAD closes it.
     */
    headSha: string;
    /**
     * Whether the PR's head is a fork.
     *
     * Staged because the command path cannot gate on it: `issue_comment`
     * carries no `github.event.pull_request`, so the workflow's `if:` cannot
     * check the fork there, and it has to be enforced after the job starts.
     */
    isFork: boolean;
};

/** Everything this module needs from the outside world. */
export type StagePort = {
    /** The checked-out HEAD (`git rev-parse HEAD`), or "" when unavailable. */
    checkoutHeadSha: () => string;
    /** A REST GET, following pagination; returns the concatenated array. */
    restPaged: (path: string) => Promise<unknown[]>;
    /** A single REST GET returning one object. */
    rest: (path: string) => Promise<unknown>;
    /** A GraphQL POST. */
    graphql: (
        query: string,
        variables: Record<string, unknown>,
    ) => Promise<unknown>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Collect the bot's unresolved threads, newest page last.
 *
 * A thread is kept when it is unresolved and its FIRST comment is the bot's:
 * that opener is the finding. A thread a human started is somebody else's
 * conversation and autofix stays out of it, which is the same line the reviewer
 * draws with its `human-threads.json`; and, since that file became code-staged
 * too, it is drawn from the very same fetch. The GraphQL query, its paging, and
 * its fail-closed guards now live once in `review/lib/threads.ts`, along with
 * the suffix-stripped login comparison that a REST/GraphQL split makes
 * mandatory (Khan/webapp#41140 staged `threadCount: 0` on a PR carrying five
 * threads because a configured `github-actions[bot]` never matched GraphQL's
 * bare `github-actions`). All this function adds is the by-opener filter.
 */
export const collectThreads = async (
    port: StagePort,
    owner: string,
    repo: string,
    number: number,
    botLogin: string,
): Promise<StagedThread[]> =>
    (await collectUnresolvedThreads(port.graphql, owner, repo, number)).filter(
        (thread) =>
            thread.comments.length > 0 &&
            sameLogin(thread.comments[0].author, botLogin),
    );

/** Fetch everything the plan needs. */
export const collectInputs = async (
    port: StagePort,
    owner: string,
    repo: string,
    number: number,
    botLogin: string,
): Promise<StagedInputs> => {
    const base = `/repos/${owner}/${repo}/pulls/${number}`;

    const checkoutSha = port.checkoutHeadSha();
    const pr = await port.rest(base);
    const prRec = isRecord(pr) ? pr : {};
    const rawLabels = Array.isArray(prRec["labels"]) ? prRec["labels"] : [];
    const head = isRecord(prRec["head"]) ? prRec["head"] : {};
    const headRepo = isRecord(head["repo"]) ? head["repo"] : {};
    // Absent or unreadable repo data reads as a fork, so the guard fails closed.
    const headRepoName = str(headRepo["full_name"]);
    const isFork = headRepoName === "" || headRepoName !== `${owner}/${repo}`;

    const [reviews, files, commits, threads] = await Promise.all([
        port.restPaged(`${base}/reviews`),
        port.restPaged(`${base}/files`),
        port.restPaged(`${base}/commits`),
        collectThreads(port, owner, repo, number, botLogin),
    ]);

    return {
        labels: rawLabels
            .filter(isRecord)
            .map((l) => str(l["name"]))
            .filter((n) => n !== ""),
        threads,
        // Every review by the bot, whatever its state: the fingerprint stamp
        // lives in the body, and a dismissed or comment-only review still
        // carries one.
        priorReviews: reviews
            .filter(isRecord)
            .filter(
                (r) =>
                    isRecord(r["user"]) &&
                    sameLogin(str(r["user"]["login"]), botLogin),
            )
            .map((r) => ({
                body: str(r["body"]),
                submittedAt: str(r["submitted_at"]),
            })) as PriorReview[],
        diffText: buildUnifiedDiff(
            files as Parameters<typeof buildUnifiedDiff>[0],
        ),
        commitMessages: commits
            .filter(isRecord)
            .map((c) =>
                isRecord(c["commit"]) ? str(c["commit"]["message"]) : "",
            )
            .filter((m) => m !== ""),
        isFork,
        // Prefer the checkout; fall back to the API only when the working tree
        // is unavailable, in which case a stale-base push is still possible.
        headSha: checkoutSha !== "" ? checkoutSha : str(head["sha"]),
    };
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

export type StageCliFs = {
    mkdirSync: (path: string, opts: {recursive: true}) => void;
    writeFileSync: (path: string, data: string) => void;
};

export const AUTOFIX_DIR = "/tmp/gh-aw/autofix";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Write the staged files.
 *
 * `command` is the triggering `/autofix` comment body when one exists. It is
 * written only on that path: `plan.ts` treats the file's ABSENCE as "this run
 * was armed by a label", so writing an empty file would silently switch the
 * resolver's surface.
 */
export const writeInputs = (
    fs: StageCliFs,
    inputs: StagedInputs,
    dir = AUTOFIX_DIR,
    command?: string,
): void => {
    fs.mkdirSync(`${dir}/out`, {recursive: true});
    fs.writeFileSync(`${dir}/labels.json`, json(inputs.labels));
    fs.writeFileSync(`${dir}/threads.json`, json(inputs.threads));
    fs.writeFileSync(`${dir}/prior-reviews.json`, json(inputs.priorReviews));
    fs.writeFileSync(`${dir}/pr.diff`, inputs.diffText);
    fs.writeFileSync(`${dir}/commits.json`, json(inputs.commitMessages));
    fs.writeFileSync(`${dir}/head-sha.txt`, `${inputs.headSha}\n`);
    fs.writeFileSync(`${dir}/context.json`, json({isFork: inputs.isFork}));
    if (command !== undefined && command.trim() !== "") {
        // Verbatim, trailing CRLF included: the parser's tolerance of the shape
        // the GitHub web UI produces is only meaningful if the shape survives.
        fs.writeFileSync(`${dir}/command.txt`, command);
    }
};

// Run only when executed directly (autofix.md), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs");
    const env = (name: string): string => {
        const v = process.env[name];
        if (v === undefined || v.trim() === "") {
            throw new Error(`${name} must be set`);
        }
        return v.trim();
    };

    const token = env("GITHUB_TOKEN");
    const [owner, repo] = env("GITHUB_REPOSITORY").split("/");
    const number = Number(env("AUTOFIX_PR_NUMBER"));
    const botLogin =
        process.env.AUTOFIX_BOT_LOGIN?.trim() || "github-actions[bot]";
    const api = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";

    const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "khan-autofix",
    };

    const {execFileSync} = require("node:child_process");
    const port: StagePort = {
        checkoutHeadSha: () => {
            try {
                return String(
                    execFileSync("git", ["rev-parse", "HEAD"], {
                        cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
                        encoding: "utf-8",
                    }),
                ).trim();
            } catch {
                return "";
            }
        },
        rest: async (path) => {
            const res = await fetch(`${api}${path}`, {headers});
            if (!res.ok) {
                throw new Error(`GET ${path} failed: ${res.status}`);
            }
            return res.json();
        },
        restPaged: async (path) => {
            const out: unknown[] = [];
            // 100 is the API maximum; the cap bounds a pathological PR rather
            // than silently truncating a normal one.
            for (let page = 1; page <= 20; page++) {
                const sep = path.includes("?") ? "&" : "?";
                const res = await fetch(
                    `${api}${path}${sep}per_page=100&page=${page}`,
                    {headers},
                );
                if (!res.ok) {
                    throw new Error(`GET ${path} failed: ${res.status}`);
                }
                const batch = await res.json();
                if (!Array.isArray(batch) || batch.length === 0) {
                    break;
                }
                out.push(...batch);
                if (batch.length < 100) {
                    break;
                }
            }
            return out;
        },
        graphql: async (query, variables) => {
            const res = await fetch(`${api}/graphql`, {
                method: "POST",
                headers: {...headers, "content-type": "application/json"},
                body: JSON.stringify({query, variables}),
            });
            if (!res.ok) {
                throw new Error(`GraphQL failed: ${res.status}`);
            }
            // Duplicated in `collectThreads`, deliberately. The guard is cheap
            // and its absence clears the arming label on a PR with open
            // findings, so it belongs both at the transport (any future
            // GraphQL caller inherits it) and at the reader (which is the one
            // the unit tests can reach).
            const body = await res.json();
            assertNoGraphqlErrors(body);
            return body;
        },
    };

    collectInputs(port, owner, repo, number, botLogin)
        .then((inputs) => {
            writeInputs(
                {
                    mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
                    writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
                },
                inputs,
                AUTOFIX_DIR,
                process.env.AUTOFIX_COMMAND_BODY,
            );
            // eslint-disable-next-line no-console
            console.log(
                JSON.stringify({
                    labels: inputs.labels,
                    threadCount: inputs.threads.length,
                    reviewCount: inputs.priorReviews.length,
                    commitCount: inputs.commitMessages.length,
                    diffBytes: inputs.diffText.length,
                    headSha: inputs.headSha,
                }),
            );
        })
        .catch((error) => {
            // eslint-disable-next-line no-console
            console.error(`staging failed: ${error?.message ?? error}`);
            process.exit(1);
        });
}
