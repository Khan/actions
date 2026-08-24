/**
 * The PR's unresolved review threads, with their full reply chains, fetched in
 * CODE.
 *
 * Why one module and not one per workflow: the reviewer's pre-agent staging
 * (`stage-pr.ts`) and autofix's (`workflows/autofix/lib/stage.ts`) want the
 * same thing (every unresolved review thread in the {@link StagedThread} shape
 * both workflows' downstream code already reads) and differ only in what they
 * do with a thread the bot did NOT open: the reviewer stages it as a human
 * thread so the dispatcher defers there, autofix ignores it. Autofix's copy
 * came first, and its comments record two bugs that each cost production runs:
 * the REST/GraphQL bot-suffix split, and GitHub answering a rate limit with
 * HTTP 200 plus an `errors` array. A second copy in the reviewer would have
 * had to re-derive both.
 *
 * REST cannot serve this. `GET /pulls/{n}/comments` carries neither a thread's
 * resolution state nor the `PRRT_…` node id that the
 * `resolve-pull-request-review-thread` safe output resolves by; GraphQL's
 * `reviewThreads` connection carries both.
 *
 * This module also owns the answer to "is this login our review bot", because
 * the producer's filter and the consumer's guard (`dedup-threads.ts`'s open-thread
 * suppression) must not be able to disagree about it. Khan/actions#302 was
 * exactly that disagreement one layer up: the prompt selected threads by one
 * spelling of the bot's login and the code admitted another, so a conforming
 * staging produced zero usable threads for a whole release.
 *
 * Determinism boundary: a GitHub fetch plus pure shape mapping. No model call,
 * no filesystem, no prose about the code under review.
 */

import type {StagedThread} from "./rereview";

/**
 * One authenticated GraphQL POST, returning the parsed response body (`data`
 * and `errors` both, unchecked: {@link assertNoGraphqlErrors} is the reader's
 * own guard). Injected so tests never touch the network.
 */
export type GhGraphql = (
    query: string,
    variables: Record<string, unknown>,
) => Promise<unknown>;

/** The login assumed when `REVIEW_BOT_LOGIN` is unset. */
export const DEFAULT_REVIEW_BOT_LOGIN = "github-actions[bot]";

/**
 * The login this workflow's own review comments are authored by, and the
 * single source of truth for that identity across the producer
 * (`stage-pr.ts`, which selects the bot's threads) and the consumers
 * (`dedup-threads.ts`'s suppression guard). Both layers read it here, which is the
 * property #302 lost when each spelled the identity itself.
 *
 * Deployment config, not a compiled-in constant, because the identity is a
 * property of the consumer's installation: a repo posting reviews under its own
 * GitHub App has a different login, and a login it cannot change would misfile
 * every one of its bot threads as human, which puts them in `skipLines` and
 * DROPS fresh findings on those lines. `REVIEW_BOT_LOGIN` matches the env its
 * siblings already take (autofix's `AUTOFIX_BOT_LOGIN`, the thumbs sweep's
 * `REVIEW_SWEEP_BOT_LOGIN`), same default.
 *
 * Read per call rather than captured at import so the value a CLI sets after
 * this module loads is still seen.
 */
export const reviewBotLogin = (): string =>
    process.env.REVIEW_BOT_LOGIN?.trim() || DEFAULT_REVIEW_BOT_LOGIN;

/**
 * Strip GitHub's App-login suffix.
 *
 * REST reports an App's login as `github-actions[bot]`; GraphQL reports the
 * same actor as bare `github-actions`. The reviewer reads threads over GraphQL
 * and prior reviews over REST, so a single spelling cannot match both surfaces
 * and every comparison here is on the suffix-stripped form.
 *
 * Not hypothetical, twice over: autofix's first deterministic-staging run
 * staged `threadCount: 0` on a PR carrying five reviewer threads because its
 * configured login was the bracketed form and every GraphQL author was the
 * bare one (Khan/webapp#41140, run 30416237794), and the reviewer's
 * open-thread suppression matched only the bracketed form for a whole release
 * (Khan/actions#302).
 *
 * Case-folded BEFORE the suffix test, not after: stripping first would leave a
 * `…[BOT]` spelling intact and compare it against an already-stripped login,
 * so the two would not match. Both GitHub surfaces emit the suffix lowercase
 * today, so this is cheap insurance rather than an observed failure.
 */
