import {describe, expect, it} from "vitest";

import {
    assertNoGraphqlErrors,
    collectInputs,
    collectThreads,
    writeInputs,
} from "./stage.ts";
import type {StageCliFs, StagePort} from "./stage.ts";
import {computeHunkSignature} from "../../review/lib/rereview-mode.ts";

const BOT = "github-actions[bot]";

const threadNode = (over: Record<string, unknown> = {}) => ({
    id: "PRRT_1",
    isResolved: false,
    path: "src/a.ts",
    line: 12,
    comments: {
        nodes: [
            {
                author: {login: BOT},
                body: "**issue (blocking):** boom",
                url: "https://github.com/o/r/pull/1#discussion_r1",
            },
        ],
    },
    ...over,
});

const portFor = (opts: {
    threadPages?: unknown[];
    rest?: Record<string, unknown>;
    paged?: Record<string, unknown[]>;
    checkoutSha?: string;
}): StagePort => {
    let page = 0;
    return {
        checkoutHeadSha: () => opts.checkoutSha ?? "",
        rest: async () => opts.rest ?? {},
        restPaged: async (path) => {
            for (const [key, value] of Object.entries(opts.paged ?? {})) {
                if (path.endsWith(key)) {
                    return value;
                }
            }
            return [];
        },
        // Falls back to a well-formed EMPTY page, not `{}`. Staging now throws
        // on a body it cannot parse, so the default has to be a valid response
        // that simply carries no threads; `{}` would make every test that does
        // not care about threads fail as a rate-limit. Evaluated lazily, after
        // `onePage` is initialised.
        graphql: async () => (opts.threadPages ?? [])[page++] ?? onePage([]),
    };
};

