import {describe, expect, it} from "vitest";

import {collectInputs, collectThreads, writeInputs} from "./stage.ts";
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
        graphql: async () => (opts.threadPages ?? [])[page++] ?? {},
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

    it("stops rather than looping when a page omits its cursor", async () => {
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
        const threads = await collectThreads(
            portFor({threadPages: [noCursor, noCursor, noCursor]}),
            "o",
            "r",
            1,
            BOT,
        );
        expect(threads).toHaveLength(1);
    });

    it("returns nothing for a malformed GraphQL body", async () => {
        expect(
            await collectThreads(
                portFor({threadPages: [{errors: []}]}),
                "o",
                "r",
                1,
                BOT,
            ),
        ).toEqual([]);
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
