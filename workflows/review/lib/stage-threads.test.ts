import {describe, it, expect} from "vitest";

import {openThreadsFromStaged, stagedThreadShapeFailure} from "./dedup";
import {adjudicatedThreadsFromStaged} from "./dedup-adjudicated";
import {computeRoster} from "./dispatch-roster";
import {runStagePrCli, type GhGet, type StagePrFs} from "./stage-pr";
import {withGraphqlRateLimitRetry, type GhGraphql} from "./threads";

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
            adjudicated: JSON.parse(
                fs.files[`${REVIEW}/adjudicated-threads.json`],
            ),
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

    it("drops resolved threads from the unresolved partition and omits an absent opener url", async () => {
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
        // The resolution fields serve the adjudicated partition only; leaking
        // them into threads.json would be a shape change to every exact-match
        // reader of the unresolved staging.
        expect("resolvedBy" in threads[0]).toBe(false);
        expect(humanThreads).toEqual([]);
    });

    it("stages a human-resolved bot thread as adjudicated, and the corpus filter accepts the staged bytes", async () => {
        // The webapp#41290 shape: the author resolved the bot's thread, and
        // before this file existed that resolution REMOVED the defect from
        // the suppression corpus, so the next run could re-derive it with
        // fresh wording. Same producer-to-consumer bind as the open-corpus
        // case above: the staged bytes go straight into
        // `adjudicatedThreadsFromStaged`, so a shape drift fails HERE.
        const {threads, adjudicated} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_adjudicated",
                    isResolved: true,
                    resolvedBy: {login: "octo"},
                }),
                threadNode({id: "PRRT_open2"}),
            ]),
        ]);
        expect(threads.map((t: {thread_id: string}) => t.thread_id)).toEqual([
            "PRRT_open2",
        ]);
        expect(adjudicated).toEqual([
            {
                thread_id: "PRRT_adjudicated",
                path: "a.ts",
                line: 2,
                url: "https://github.com/o/r/pull/7#discussion_r1",
                comments: [
                    {
                        author: "github-actions",
                        body: "**issue (blocking):** opener",
                    },
                ],
                resolved: true,
                resolvedBy: "octo",
                openerDownvotes: 0,
            },
        ]);
        expect(adjudicatedThreadsFromStaged(adjudicated)).toEqual([
            {
                thread_id: "PRRT_adjudicated",
                path: "a.ts",
                body: "**issue (blocking):** opener",
            },
        ]);
    });

    it("stages a downvoted OPEN bot thread in BOTH files: open for the verdict floor, adjudicated for re-derivation", async () => {
        // The 👎 arrives over the opener's reactions connection; the thread is
        // still open, so it stays in threads.json (the open corpus carries
        // the verdict-floor bookkeeping) AND joins the adjudicated corpus
        // (so the settled defect cannot re-post under fresh wording later).
        const {threads, adjudicated} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_downvoted",
                    comments: {
                        nodes: [
                            {
                                author: {login: "github-actions"},
                                body: "**note (non-blocking):** opener",
                                url: "https://github.com/o/r/pull/7#discussion_r9",
                                reactions: {
                                    nodes: [
                                        {user: {login: "octo"}},
                                        {user: {login: "hubot"}},
                                    ],
                                },
                            },
                        ],
                    },
                }),
            ]),
        ]);
        expect(threads.map((t: {thread_id: string}) => t.thread_id)).toEqual([
            "PRRT_downvoted",
        ]);
        // No reaction leak into the open staging's exact shape.
        expect("openerDownvotes" in threads[0]).toBe(false);
        expect(adjudicated).toEqual([
            {
                thread_id: "PRRT_downvoted",
                path: "a.ts",
                line: 2,
                url: "https://github.com/o/r/pull/7#discussion_r9",
                comments: [
                    {
                        author: "github-actions",
                        body: "**note (non-blocking):** opener",
                    },
                ],
                resolved: false,
                resolvedBy: "",
                openerDownvotes: 2,
            },
        ]);
        expect(adjudicatedThreadsFromStaged(adjudicated)).toHaveLength(1);
    });

    it("counts only the opener's 👎, never a reply's", async () => {
        // The opener is the finding; a reply's reactions are conversation.
        // Structurally guaranteed today by the `rawComments[0]` indexing, and
        // pinned here so a refactor that sums the chain cannot land quietly:
        // a 👎 on a bot reply would otherwise adjudicate a finding its
        // opener never received judgment on.
        const {adjudicated} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_reply_down",
                    comments: {
                        nodes: [
                            {
                                author: {login: "github-actions"},
                                body: "**note (non-blocking):** opener",
                            },
                            {
                                author: {login: "octo"},
                                body: "disagree",
                                reactions: {
                                    nodes: [{user: {login: "octo"}}],
                                },
                            },
                        ],
                    },
                }),
            ]),
        ]);
        expect(adjudicated).toEqual([]);
    });

    it("ignores the bot's own seeded 👎 and an unattributable reactor", async () => {
        // The workflow plans to seed the 👍/👎 nudge pair on its own comments
        // at post time (README, "Nudge seeding"); a seeded 👎 is the feedback
        // widget, not a judgment, so it must not put the finding in the
        // adjudicated corpus. The sweep's countDownvotes filters the same
        // identity. GraphQL reports the bot bare, REST bracketed, so both
        // spellings are pinned; a `user: null` reactor (deleted account)
        // never reads as human adjudication, matching resolvedBy's rule.
        const {adjudicated} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_seeded",
                    comments: {
                        nodes: [
                            {
                                author: {login: "github-actions"},
                                body: "**note (non-blocking):** opener",
                                reactions: {
                                    nodes: [
                                        {user: {login: "github-actions"}},
                                        {
                                            user: {
                                                login: "github-actions[bot]",
                                            },
                                        },
                                        {user: null},
                                        {},
                                    ],
                                },
                            },
                        ],
                    },
                }),
            ]),
        ]);
        // Only bot and unattributable reactors: no adjudication at all.
        expect(adjudicated).toEqual([]);
    });

    it("keeps bot-resolved and human-opened resolved threads out of the adjudicated corpus", async () => {
        // Bot-resolved = the reconciler marking a defect FIXED (its regression
        // must re-post); a resolved HUMAN thread is not the bot's finding and
        // adjudicates nothing. An unattributable resolver (deleted account,
        // GraphQL null) fails toward posting a duplicate, never toward
        // suppression on unverifiable authority.
        const {adjudicated} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_fixed",
                    isResolved: true,
                    resolvedBy: {login: "github-actions"},
                }),
                threadNode({
                    id: "PRRT_human_resolved",
                    isResolved: true,
                    resolvedBy: {login: "octo"},
                    comments: {
                        nodes: [{author: {login: "octo"}, body: "human"}],
                    },
                }),
                threadNode({
                    id: "PRRT_ghost",
                    isResolved: true,
                    resolvedBy: null,
                }),
            ]),
        ]);
        expect(adjudicated).toEqual([]);
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
        //
        // "No opener" is two shapes. The third node is the one that used to
        // slip through: a present opening comment whose author is null (a
        // deleted account), which the fetch maps to "". That is a login, not an
        // absence, so it matched no bot and took the human path this test's
        // whole point is to keep it off.
        const {threads, humanThreads} = await stage([
            threadPage([
                threadNode({id: "PRRT_empty", comments: {nodes: []}}),
                threadNode({id: "PRRT_nocomments", comments: null}),
                threadNode({
                    id: "PRRT_nullauthor",
                    comments: {nodes: [{author: null, body: "ghost"}]},
                }),
            ]),
        ]);
        expect(threads).toEqual([]);
        expect(humanThreads).toEqual([]);
    });

    it("matches the bot across a case-variant [bot] suffix", async () => {
        // Theoretical (both GitHub surfaces emit the suffix lowercase today),
        // but the failure it would cause is the expensive direction again: an
        // unstripped `[BOT]` makes the bot's own thread read as a human's.
        const {threads, humanThreads} = await stage([
            threadPage([
                threadNode({
                    id: "PRRT_case",
                    comments: {
                        nodes: [
                            {
                                author: {login: "GitHub-Actions[BOT]"},
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

    it("honours REVIEW_BOT_LOGIN so a consumer's own App is not misfiled", async () => {
        // A repo posting reviews under its own App has a different login. With
        // the identity compiled in, every one of its bot threads lands in
        // human-threads.json, and each becomes a `skipLines` entry that DROPS
        // a fresh finding on that line.
        const previous = process.env.REVIEW_BOT_LOGIN;
        process.env.REVIEW_BOT_LOGIN = "khan-review-bot[bot]";
        try {
            const {threads, humanThreads} = await stage([
                threadPage([
                    threadNode({
                        id: "PRRT_app",
                        comments: {
                            nodes: [
                                {
                                    author: {login: "khan-review-bot"},
                                    body: "**issue (blocking):** x",
                                },
                            ],
                        },
                    }),
                    // The default login is just another human once the env
                    // names a different account.
                    threadNode({id: "PRRT_default", line: 3}),
                ]),
            ]);
            expect(
                threads.map((t: {thread_id: string}) => t.thread_id),
            ).toEqual(["PRRT_app"]);
            expect(humanThreads).toEqual([{path: "a.ts", line: 3}]);
        } finally {
            if (previous === undefined) {
                delete process.env.REVIEW_BOT_LOGIN;
            } else {
                process.env.REVIEW_BOT_LOGIN = previous;
            }
        }
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

    it("fails the staging when a page promises a successor it cannot address", async () => {
        // The remaining fail-OPEN path in the fetch: a page claiming
        // `hasNextPage` with no cursor cannot be followed, and returning the
        // threads collected so far is the partial staging every other guard
        // here refuses. Refusing still terminates, which is what the
        // infinite-loop guard wanted.
        const noCursor = {
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            pageInfo: {hasNextPage: true},
                            nodes: [threadNode()],
                        },
                    },
                },
            },
        };
        await expect(
            runStagePrCli(
                makeFakeFs(),
                ghGetFromMap(routes()),
                graphqlFromPages([noCursor]),
                options,
            ),
        ).rejects.toThrow(/without an endCursor/);
    });
});

/**
 * The retry the CLI transports depend on and no test used to reach: it was
 * built inline under `require.main === module`, so a regression (throwing on
 * attempt 0, or the pattern ceasing to match) would have failed a whole review
 * over the one GraphQL answer that heals. It lives in `threads.ts` now, which
 * is also how autofix's port stopped dying on its first throttle.
 */
describe("withGraphqlRateLimitRetry", () => {
    const noSleep = () => Promise.resolve();
    const rateLimited = {
        errors: [{type: "RATE_LIMITED", message: "slow down"}],
    };

    it("retries a throttled answer and returns the one that succeeds", async () => {
        const pages = [rateLimited, rateLimited, threadPage([])];
        let calls = 0;
        const wrapped = withGraphqlRateLimitRetry(() => {
            calls++;
            return Promise.resolve(pages.shift());
        }, noSleep);

        await expect(wrapped("q", {})).resolves.toEqual(threadPage([]));
        expect(calls).toBe(3);
    });

    it("gives up after the last attempt rather than looping", async () => {
        let calls = 0;
        const wrapped = withGraphqlRateLimitRetry(() => {
            calls++;
            return Promise.resolve(rateLimited);
        }, noSleep);

        await expect(wrapped("q", {})).rejects.toThrow(/RATE_LIMITED/);
        expect(calls).toBe(3);
    });

    it("propagates an error that will not heal, without spending a retry", async () => {
        // A bad token or a missing PR costs one attempt, not three.
        let calls = 0;
        const wrapped = withGraphqlRateLimitRetry(() => {
            calls++;
            return Promise.resolve({
                errors: [{type: "NOT_FOUND", message: "Could not resolve PR"}],
            });
        }, noSleep);

        await expect(wrapped("q", {})).rejects.toThrow(/NOT_FOUND/);
        expect(calls).toBe(1);
    });

    it("waits between attempts, with a backoff", async () => {
        const waits: number[] = [];
        const pages = [rateLimited, rateLimited, threadPage([])];
        const wrapped = withGraphqlRateLimitRetry(
            () => Promise.resolve(pages.shift()),
            (ms) => {
                waits.push(ms);
                return Promise.resolve();
            },
        );

        await wrapped("q", {});
        expect(waits).toEqual([1000, 2000]);
    });
});