const onePage = (nodes: unknown[], hasNextPage = false) => ({
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

describe("collectThreads", () => {
    it("keeps an unresolved thread opened by the bot", async () => {
        const port = portFor({threadPages: [onePage([threadNode()])]});
        const threads = await collectThreads(port, "o", "r", 1, BOT);
        expect(threads).toEqual([
            {
                thread_id: "PRRT_1",
                path: "src/a.ts",
                line: 12,
                url: "https://github.com/o/r/pull/1#discussion_r1",
                comments: [{author: BOT, body: "**issue (blocking):** boom"}],
            },
        ]);
    });

    it("drops resolved threads", async () => {
        const port = portFor({
            threadPages: [onePage([threadNode({isResolved: true})])],
        });
        expect(await collectThreads(port, "o", "r", 1, BOT)).toEqual([]);
    });

    it("drops threads a human started", async () => {
        // Somebody else's conversation; autofix stays out of it, the same line
        // the reviewer draws with human-threads.json.
        const human = threadNode({
            comments: {nodes: [{author: {login: "alice"}, body: "hmm"}]},
        });
        expect(
            await collectThreads(
                portFor({threadPages: [onePage([human])]}),
                "o",
                "r",
                1,
                BOT,
            ),
        ).toEqual([]);
    });

    it("keeps a bot thread that a human replied to, with the full chain", async () => {
        const withReply = threadNode({
            comments: {
                nodes: [
                    {author: {login: BOT}, body: "**issue (blocking):** boom"},
                    {author: {login: "alice"}, body: "already handled"},
                ],
            },
        });
        const threads = await collectThreads(
            portFor({threadPages: [onePage([withReply])]}),
            "o",
            "r",
            1,
            BOT,
        );
        expect(threads[0].comments).toHaveLength(2);
        expect(threads[0].comments[1]).toEqual({
            author: "alice",
            body: "already handled",
        });
    });

    it("copies comment bodies verbatim", async () => {
        // The label parser reads `**label:**` off this string; normalising it
        // is exactly how a finding becomes unclassifiable.
        const body = "**issue (blocking):**  boom\r\n\r\n  indented\t";
        const node = threadNode({
            comments: {nodes: [{author: {login: BOT}, body}]},
        });
        const threads = await collectThreads(
            portFor({threadPages: [onePage([node])]}),
            "o",
            "r",
            1,
            BOT,
        );
        expect(threads[0].comments[0].body).toBe(body);
    });

    it("carries a null line for an outdated thread", async () => {
        const node = threadNode({line: null});
        const threads = await collectThreads(
            portFor({threadPages: [onePage([node])]}),
            "o",
            "r",
            1,
            BOT,
        );
        expect(threads[0].line).toBeNull();
    });

    it("omits url when the API returned none", async () => {
        const node = threadNode({
            comments: {
                nodes: [
                    {author: {login: BOT}, body: "**note (non-blocking):** x"},
                ],
            },
        });
        const threads = await collectThreads(
            portFor({threadPages: [onePage([node])]}),
            "o",
            "r",
            1,
            BOT,
        );
        expect("url" in threads[0]).toBe(false);
    });

    it("follows pagination", async () => {
        const port = portFor({
            threadPages: [
                onePage([threadNode({id: "A"})], true),
                onePage([threadNode({id: "B"})]),
            ],
        });
        const threads = await collectThreads(port, "o", "r", 1, BOT);
        expect(threads.map((t) => t.thread_id)).toEqual(["A", "B"]);
    });

    // A successor page that cannot be followed leaves two options, a partial
    // list or a refusal, and partial is the shape this module refuses
    // everywhere else: threads that never arrived would be neither fixed nor
    // accounted for, while the run clears its arming label and reports clean.
    // Refusing still terminates, which is all the infinite-loop guard wanted.
    it("refuses rather than looping when a page omits its cursor", async () => {
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
            collectThreads(
                portFor({threadPages: [noCursor, noCursor, noCursor]}),
                "o",
                "r",
                1,
                BOT,
            ),
        ).rejects.toThrow(/without an endCursor/);
    });

    // These four pin the fail-CLOSED direction. Staging zero threads on a PR
    // that has open findings is the one failure this module cannot absorb: the
    // plan becomes a no-op, the no-op removes the arming label, and the author
    // is told there is nothing to fix. Nothing is left to re-arm from, so the
    // findings stay open silently. Throwing instead fails the staging step
    // before any AI spend, and the label survives for a retry.
    it("throws when GraphQL reports a rate limit as HTTP 200 with errors", async () => {
        await expect(
            collectThreads(
                portFor({threadPages: [{errors: [{type: "RATE_LIMITED"}]}]}),
                "o",
                "r",
                1,
                BOT,
            ),
        ).rejects.toThrow(/RATE_LIMITED/);
    });

    it("throws on partial data carrying errors, rather than staging the subset", async () => {
        await expect(
            collectThreads(
                portFor({
                    threadPages: [
                        {
                            ...onePage([threadNode()]),
                            errors: [{type: "FORBIDDEN"}],
                        },
                    ],
                }),
                "o",
                "r",
                1,
                BOT,
            ),
        ).rejects.toThrow(/FORBIDDEN/);
    });

    it("throws for a malformed GraphQL body", async () => {
        await expect(
            collectThreads(
                portFor({threadPages: [{errors: []}]}),
                "o",
                "r",
                1,
                BOT,
            ),
        ).rejects.toThrow(/no reviewThreads connection/);
    });

    it("still returns an empty list for a well-formed PR with no threads", async () => {
        expect(
            await collectThreads(
                portFor({threadPages: [onePage([])]}),
                "o",
                "r",
                1,
                BOT,
            ),
        ).toEqual([]);
    });
});

describe("assertNoGraphqlErrors", () => {
    it("passes a clean body", () => {
        expect(() => assertNoGraphqlErrors(onePage([]))).not.toThrow();
    });

    it("passes an empty errors array", () => {
        // GitHub omits `errors` on success; an empty array is not a failure.
        expect(() =>
            assertNoGraphqlErrors({data: {}, errors: []}),
        ).not.toThrow();
    });

    it("throws on any error entry, and names it", () => {
        expect(() =>
            assertNoGraphqlErrors({errors: [{type: "RATE_LIMITED"}]}),
        ).toThrow(/RATE_LIMITED/);
    });

    it("ignores a non-object body", () => {
        expect(() => assertNoGraphqlErrors(null)).not.toThrow();
    });
});

describe("collectInputs", () => {
    const port = portFor({
        rest: {
            labels: [{name: "autofix: blocking"}, {name: "bug"}],
            head: {sha: "abc123"},
        },
        paged: {
            "/reviews": [
                {
                    user: {login: BOT},
                    body: "Changes requested.",
                    submitted_at: "2026-07-01T00:00:00Z",
                },
                {
                    user: {login: "alice"},
                    body: "lgtm",
                    submitted_at: "2026-07-02T00:00:00Z",
                },
            ],
            "/files": [{filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n c\n+x"}],
            "/commits": [
                {commit: {message: "feat: a"}},
                {commit: {message: "fix: b"}},
            ],
        },
        threadPages: [onePage([threadNode()])],
    });

    it("stages every input the plan needs", async () => {
        const inputs = await collectInputs(port, "o", "r", 1, BOT);
        expect(inputs.labels).toEqual(["autofix: blocking", "bug"]);
        expect(inputs.headSha).toBe("abc123");
        expect(inputs.commitMessages).toEqual(["feat: a", "fix: b"]);
        expect(inputs.threads).toHaveLength(1);
    });

    it("keeps only the reviewer bot's reviews", async () => {
        const inputs = await collectInputs(port, "o", "r", 1, BOT);
        expect(inputs.priorReviews).toEqual([
            {body: "Changes requested.", submittedAt: "2026-07-01T00:00:00Z"},
        ]);
    });
});

describe("writeInputs", () => {
    const fsFor = () => {
        const written: Record<string, string> = {};
        const dirs: string[] = [];
        const fs: StageCliFs = {
            mkdirSync: (p) => {
                dirs.push(p);
            },
            writeFileSync: (p, d) => {
                written[p] = d;
            },
        };
        return {fs, written, dirs};
    };

    const inputs = {
        labels: ["autofix: blocking"],
        isFork: false,
        threads: [],
        priorReviews: [],
        diffText: "diff --git a/a b/a\n",
        commitMessages: ["feat: a"],
        headSha: "abc123",
    };

    it("creates the out directory and writes every file", () => {
        const {fs, written, dirs} = fsFor();
        writeInputs(fs, inputs, "/d");
        expect(dirs).toEqual(["/d/out"]);
        expect(Object.keys(written).sort()).toEqual([
            "/d/commits.json",
            "/d/context.json",
            "/d/head-sha.txt",
            "/d/labels.json",
            "/d/pr.diff",
            "/d/prior-reviews.json",
            "/d/threads.json",
        ]);
    });

    it("omits command.txt on a label-armed run", () => {
        // Its ABSENCE is what tells plan.ts to resolve labels, so an empty file
        // would silently switch the resolver's surface.
        const {fs, written} = fsFor();
        writeInputs(fs, inputs, "/d");
        expect("/d/command.txt" in written).toBe(false);
        writeInputs(fs, inputs, "/d", "   ");
        expect("/d/command.txt" in written).toBe(false);
    });

    it("writes command.txt verbatim, trailing CRLF included", () => {
        const {fs, written} = fsFor();
        writeInputs(fs, inputs, "/d", "/autofix blocking\r\n");
        expect(written["/d/command.txt"]).toBe("/autofix blocking\r\n");
    });

    it("writes the diff raw, not JSON-wrapped", () => {
        const {fs, written} = fsFor();
        writeInputs(fs, inputs, "/d");
        expect(written["/d/pr.diff"]).toBe("diff --git a/a b/a\n");
    });
});

describe("the head SHA comes from the checkout", () => {
    const base = {
        rest: {labels: [], head: {sha: "from-api"}},
        threadPages: [onePage([])],
    };

    it("prefers the checked-out HEAD over the API", () => {
        // Khan/actions#298 review: the edits are made against the checkout, so
        // comparing an API read leaves a window where both reads agree while
        // the working tree is already stale.
        return collectInputs(
            portFor({...base, checkoutSha: "from-checkout"}),
            "o",
            "r",
            1,
            BOT,
        ).then((i) => expect(i.headSha).toBe("from-checkout"));
    });

    it("falls back to the API when no checkout is available", async () => {
        const inputs = await collectInputs(portFor(base), "o", "r", 1, BOT);
        expect(inputs.headSha).toBe("from-api");
    });
});

describe("the staged diff round-trips into the currency check", () => {
    // autofix rebuilds the diff with the reviewer's `buildUnifiedDiff` and then
    // parses it with the reviewer's `computeHunkSignature`. Both live in the
    // other package, so this pins the contract between them from this side: if
    // either changes shape, the currency guard silently stops seeing files.
    it("produces a signature keyed by path", async () => {
        const inputs = await collectInputs(
            portFor({
                rest: {labels: [], head: {sha: "s"}},
                paged: {
                    "/files": [
                        {
                            filename: "src/a.ts",
                            status: "modified",
                            patch: "@@ -1,1 +1,2 @@\n context\n+added",
                        },
                    ],
                },
                threadPages: [onePage([])],
            }),
            "o",
            "r",
            1,
            BOT,
        );
        expect(Object.keys(computeHunkSignature(inputs.diffText))).toEqual([
            "src/a.ts",
        ]);
    });

    it("keeps a renamed file keyed by its new path", async () => {
        // The reason for using the shared builder: a local copy emitted the new
        // name on both sides, which is wrong for a rename.
        const inputs = await collectInputs(
            portFor({
                rest: {labels: [], head: {sha: "s"}},
                paged: {
                    "/files": [
                        {
                            filename: "src/new.ts",
                            previous_filename: "src/old.ts",
                            status: "renamed",
                            patch: "@@ -1,1 +1,2 @@\n c\n+x",
                        },
                    ],
                },
                threadPages: [onePage([])],
            }),
            "o",
            "r",
            1,
            BOT,
        );
        expect(inputs.diffText).toContain(
            "diff --git a/src/old.ts b/src/new.ts",
        );
        expect(Object.keys(computeHunkSignature(inputs.diffText))).toEqual([
            "src/new.ts",
        ]);
    });
});

describe("the REST/GraphQL bot-suffix split", () => {
    // Khan/webapp#41140 run 30416237794 staged threadCount: 0 on a PR with five
    // reviewer threads: GraphQL reports the App as `github-actions`, REST as
    // `github-actions[bot]`, and one configured spelling cannot match both.
    it("matches a GraphQL thread author that carries no [bot] suffix", async () => {
        const node = threadNode({
            comments: {
                nodes: [
                    {
                        author: {login: "github-actions"},
                        body: "**issue (blocking):** boom",
                    },
                ],
            },
        });
        const threads = await collectThreads(
            portFor({threadPages: [onePage([node])]}),
            "o",
            "r",
            1,
            "github-actions[bot]",
        );
        expect(threads).toHaveLength(1);
    });

    it("matches a REST review author that carries the suffix", async () => {
        const inputs = await collectInputs(
            portFor({
                rest: {labels: [], head: {sha: "s"}},
                paged: {
                    "/reviews": [
                        {
                            user: {login: "github-actions[bot]"},
                            body: "b",
                            submitted_at: "2026-07-01T00:00:00Z",
                        },
                    ],
                },
                threadPages: [onePage([])],
            }),
            "o",
            "r",
            1,
            "github-actions",
        );
        expect(inputs.priorReviews).toHaveLength(1);
    });

    it("still excludes a genuinely different author", async () => {
        const node = threadNode({
            comments: {nodes: [{author: {login: "alice"}, body: "hi"}]},
        });
        const threads = await collectThreads(
            portFor({threadPages: [onePage([node])]}),
            "o",
            "r",
            1,
            "github-actions[bot]",
        );
        expect(threads).toEqual([]);
    });
});
