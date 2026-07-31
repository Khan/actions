import {describe, it, expect} from "vitest";

import {openThreadsFromStaged, stagedThreadShapeFailure} from "./dedup";
import {computeRoster} from "./dispatch-roster";
import {runStagePrCli, type GhGet, type StagePrFs} from "./stage-pr";
import type {GhGraphql} from "./threads";

/**
 * Review-thread staging: the last load-bearing staging review.md Step 3 asked
 * the ORCHESTRATOR to perform (`threads.json` / `human-threads.json`), now
 * `stage-pr.ts`'s. Split from stage-pr.test.ts for its max-lines budget,
 * following the precedent dispatch-trial-followups.test.ts set; the fixtures
 * mirror that file's.
 *
 * These cases pin the producer against the consumers it feeds (`dedup.ts`'s
 * open-thread suppression and `dispatch-roster.ts`'s reconciler gate) rather
 * than only against the shape a reader of this file would expect, because
 * "each layer looked right on its own" is exactly how Khan/actions#302 shipped:
 * the prompt selected bot threads by one spelling of the login and the code
 * admitted another, so a conforming staging produced zero usable threads for a
 * whole release. Every fixture is in the API's own shape (a `PRRT_…` node id,
 * GraphQL's bare `github-actions`).
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (
    files: Record<string, string> = {},
): StagePrFs & {files: Record<string, string>} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) =>
            p in state || Object.keys(state).some((f) => f.startsWith(`${p}/`)),
        mkdirSync: () => {},
    };
};

const PATCH_ONE = "@@ -1,2 +1,3 @@\n ctx\n+added line\n ctx";

const ghGetFromMap =
    (routes: Record<string, unknown>): GhGet =>
    (path: string) => {
        if (!(path in routes)) {
            return Promise.reject(new Error(`unexpected GET ${path}`));
        }
        return Promise.resolve(routes[path]);
    };

/** One well-formed `reviewThreads` page. */
const threadPage = (nodes: unknown[], hasNextPage = false) => ({
    data: {
        repository: {
            pullRequest: {
                reviewThreads: {
                    pageInfo: {hasNextPage, endCursor: "c1"},
                    nodes,
                },
            },
        },
    },
});

/** A GraphQL port serving the given pages in order, then empty ones. */
const graphqlFromPages =
    (pages: unknown[] = []): GhGraphql =>
    () =>
        Promise.resolve(pages.shift() ?? threadPage([]));

/** A GraphQL thread node in the API's own shape. */
const threadNode = (over: Record<string, unknown> = {}) => ({
    id: "PRRT_1",
    isResolved: false,
    path: "a.ts",
    line: 2,
    comments: {
        nodes: [
            {
                author: {login: "github-actions"},
                body: "**issue (blocking):** opener",
                url: "https://github.com/o/r/pull/7#discussion_r1",
            },
        ],
    },
    ...over,
});

const baseRoutes = (): Record<string, unknown> => ({
    "/repos/o/r/pulls/7": {
        number: 7,
        title: "t",
        user: {login: "octo"},
        base: {ref: "main"},
        head: {sha: "abc123"},
    },
    "/repos/o/r/pulls/7/files?per_page=100&page=1": [
        {filename: "a.ts", status: "modified", patch: PATCH_ONE},
    ],
    "/repos/o/r/pulls/7/reviews?per_page=100&page=1": [],
});