const baseLogin = (login: string): string => {
    const lowered = login.toLowerCase();
    return lowered.endsWith("[bot]")
        ? lowered.slice(0, -"[bot]".length)
        : lowered;
};

/** Whether two logins name the same account across the bot-suffix split. */
export const sameLogin = (a: string, b: string): boolean =>
    baseLogin(a) === baseLogin(b);

/**
 * Whether a login is ANY GitHub App (`[bot]`-suffixed), not just this
 * workflow's review bot. Lives here so the suffix spelling stays in the one
 * module that owns login identity ({@link baseLogin}); note this only sees
 * the REST spelling (GraphQL reports the bare login), so callers needing
 * "is this the review bot on either surface" want {@link isReviewBotAuthor}.
 */
export const isBotLogin = (login: string): boolean =>
    login.toLowerCase().endsWith("[bot]");

/** Whether a comment author is this workflow's review bot, either spelling. */
export const isReviewBotAuthor = (login: string): boolean =>
    sameLogin(login, reviewBotLogin());

/**
 * Review threads with their full reply chain.
 *
 * `comments(first: 100)` rather than the thumbs sweep's `first: 1`: the
 * reconciler contract wants the whole chain, because an author's reply is
 * often what says a finding is already handled. `isResolved` is fetched so
 * resolved threads are dropped here rather than downstream.
 *
 * `reactions(first: 10)`, NOT 100: GitHub prices a query by its potential
 * nodes (each page size multiplied down the nesting) against a 500,000 cap,
 * and rejects an over-budget query STATICALLY, before looking at the PR. At
 * 100 this query priced at 100 + 100*100 + 100*100*100 = 1,010,100, so every
 * staging failed with `MAX_NODE_LIMIT_EXCEEDED` whatever the PR held
 * (Khan/agent-settings#76 was the first consumer to hit it, on the v1.17.0
 * bump itself). 10 prices it at 110,100. The depth is semantically free:
 * only the opener's reactions are read (`openerDownvotes`), the consumer's
 * threshold is `> 0`, and the only non-human reaction to skip past is the
 * bot's own single nudge seed, so 10 attributable reactors is already 10x
 * what adjudication needs. The budget is pinned by a test in
 * stage-threads.test.ts; check it before widening any `first:` here.
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
                    resolvedBy { login }
                    path
                    line
                    comments(first: 100) {
                        nodes {
                            author { login }
                            body
                            url
                            reactions(first: 10, content: THUMBS_DOWN) {
                                nodes { user { login } }
                            }
                        }
                    }
                }
            }
        }
    }
}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string =>
    typeof value === "string" ? value : "";

/**
 * Throw when a GraphQL body carries errors, mirroring the REST paths' `throw`.
 *
 * GraphQL does not use HTTP status to report failure. GitHub answers
 * `RATE_LIMITED`, node-access failures, and partial field failures with HTTP
 * **200** and an `errors` array, `data` absent or partial. A transport that
 * only checks `res.ok` therefore reads a throttled response as a successful
 * one, and every downstream reader sees a PR with no threads.
 *
 * Any `errors` entry is fatal, the partial-data case included. Staging a
 * subset of the bot's threads is worse than refusing: for autofix the plan
 * fixes whatever arrived, clears the arming label, and reports a clean run;
 * for the reviewer the missing threads are neither resolved nor accounted for,
 * and a reduced-depth re-review can flip a prior REQUEST_CHANGES to APPROVE
 * past blocking threads it never saw.
 */
export const assertNoGraphqlErrors = (body: unknown): void => {
    if (!isRecord(body)) {
        return;
    }
    const errors = body["errors"];
    if (Array.isArray(errors) && errors.length > 0) {
        throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
    }
};

/**
 * Wrap a GraphQL transport so an HTTP-200 `RATE_LIMITED` answer is retried.
 *
 * This has to live at the transport and not beside one caller. GitHub reports a
 * throttle as HTTP **200** with a `RATE_LIMITED` entry in `errors`, so a
 * status-based retry (the REST path's) never sees it, and the thread fetch is a
 * hard prerequisite for both workflows: refusing is correct but expensive, and
 * a throttled runner must not fail a whole review over a retryable answer.
 * Owned here so autofix inherits it too; its port had none, so the first
 * throttle failed the run.
 *
 * Only `RATE_LIMITED` is retried. Every other error entry (a bad token, a
 * missing PR, a node-access failure) will not heal, so it propagates on the
 * first attempt rather than costing three.
 *
 * `sleep` is injected alongside the transport so a test can assert both
 * directions (retry-then-succeed, and propagate-without-retry) without waiting.
 */
