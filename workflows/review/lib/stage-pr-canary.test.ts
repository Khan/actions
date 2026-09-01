import {describe, it, expect} from "vitest";

import {renderAttributionFooter} from "./attribution";
import {
    hashHunkAddedLines,
    runStagePrCli,
    type GhGet,
    type StagePrFs,
} from "./stage-pr";
import type {TicketFetch} from "./stage-ticket";
import type {GhGraphql} from "./threads";
import {renderVersionFooter} from "./version-footer";

/**
 * The canary isolation in the staging, both directions (split from
 * stage-pr.test.ts by the max-lines budget). Canary-side: REVIEW_CANARY=1
 * stages every carrier of the reviewer's own history empty. Production-side:
 * a non-canary staging drops canary-footer reviews and canary-opened threads,
 * so the pinned reviewer never reads unreleased code's output as its own
 * history. The fixtures mirror stage-pr.test.ts's.
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

const ghGetFromMap =
    (routes: Record<string, unknown>): GhGet =>
    (path: string) => {
        if (!(path in routes)) {
            return Promise.reject(new Error(`unexpected GET ${path}`));
        }
        return Promise.resolve(routes[path]);
    };

const noTicket = (): TicketFetch => () =>
    Promise.reject(new Error("unexpected ticket fetch"));

const noThreads = (): GhGraphql => () =>
    Promise.resolve({
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: {
                        pageInfo: {hasNextPage: false},
                        nodes: [],
                    },
                },
            },
        },
    });

const PR_META = {
    number: 7,
    title: "t",
    body: "d",
    user: {login: "octo"},
    base: {ref: "main"},
    head: {sha: "abc123", ref: "feature/KORE-9"},
    draft: false,
};

const PATCH_ONE = "@@ -1,2 +1,3 @@\n ctx\n+added line\n ctx";

describe("canary staging (REVIEW_CANARY=1)", () => {
    const options = {
        repo: "o/r",
        prNumber: 7,
        repoRoot: "/work",
        env: {REVIEW_CANARY: "1"},
    };

    /** One page: a bot-opened open thread, a human thread, and a bot thread
     * a human resolved (the adjudicated shape). */
    const mixedThreads = (): GhGraphql => () =>
        Promise.resolve({
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            pageInfo: {hasNextPage: false},
                            nodes: [
                                {
                                    id: "PRRT_bot",
                                    isResolved: false,
                                    path: "a.ts",
                                    line: 2,
                                    comments: {
                                        nodes: [
                                            {
                                                author: {
                                                    login: "github-actions",
                                                },
                                                body: "**issue (blocking):** bot finding",
                                                url: "https://github.com/o/r/pull/7#discussion_r1",
                                            },
                                        ],
                                    },
                                },
                                {
                                    id: "PRRT_human",
                                    isResolved: false,
                                    path: "a.ts",
                                    line: 3,
                                    comments: {
                                        nodes: [
                                            {
                                                author: {login: "octo"},
                                                body: "human question",
                                                url: "https://github.com/o/r/pull/7#discussion_r2",
                                            },
                                        ],
                                    },
                                },
                                {
                                    id: "PRRT_adjudicated",
                                    isResolved: true,
                                    resolvedBy: {login: "octo"},
                                    path: "a.ts",
                                    line: 4,
                                    comments: {
                                        nodes: [
                                            {
                                                author: {
                                                    login: "github-actions",
                                                },
                                                body: "**nit (non-blocking):** settled",
                                                url: "https://github.com/o/r/pull/7#discussion_r3",
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        });

    it("stages reviewer history empty, keeps human threads, ignores the cache, and never fetches reviews", async () => {
        // The routes deliberately OMIT the reviews endpoint: ghGetFromMap
        // rejects unexpected paths, so a canary staging that still fetched
        // prior reviews would fail this test, not just stage differently.
        const routes: Record<string, unknown> = {
            "/repos/o/r/pulls/7": PR_META,
            "/repos/o/r/pulls/7/files?per_page=100&page=1": [
                {filename: "a.ts", status: "modified", patch: PATCH_ONE},
            ],
        };
        // A cache record that would scope the diff to nothing on a
        // production run: the canary must not read it.
        const fs = makeFakeFs({
            "/tmp/gh-aw/cache-memory/pr-7.json": JSON.stringify({
                reviewedHunks: {
                    "a.ts": [hashHunkAddedLines(PATCH_ONE)],
                },
            }),
        });
        const result = await runStagePrCli(
            fs,
            ghGetFromMap(routes),
            mixedThreads(),
            noTicket(),
            options,
        );
        expect(JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`])).toEqual(
            [],
        );
        expect(JSON.parse(fs.files[`${REVIEW}/threads.json`])).toEqual([]);
        expect(
            JSON.parse(fs.files[`${REVIEW}/adjudicated-threads.json`]),
        ).toEqual([]);
        expect(JSON.parse(fs.files[`${REVIEW}/human-threads.json`])).toEqual([
            {path: "a.ts", line: 3},
        ]);
        expect(JSON.parse(fs.files[`${REVIEW}/new-scope.json`])).toEqual({
            priorReview: false,
            inScope: {},
        });
        expect(result.depth).toBe("full");
        expect(result.botThreadCount).toBe(0);
        expect(result.humanThreadCount).toBe(1);
        expect(result.warnings.join(" ")).toContain("canary staging");
    });

    it("production runs drop canary-footer reviews from prior-reviews.json", async () => {
        // The other direction of the isolation: a PRODUCTION (non-canary)
        // staging must not read the canary's posted reviews as its own
        // history, or its next round would anchor on a stamp unreleased
        // code produced. The discriminator is the footer's canary segment.
        const canaryBody = `looks good\n${renderVersionFooter({
            version: "1.21.0",
            schemaVersion: 2,
            depth: "full",
            reReviewMode: null,
            blockingOnly: false,
            blockingMedium: false,
            enabledReviewers: [],
            nonBlockingInlineBudget: null,
            canarySha: "0123456789abcdef",
        })}`;
        const routes = {
            "/repos/o/r/pulls/7": PR_META,
            "/repos/o/r/pulls/7/files?per_page=100&page=1": [
                {filename: "a.ts", status: "modified", patch: PATCH_ONE},
            ],
            "/repos/o/r/pulls/7/reviews?per_page=100&page=1": [
                {
                    user: {login: "github-actions[bot]"},
                    body: canaryBody,
                    submitted_at: "2026-07-02T00:00:00Z",
                },
                {
                    user: {login: "github-actions[bot]"},
                    body: "production review",
                    submitted_at: "2026-07-01T00:00:00Z",
                },
            ],
        };
        const fs = makeFakeFs();
        await runStagePrCli(fs, ghGetFromMap(routes), noThreads(), noTicket(), {
            repo: "o/r",
            prNumber: 7,
            repoRoot: "/work",
        });
        const staged = JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`]);
        expect(staged).toHaveLength(1);
        expect(staged[0].body).toBe("production review");
    });

    it("production runs keep canary-opened threads out of both partitions", async () => {
        // A canary inline comment becomes a thread opened by the shared bot
        // login whose body carries the attribution footer's canary segment.
        // In the bot partition its blocking label would feed
        // keptBlockingCount and floor this reviewer's verdict; in the human
        // partition it would skipLines-drop fresh findings. It goes in
        // neither.
        const canaryOpener = `**issue (blocking):** canary finding\n${renderAttributionFooter(
            "correctness-reviewer",
            [],
            "0123456789abcdef",
        )}`;
        const threads: GhGraphql = () =>
            Promise.resolve({
                data: {
                    repository: {
                        pullRequest: {
                            reviewThreads: {
                                pageInfo: {hasNextPage: false},
                                nodes: [
                                    {
                                        id: "PRRT_canary",
                                        isResolved: false,
                                        path: "a.ts",
                                        line: 2,
                                        comments: {
                                            nodes: [
                                                {
                                                    author: {
                                                        login: "github-actions",
                                                    },
                                                    body: canaryOpener,
                                                    url: "https://github.com/o/r/pull/7#discussion_r9",
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            });
        const fs = makeFakeFs();
        const result = await runStagePrCli(
            fs,
            ghGetFromMap({
                "/repos/o/r/pulls/7": PR_META,
                "/repos/o/r/pulls/7/files?per_page=100&page=1": [
                    {filename: "a.ts", status: "modified", patch: PATCH_ONE},
                ],
                "/repos/o/r/pulls/7/reviews?per_page=100&page=1": [],
            }),
            threads,
            noTicket(),
            {repo: "o/r", prNumber: 7, repoRoot: "/work"},
        );
        expect(JSON.parse(fs.files[`${REVIEW}/threads.json`])).toEqual([]);
        expect(JSON.parse(fs.files[`${REVIEW}/human-threads.json`])).toEqual(
            [],
        );
        expect(result.botThreadCount).toBe(0);
    });

    it("is inert unless REVIEW_CANARY is exactly '1'", async () => {
        const routes = {
            "/repos/o/r/pulls/7": PR_META,
            "/repos/o/r/pulls/7/files?per_page=100&page=1": [
                {filename: "a.ts", status: "modified", patch: PATCH_ONE},
            ],
            "/repos/o/r/pulls/7/reviews?per_page=100&page=1": [
                {
                    user: {login: "github-actions[bot]"},
                    body: "prior",
                    submitted_at: "2026-07-01T00:00:00Z",
                },
            ],
        };
        const fs = makeFakeFs();
        const result = await runStagePrCli(
            fs,
            ghGetFromMap(routes),
            mixedThreads(),
            noTicket(),
            {...options, env: {REVIEW_CANARY: "true"}},
        );
        expect(
            JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`]),
        ).toHaveLength(1);
        expect(JSON.parse(fs.files[`${REVIEW}/threads.json`])).toHaveLength(1);
        expect(result.warnings.join(" ")).not.toContain("canary staging");
    });
});
