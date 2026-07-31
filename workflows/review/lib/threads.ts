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
 * the producer's filter and the consumer's guard (`dedup.ts`'s open-thread
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

/**
 * The login this workflow's own review comments are authored by, and the
 * single source of truth for that identity across the producer
 * (`stage-pr.ts`, which selects the bot's threads) and the consumers
 * (`dedup.ts`'s suppression guard). A consumer repo that posts reviews under a
 * different account changes this constant, which moves both layers at once:
 * the property #302 lost when the two layers each spelled it themselves.
 */
export const REVIEW_BOT_LOGIN = "github-actions[bot]";

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
 */
const baseLogin = (login: string): string =>
    login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;

/** Whether two logins name the same account across the bot-suffix split. */
export const sameLogin = (a: string, b: string): boolean =>
    baseLogin(a).toLowerCase() === baseLogin(b).toLowerCase();

/** Whether a comment author is this workflow's review bot, either spelling. */
export const isReviewBotAuthor = (login: string): boolean =>
    sameLogin(login, REVIEW_BOT_LOGIN);

/**
 * Review threads with their full reply chain.
 *
 * `comments(first: 100)` rather than the thumbs sweep's `first: 1`: the
 * reconciler contract wants the whole chain, because an author's reply is
 * often what says a finding is already handled. `isResolved` is fetched so
 * resolved threads are dropped here rather than downstream.
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
 * Every UNRESOLVED review thread on the PR, in API order, whoever opened it.
 * Callers partition by opener ({@link isReviewBotAuthor}); nothing here is
 * filtered by author, so the reviewer can stage the human threads it defers to
 * from the same fetch.
 *
 * Fails closed on both shapes a failed query takes (an `errors` array, and a
 * body with no `reviewThreads` connection), because neither means "this PR has
 * no threads", and reading them that way is the one mistake this module cannot
 * afford (see {@link assertNoGraphqlErrors}).
 */
export const collectUnresolvedThreads = async (
    graphql: GhGraphql,
    owner: string,
    repo: string,
    number: number,
): Promise<StagedThread[]> => {
    const out: StagedThread[] = [];
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
            if (!isRecord(node) || node["isResolved"] === true) {
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
                // `dedup.ts`'s suppression) read the leading `**label:**`
                // template off this string; normalising it here is how a
                // finding becomes unclassifiable.
                body: str(comment["body"]),
            }));
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
            return out;
        }
        const next = pageInfo["endCursor"];
        if (typeof next !== "string" || next === "") {
            // A page claiming a successor without a cursor would loop forever
            // on the same request; stop with what arrived.
            return out;
        }
        cursor = next;
    }
};