export const withGraphqlRateLimitRetry = (
    graphql: GhGraphql,
    sleep: (ms: number) => Promise<void>,
    attempts = 3,
): GhGraphql => {
    return async (query, variables) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const body = await graphql(query, variables);
            try {
                assertNoGraphqlErrors(body);
                return body;
            } catch (error) {
                lastError = error;
                if (!/RATE_LIMITED/.test(String(error))) {
                    throw error;
                }
            }
            if (attempt < attempts - 1) {
                await sleep(1000 * (attempt + 1));
            }
        }
        throw lastError;
    };
};

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
 * A review thread as fetched, resolution state included. The `StagedThread`
 * fields carry the shape every downstream reader already consumes;
 * `resolved`/`resolvedBy` exist so ONE fetch can serve both the unresolved
 * partition (threads.json / human-threads.json) and the adjudicated corpus
 * (adjudicated-threads.json: bot threads a HUMAN resolved, which suppress
 * re-derivation of the defect they adjudicated — see dedup-adjudicated.ts's
 * `adjudicatedThreadsFromStaged`).
 */
export type FetchedThread = StagedThread & {
    resolved: boolean;
    /**
     * Who resolved the thread, suffix-stripped like every login comparison in
     * this module (`resolvedBy` arrives over GraphQL, so the bot appears as
     * bare `github-actions`; see {@link sameLogin}). Empty when the thread is
     * unresolved or the resolver is unattributable (a deleted account), and
     * an empty resolver never reads as human adjudication downstream.
     */
    resolvedBy: string;
    /**
     * How many 👎 reactions from ATTRIBUTABLE NON-BOT reactors the thread's
     * OPENING comment carries. The opener is the finding, so a downvote on it
     * is a reviewer's judgment on the finding itself (the thumbs sweep reacts
     * to exactly this signal); later comments' reactions are conversation,
     * not adjudication, and are not counted. 0 when there is no opener or the
     * API returned no connection.
     *
     * Reactor identity is filtered, not merely counted, for the same reason
     * the sweep's `countDownvotes` filters `r.user !== botLogin`: the review
     * workflow plans to seed the 👍/👎 nudge pair on its own comments at post
     * time (README, "Nudge seeding"), and a seeded 👎 is the presence of the
     * feedback widget, not a judgment on the finding. A raw `totalCount`
     * cannot exclude the bot, so it would put every nudge-seeded finding in
     * the adjudicated corpus the moment seeding ships.
     *
     * An unattributable reactor (a deleted account, GraphQL `user: null`) is
     * excluded too, matching {@link FetchedThread.resolvedBy}'s rule that an
     * empty identity never reads as human adjudication. This is deliberately
     * STRICTER than the sweep, whose `Reaction` doc treats a login-less
     * reaction as a real user's: the sweep's worst case is one wasted "why?"
     * question, while this count suppresses re-derivation of the defect, and
     * suppression on unverifiable authority is the expensive direction.
     */
    openerDownvotes: number;
};

/**
 * Every review thread on the PR, in API order, whoever opened it and whatever
 * its resolution state. Callers partition by opener
 * ({@link isReviewBotAuthor}) and by `resolved`; nothing here is filtered, so
 * the reviewer can stage the human threads it defers to, its own open
 * threads, and the human-adjudicated corpus from the same fetch.
 *
 * Fails closed on both shapes a failed query takes (an `errors` array, and a
 * body with no `reviewThreads` connection), because neither means "this PR has
 * no threads", and reading them that way is the one mistake this module cannot
 * afford (see {@link assertNoGraphqlErrors}).
 */