describe("review-thread staging (slice 1)", () => {
    const options = {repo: "o/r", prNumber: 7, repoRoot: "/work"};
    const routes = () => baseRoutes();
    const stage = async (pages: unknown[]) => {
        const fs = makeFakeFs();
        const result = await runStagePrCli(
            fs,
            ghGetFromMap(routes()),
            graphqlFromPages(pages),
            options,
        );
        return {
            fs,
            result,
            threads: JSON.parse(fs.files[`${REVIEW}/threads.json`]),
            humanThreads: JSON.parse(fs.files[`${REVIEW}/human-threads.json`]),
        };
    };

    it("stages a bot thread the suppression filter can use, bodies verbatim", async () => {
        // The bind that #302 lacked: the staged bytes go straight into the
        // consumer's filter, so a producer that drifts out of the shape
        // `openThreadsFromStaged` requires fails HERE rather than silently
        // suppressing nothing on a live PR.
        const body =
            "**issue (blocking):** Retention cutoff subtracts months, not days.\r\n\r\n  indented\t";
        const {threads, humanThreads, result} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_kwDOAJgNW86VOObT",
                    comments: {
                        nodes: [
                            {
                                author: {login: "github-actions"},
                                body,
                                url: "https://github.com/o/r/pull/7#discussion_r1",
                            },
                            {author: {login: "octo"}, body: "already handled"},
                        ],
                    },
                }),
            ]),
        ]);

        expect(threads).toEqual([
            {
                thread_id: "PRRT_kwDOAJgNW86VOObT",
                path: "a.ts",
                line: 2,
                url: "https://github.com/o/r/pull/7#discussion_r1",
                comments: [
                    {author: "github-actions", body},
                    {author: "octo", body: "already handled"},
                ],
                resolved: false,
            },
        ]);
        expect(humanThreads).toEqual([]);
        expect(result.botThreadCount).toBe(1);

        const open = openThreadsFromStaged(threads, new Set());
        expect(open).toEqual([
            {thread_id: "PRRT_kwDOAJgNW86VOObT", path: "a.ts", body},
        ]);
        // And the total-failure tripwire stays quiet on a conforming staging.
        expect(
            stagedThreadShapeFailure(threads, open, new Set()),
        ).toBeUndefined();
    });

    it("files a human-opened thread as a skip line, never as a bot thread", async () => {
        // The expensive direction: a bot thread misfiled as human becomes a
        // `skipLines` entry, and the submission then DROPS a fresh finding on
        // that line instead of merely duplicating one.
        const {threads, humanThreads, result} = await stage([
            threadPage([
                threadNode({id: "PRRT_bot"}),
                threadNode({
                    id: "PRRT_human",
                    path: "b.ts",
                    line: 41,
                    comments: {
                        nodes: [
                            {
                                author: {login: "octo"},
                                body: "please also check",
                            },
                            {
                                author: {login: "github-actions"},
                                body: "**note (non-blocking):** a bot reply",
                            },
                        ],
                    },
                }),
            ]),
        ]);
        expect(threads.map((t: {thread_id: string}) => t.thread_id)).toEqual([
            "PRRT_bot",
        ]);
        // The OPENER decides, not "the bot appears somewhere in the chain".
        expect(humanThreads).toEqual([{path: "b.ts", line: 41}]);
        expect(result.humanThreadCount).toBe(1);
    });

    it("accepts the bracketed login too, so neither surface's spelling can misfile a thread", async () => {
        const {threads, humanThreads} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_rest",
                    comments: {
                        nodes: [
                            {
                                author: {login: "github-actions[bot]"},
                                body: "**issue (blocking):** x",
                            },
                        ],
                    },
                }),
            ]),
        ]);
        expect(threads).toHaveLength(1);
        expect(humanThreads).toEqual([]);
    });

    it("drops resolved threads and omits an absent opener url", async () => {
        const {threads, humanThreads} = await stage([
            threadPage([
                threadNode({id: "PRRT_done", isResolved: true}),
                threadNode({
                    id: "PRRT_open",
                    comments: {
                        nodes: [
                            {
                                author: {login: "github-actions"},
                                body: "**nitpick (non-blocking):** y",
                            },
                        ],
                    },
                }),
            ]),
        ]);
        expect(threads).toHaveLength(1);
        expect("url" in threads[0]).toBe(false);
        expect(humanThreads).toEqual([]);
    });

    it("skips human threads with no RIGHT-side line and collapses duplicates", async () => {
        // The reconciler echoes these into `skipLines`, which is matched on
        // `{path, line}`: an outdated thread has no line to skip, and two
        // human threads on one line are one skip.
        const human = (over: Record<string, unknown>) =>
            threadNode({
                comments: {
                    nodes: [{author: {login: "octo"}, body: "human"}],
                },
                ...over,
            });
        const {threads, humanThreads} = await stage([
            threadPage([
                human({id: "PRRT_a", path: "b.ts", line: 41}),
                human({id: "PRRT_b", path: "b.ts", line: 41}),
                human({id: "PRRT_outdated", path: "b.ts", line: null}),
                human({id: "PRRT_nopath", path: "", line: 3}),
            ]),
        ]);
        expect(threads).toEqual([]);
        expect(humanThreads).toEqual([{path: "b.ts", line: 41}]);
    });

    it("stages a thread with no opener in neither file", async () => {
        // Unreachable on a real PR (every review thread has a first comment,
        // and a partial GraphQL response throws upstream), and asserted anyway
        // because the fail-open direction is the expensive one: an
        // unattributable thread staged as human becomes a `skipLines` entry
        // that may sit on the bot's own line, dropping a fresh finding there.
        const {threads, humanThreads} = await stage([
            threadPage([
                threadNode({id: "PRRT_empty", comments: {nodes: []}}),
                threadNode({id: "PRRT_nocomments", comments: null}),
            ]),
        ]);
        expect(threads).toEqual([]);
        expect(humanThreads).toEqual([]);
    });

    it("follows pagination", async () => {
        const {threads} = await stage([
            threadPage([threadNode({id: "PRRT_1"})], true),
            threadPage([threadNode({id: "PRRT_2"})]),
        ]);
        expect(threads.map((t: {thread_id: string}) => t.thread_id)).toEqual([
            "PRRT_1",
            "PRRT_2",
        ]);
    });

    it("still gates the reconciler dispatch on the staged threads", async () => {
        // `hasThreads` is read straight off this file by dispatch.ts and
        // decides whether the thread-reconciler is dispatched at all, so the
        // staging changes the roster: assert both directions against the real
        // roster function.
        const hasThreads = (staged: unknown): boolean =>
            Array.isArray(staged) && staged.length > 0;
        const withThread = await stage([threadPage([threadNode()])]);
        expect(hasThreads(withThread.threads)).toBe(true);
        expect(
            computeRoster("fast", {}, hasThreads(withThread.threads)),
        ).toMatchObject({reconcile: true});
        const withNone = await stage([threadPage([])]);
        expect(hasThreads(withNone.threads)).toBe(false);
        expect(
            computeRoster("fast", {}, hasThreads(withNone.threads)),
        ).toMatchObject({reconcile: false});
    });

    it("fails the staging when the threads fetch fails, before any AI spend", async () => {
        // GitHub answers a rate limit with HTTP 200 and an `errors` array, so
        // the only alternative to throwing is staging `[]`, and that is not the
        // conservative direction: it drops the flip gate's keptBlockingCount to
        // zero, letting a reduced-depth re-review approve past blocking threads
        // it never read. The step fails instead, and nothing downstream runs.
        const fs = makeFakeFs();
        await expect(
            runStagePrCli(
                fs,
                ghGetFromMap(routes()),
                graphqlFromPages([{errors: [{type: "RATE_LIMITED"}]}]),
                options,
            ),
        ).rejects.toThrow(/RATE_LIMITED/);
        expect(fs.files[`${REVIEW}/threads.json`]).toBe(undefined);
        expect(fs.files[`${REVIEW}/routing.json`]).toBe(undefined);
    });

    it("fails the staging on a malformed GraphQL body rather than reading it as no threads", async () => {
        await expect(
            runStagePrCli(
                makeFakeFs(),
                ghGetFromMap(routes()),
                graphqlFromPages([{data: {repository: null}}]),
                options,
            ),
        ).rejects.toThrow(/no reviewThreads connection/);
    });
});
