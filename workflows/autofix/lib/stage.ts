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
 * Compare two GitHub logins across the REST/GraphQL bot-suffix split.
 *
 * REST reports an App's login as `github-actions[bot]`; GraphQL reports the
 * same actor as `github-actions`. Staging reads threads over GraphQL and
 * reviews over REST, so a single spelling cannot match both. Comparing on the
 * suffix-stripped form does.
 *
 * This is not hypothetical: the first run with deterministic staging staged
 * `threadCount: 0` on a PR carrying five reviewer threads, because every
 * GraphQL author was `github-actions` and the configured login was
 * `github-actions[bot]` (Khan/webapp#41140, run 30416237794). Unit tests could
 * not have caught it; the fixtures were written in the REST spelling.
 */
const baseLogin = (login: string): string =>
    login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;

const sameLogin = (a: string, b: string): boolean =>
    baseLogin(a).toLowerCase() === baseLogin(b).toLowerCase();

/**
 * Review threads with their full reply chain.
 *
 * `comments(first: 100)` rather than the sweep's `first: 1`: the reconciler
 * contract wants the whole chain, because an author's reply is often what says
 * a finding is already handled. `isResolved` is fetched so resolved threads can
 * be dropped here rather than downstream.
 */
const THREADS_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                    id
                    isResolved
                    path
                    line
                    comments(first: 100) {
                        nodes { author { login } body url }
                    }
                }
            }
        }
    }
}`;

const threadsConnectionOf = (
    body: unknown,
): Record<string, unknown> | undefined => {
    if (!isRecord(body)) {
        return undefined;
    }
    const data = body["data"];
    if (!isRecord(data)) {
        return undefined;
    }
    const repository = data["repository"];
    if (!isRecord(repository)) {
        return undefined;
    }
    const pullRequest = repository["pullRequest"];
    if (!isRecord(pullRequest)) {
        return undefined;
    }
    const threads = pullRequest["reviewThreads"];
    return isRecord(threads) ? threads : undefined;
};

/**
 * Collect the bot's unresolved threads, newest page last.
 *
 * A thread is kept when it is unresolved and its FIRST comment is the bot's:
 * that opener is the finding. A thread a human started is somebody else's
 * conversation and autofix stays out of it, which is the same line the reviewer
 * draws with its `human-threads.json`.
 */
export const collectThreads = async (
    port: StagePort,
    owner: string,
    repo: string,
    number: number,
    botLogin: string,
): Promise<StagedThread[]> => {
    const out: StagedThread[] = [];
    let cursor: string | null = null;

    for (;;) {
        const body = await port.graphql(THREADS_QUERY, {
            owner,
            repo,
            number,
            cursor,
        });
        const conn = threadsConnectionOf(body);
        if (conn === undefined) {
            break;
        }

        const nodes = Array.isArray(conn["nodes"]) ? conn["nodes"] : [];
        for (const node of nodes) {
            if (!isRecord(node) || node["isResolved"] === true) {
                continue;
            }

            const commentsConn = isRecord(node["comments"])
                ? node["comments"]
                : {};
            const rawComments = Array.isArray(commentsConn["nodes"])
                ? commentsConn["nodes"]
                : [];
            const comments = rawComments.filter(isRecord).map((c) => ({
                author: isRecord(c["author"]) ? str(c["author"]["login"]) : "",
                // Verbatim. The label parser reads the leading `**label:**` off
                // this string; normalising it here is how a finding becomes
                // unclassifiable.
                body: str(c["body"]),
            }));
            if (
                comments.length === 0 ||
                !sameLogin(comments[0].author, botLogin)
            ) {
                continue;
            }

            const firstUrl = isRecord(rawComments[0])
                ? str(rawComments[0]["url"])
                : "";
            out.push({
                thread_id: str(node["id"]),
                path: str(node["path"]),
                line: typeof node["line"] === "number" ? node["line"] : null,
                ...(firstUrl === "" ? {} : {url: firstUrl}),
                comments,
            });
        }

        const pageInfo = isRecord(conn["pageInfo"]) ? conn["pageInfo"] : {};
        if (pageInfo["hasNextPage"] !== true) {
            break;
        }
        const next = pageInfo["endCursor"];
        if (typeof next !== "string" || next === "") {
            break;
        }
        cursor = next;
    }

    return out;
};

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
            return res.json();
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