export const collectReviewThreads = async (
    graphql: GhGraphql,
    owner: string,
    repo: string,
    number: number,
): Promise<FetchedThread[]> => {
    const out: FetchedThread[] = [];
    let cursor: string | null = null;

    for (;;) {
        const body = await graphql(THREADS_QUERY, {
            owner,
            repo,
            number,
            cursor,
        });
        assertNoGraphqlErrors(body);
        const conn = threadsConnectionOf(body);
        if (conn === undefined) {
            throw new Error(
                `GraphQL returned no reviewThreads connection for ` +
                    `${owner}/${repo}#${number}`,
            );
        }

        const nodes = Array.isArray(conn["nodes"]) ? conn["nodes"] : [];
        for (const node of nodes) {
            if (!isRecord(node)) {
                continue;
            }
            const commentsConn = isRecord(node["comments"])
                ? node["comments"]
                : {};
            const rawComments = Array.isArray(commentsConn["nodes"])
                ? commentsConn["nodes"]
                : [];
            const comments = rawComments.filter(isRecord).map((comment) => ({
                author: isRecord(comment["author"])
                    ? str(comment["author"]["login"])
                    : "",
                // Verbatim. The label parsers (`rereview.ts`'s recap,
                // `dedup-threads.ts`'s suppression) read the leading `**label:**`
                // template off this string; normalising it here is how a
                // finding becomes unclassifiable.
                body: str(comment["body"]),
            }));
            const firstUrl = isRecord(rawComments[0])
                ? str(rawComments[0]["url"])
                : "";
            // `resolved` is strict on `=== true`: an absent or malformed
            // `isResolved` must not manufacture an adjudicated thread, and
            // reading it as unresolved only risks a duplicate comment.
            const resolved = node["isResolved"] === true;
            const openerReactions = isRecord(rawComments[0])
                ? rawComments[0]["reactions"]
                : undefined;
            const reactionNodes =
                isRecord(openerReactions) &&
                Array.isArray(openerReactions["nodes"])
                    ? openerReactions["nodes"]
                    : [];
            const openerDownvotes = reactionNodes.filter((reaction) => {
                if (!isRecord(reaction) || !isRecord(reaction["user"])) {
                    return false;
                }
                const login = str(reaction["user"]["login"]);
                return login !== "" && !isReviewBotAuthor(login);
            }).length;
            out.push({
                thread_id: str(node["id"]),
                path: str(node["path"]),
                line: typeof node["line"] === "number" ? node["line"] : null,
                ...(firstUrl === "" ? {} : {url: firstUrl}),
                comments,
                resolved,
                openerDownvotes,
                resolvedBy:
                    resolved && isRecord(node["resolvedBy"])
                        ? str(node["resolvedBy"]["login"])
                        : "",
            });
        }

        const pageInfo = isRecord(conn["pageInfo"]) ? conn["pageInfo"] : {};
        if (pageInfo["hasNextPage"] !== true) {
            return out;
        }
        const next = pageInfo["endCursor"];
        if (typeof next !== "string" || next === "") {
            // A page claiming a successor without a cursor cannot be followed
            // (re-issuing the same request would loop forever), so the only
            // choices are a partial list or a refusal. Refuse, for the reason
            // `assertNoGraphqlErrors` refuses partial data: the threads that
            // did not arrive are neither resolved nor accounted for, and a
            // reduced-depth re-review can flip a prior REQUEST_CHANGES to
            // APPROVE past blocking threads it never saw. Unreachable against
            // GitHub, which always supplies the cursor.
            throw new Error(
                `GraphQL reported another page of review threads for ` +
                    `${owner}/${repo}#${number} without an endCursor`,
            );
        }
        cursor = next;
    }
};

/**
 * Every UNRESOLVED review thread on the PR, in the exact `StagedThread` shape
 * the pre-`resolvedBy` collector returned. Kept as the narrow surface for the
 * consumers that only ever want open threads (autofix's staging), so adding
 * the adjudicated corpus could not silently change what they stage: the
 * resolution fields are STRIPPED here, not merely defaulted, because both
 * stagings serialize these objects verbatim and an extra field is a shape
 * change to every exact-match reader downstream.
 */
export const collectUnresolvedThreads = async (
    graphql: GhGraphql,
    owner: string,
    repo: string,
    number: number,
): Promise<StagedThread[]> =>
    (await collectReviewThreads(graphql, owner, repo, number))
        .filter((thread) => !thread.resolved)
        .map(
            ({
                resolved: _resolved,
                resolvedBy: _resolvedBy,
                openerDownvotes: _openerDownvotes,
                ...thread
            }) => thread,
        );
