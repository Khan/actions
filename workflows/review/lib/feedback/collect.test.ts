/**
 * Fixtures here are INVENTED. Khan/actions is public and the consumer repos
 * are private, so no real PR title, comment body, or author handle from a
 * consumer repo may appear in this file — the logins are `dev-one`/`dev-two`
 * and the bodies are placeholders.
 */
import {describe, it, expect, beforeEach, afterEach} from "vitest";

import {
    collectFeedback,
    inWindow,
    isHumanReactor,
    parseCommentLabel,
    parseReviewVersion,
    numberFromApiUrl,
    windowStartFor,
    GUIDANCE_MARKER,
    SEARCH_RESULT_CAP,
    type FeedbackPort,
    type CollectOptions,
} from "./collect";
import {toJsonl, type FeedbackEvent} from "./types";

const BOT = "github-actions[bot]";
const WINDOW_START = "2026-08-12T00:00:00Z";
const WINDOW_END = "2026-08-19T00:00:00Z";
const IN = "2026-08-14T12:00:00Z";
const BEFORE = "2026-08-01T12:00:00Z";

const options = (over: Partial<CollectOptions> = {}): CollectOptions => ({
    repo: "Khan/fixture",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    collectedAt: "2026-08-19T01:00:00Z",
    botLogin: BOT,
    ...over,
});

/** An inline review comment as the REST listing returns it. */
const inlineComment = (
    over: Record<string, unknown>,
): Record<string, unknown> => ({
    id: 1,
    user: {login: BOT},
    body: "**nitpick:** placeholder finding.",
    path: "src/a.ts",
    line: 10,
    created_at: IN,
    updated_at: IN,
    html_url: "https://github.com/Khan/fixture/pull/7#discussion_r1",
    pull_request_url: "https://api.github.com/repos/Khan/fixture/pulls/7",
    reactions: {total_count: 0},
    ...over,
});

/**
 * A port whose responses are looked up by exact path prefix. Anything not
 * listed answers an empty list / empty object, so each test states only the
 * endpoints it cares about.
 */
const portOf = (routes: Record<string, unknown>): FeedbackPort => {
    const lookup = (path: string): unknown => {
        const bare = path.split("?")[0] ?? path;
        return routes[path] ?? routes[bare];
    };
    return {
        rest: async (path) => {
            const hit = lookup(path);
            if (hit instanceof Error) {
                throw hit;
            }
            return hit ?? {};
        },
        restPaged: async (path) => {
            const hit = lookup(path);
            if (hit instanceof Error) {
                throw hit;
            }
            return Array.isArray(hit) ? hit : [];
        },
        graphql: async () => ({
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            nodes: [],
                            pageInfo: {hasNextPage: false},
                        },
                    },
                },
            },
        }),
    };
};

const kinds = (events: readonly FeedbackEvent[], kind: string) =>
    events.filter((event) => event.kind === kind);

/* -------------------------------------------------------------------------- */

describe("parseCommentLabel", () => {
    it("reads a bare Conventional-Comments label", () => {
        expect(parseCommentLabel("**nitpick:** wording.")).toBe("nitpick");
    });

    it("reads a qualified label and normalizes its spacing", () => {
        expect(
            parseCommentLabel("**issue (blocking,correctness):** boom."),
        ).toBe("issue (blocking, correctness)");
    });

    it("tolerates the markdown-stripped form the staged bodies carry", () => {
        expect(parseCommentLabel("suggestion (non-blocking): tidy.")).toBe(
            "suggestion (non-blocking)",
        );
    });

    it("returns empty for prose whose first word is not a label, so an unlabeled body stays a reportable anomaly", () => {
        expect(parseCommentLabel("Consider: renaming this.")).toBe("");
        expect(parseCommentLabel("no label at all")).toBe("");
    });
});

describe("parseReviewVersion: runs are counted by the footer, not by events", () => {
    it("extracts the version from a collapsed footer", () => {
        expect(
            parseReviewVersion(
                "Summary.\n<sub>review-v1.25.1 | schema 4 | depth full</sub>",
            ),
        ).toBe("1.25.1");
    });

    it("returns null for a footerless review — an empty COMMENTED review from autofix is not a reviewer run", () => {
        expect(parseReviewVersion("")).toBeNull();
        expect(parseReviewVersion("just a reply")).toBeNull();
    });
});

describe("inWindow", () => {
    it("is half-open: start is in, end is out", () => {
        expect(inWindow(WINDOW_START, WINDOW_START, WINDOW_END)).toBe(true);
        expect(inWindow(WINDOW_END, WINDOW_START, WINDOW_END)).toBe(false);
    });

    it("places an empty stamp outside every window", () => {
        expect(inWindow("", WINDOW_START, WINDOW_END)).toBe(false);
    });
});

describe("isHumanReactor: claude[bot] seeds vote buttons (PRA-2)", () => {
    it("excludes every [bot] account, not just this install's review bot", () => {
        expect(isHumanReactor("claude[bot]")).toBe(false);
        expect(isHumanReactor("github-actions[bot]")).toBe(false);
        expect(isHumanReactor("dependabot[bot]")).toBe(false);
    });

    it("excludes an unattributable reactor", () => {
        expect(isHumanReactor("")).toBe(false);
    });

    it("admits a human", () => {
        expect(isHumanReactor("dev-one")).toBe(true);
    });
});

describe("numberFromApiUrl", () => {
    it("reads the trailing number off a PR/issue api url", () => {
        expect(
            numberFromApiUrl(
                "https://api.github.com/repos/Khan/fixture/pulls/4321",
            ),
        ).toBe(4321);
    });

    it("is 0 when there is no number to read", () => {
        expect(numberFromApiUrl("")).toBe(0);
    });
});

describe("windowStartFor", () => {
    it("subtracts whole days from the window end", () => {
        expect(windowStartFor("2026-08-19T00:00:00.000Z", 7)).toBe(
            "2026-08-12T00:00:00.000Z",
        );
    });
});

/* -------------------------------------------------------------------------- */

describe("collectFeedback: `since=` filters on updated_at", () => {
    it("re-filters on created_at, dropping an old comment edited inside the window", () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1, created_at: IN}),
                // The exact pollution the 08-18 sweep hit: created before the
                // window, edited during it, so `since=` returns it.
                inlineComment({id: 2, created_at: BEFORE, updated_at: IN}),
            ],
        });
        return collectFeedback(port, options()).then((result) => {
            expect(
                kinds(result.events, "bot_inline_comment").map((e) =>
                    "id" in e ? e.id : 0,
                ),
            ).toEqual([1]);
        });
    });

    it("re-filters reviews on submitted_at, not the search window", async () => {
        const port = portOf({
            "/search/issues": {
                total_count: 1,
                items: [{number: 7}],
            },
            "/repos/Khan/fixture/pulls/7/reviews": [
                {
                    id: 90,
                    user: {login: BOT},
                    state: "APPROVED",
                    submitted_at: IN,
                    body: "<sub>review-v1.25.1</sub>",
                },
                {
                    id: 91,
                    user: {login: BOT},
                    state: "COMMENTED",
                    submitted_at: BEFORE,
                    body: "<sub>review-v1.24.0</sub>",
                },
            ],
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "review_verdict")).toEqual([
            {
                kind: "review_verdict",
                id: 90,
                pr: 7,
                state: "APPROVED",
                submitted_at: IN,
                reviewVersion: "1.25.1",
                bodyLength: "<sub>review-v1.25.1</sub>".length,
            },
        ]);
    });

    it("records a footerless bot review with a null version so run counting can exclude it", async () => {
        const port = portOf({
            "/search/issues": {total_count: 1, items: [{number: 7}]},
            "/repos/Khan/fixture/pulls/7/reviews": [
                {
                    id: 92,
                    user: {login: BOT},
                    state: "COMMENTED",
                    submitted_at: IN,
                    body: "",
                },
            ],
        });
        const result = await collectFeedback(port, options());
        const [verdict] = kinds(result.events, "review_verdict");
        expect(
            verdict !== undefined && "reviewVersion" in verdict
                ? verdict.reviewVersion
                : "unset",
        ).toBeNull();
    });
});

describe("collectFeedback: reactions do not bump updated_at", () => {
    it("enumerates per comment only when total_count > 0, and filters by the reaction's own created_at", async () => {
        const fetched: string[] = [];
        const base = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1, reactions: {total_count: 2}}),
                inlineComment({id: 2, reactions: {total_count: 0}}),
            ],
            "/repos/Khan/fixture/pulls/comments/1/reactions": [
                {user: {login: "dev-one"}, content: "+1", created_at: IN},
                // A reaction from before the window: the comment is in-window,
                // the reaction is not.
                {user: {login: "dev-two"}, content: "-1", created_at: BEFORE},
            ],
        });
        const port: FeedbackPort = {
            ...base,
            restPaged: async (path) => {
                fetched.push(path);
                return base.restPaged(path);
            },
        };
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "reaction")).toEqual([
            {
                kind: "reaction",
                commentId: 1,
                subject: "inline",
                pr: 7,
                reactor: "dev-one",
                content: "+1",
                created_at: IN,
            },
        ]);
        expect(
            fetched.some((path) => path.includes("comments/2/reactions")),
        ).toBe(false);
    });

    it("drops bot reactors, including the claude[bot] vote-button seeds", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1, reactions: {total_count: 3}}),
            ],
            "/repos/Khan/fixture/pulls/comments/1/reactions": [
                {user: {login: "claude[bot]"}, content: "+1", created_at: IN},
                {user: {login: "claude[bot]"}, content: "-1", created_at: IN},
                {user: {login: "dev-one"}, content: "-1", created_at: IN},
            ],
        });
        const result = await collectFeedback(port, options());
        expect(
            kinds(result.events, "reaction").map((e) =>
                "reactor" in e ? e.reactor : "",
            ),
        ).toEqual(["dev-one"]);
    });

    it("collects reactions on guidance comments too, off the issue endpoint", async () => {
        const port = portOf({
            "/repos/Khan/fixture/issues/comments": [
                {
                    id: 50,
                    user: {login: BOT},
                    body: `Guidance.\n${GUIDANCE_MARKER}`,
                    created_at: IN,
                    html_url: "https://github.com/Khan/fixture/pull/7#issue-50",
                    issue_url:
                        "https://api.github.com/repos/Khan/fixture/issues/7",
                    reactions: {total_count: 1},
                },
            ],
            "/repos/Khan/fixture/issues/comments/50/reactions": [
                {user: {login: "dev-two"}, content: "eyes", created_at: IN},
            ],
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "guidance_comment")).toHaveLength(1);
        expect(kinds(result.events, "reaction")).toEqual([
            {
                kind: "reaction",
                commentId: 50,
                subject: "issue",
                pr: 7,
                reactor: "dev-two",
                content: "eyes",
                created_at: IN,
            },
        ]);
    });

    it("enumerates an out-of-window bot comment the since-sweep resurfaced, keeping only its in-window reactions", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                // Created before the window, edited inside it (which is why
                // the `since=` sweep returned it), reacted to this week.
                inlineComment({
                    id: 3,
                    created_at: BEFORE,
                    updated_at: IN,
                    reactions: {total_count: 2},
                }),
            ],
            "/repos/Khan/fixture/pulls/comments/3/reactions": [
                {user: {login: "dev-one"}, content: "+1", created_at: IN},
                {user: {login: "dev-two"}, content: "-1", created_at: BEFORE},
            ],
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "bot_inline_comment")).toEqual([]);
        expect(kinds(result.events, "reaction")).toEqual([
            {
                kind: "reaction",
                commentId: 3,
                subject: "inline",
                pr: 7,
                reactor: "dev-one",
                content: "+1",
                created_at: IN,
            },
        ]);
    });

    it("degrades one unreadable comment's reactions to a meta warning, never the report", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1, reactions: {total_count: 1}}),
            ],
            "/repos/Khan/fixture/pulls/comments/1/reactions": new Error("404"),
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "reaction")).toEqual([]);
        expect(kinds(result.events, "bot_inline_comment")).toHaveLength(1);
        expect(result.meta.truncationWarnings.join(" ")).toContain(
            "reactions for inline comment 1",
        );
    });
});

describe("collectFeedback: replies point at the thread ROOT", () => {
    it("keeps a reply whose out-of-window parent resolves to a bot comment, drops one whose parent is human", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1}),
                {
                    ...inlineComment({}),
                    id: 2,
                    user: {login: "dev-one"},
                    body: "fixed, thanks",
                    in_reply_to_id: 1,
                },
                // Parent 900 is an OLDER bot finding, outside this window.
                {
                    ...inlineComment({}),
                    id: 3,
                    user: {login: "dev-one"},
                    body: "disagree, because ...",
                    in_reply_to_id: 900,
                },
                // Parent 901 is a human-opened thread: not our feedback.
                {
                    ...inlineComment({}),
                    id: 4,
                    user: {login: "dev-two"},
                    body: "unrelated chatter",
                    in_reply_to_id: 901,
                },
            ],
            "/repos/Khan/fixture/pulls/comments/900": {
                id: 900,
                user: {login: BOT},
            },
            "/repos/Khan/fixture/pulls/comments/901": {
                id: 901,
                user: {login: "dev-two"},
            },
        });
        const result = await collectFeedback(port, options());
        expect(
            kinds(result.events, "human_reply").map((e) =>
                "id" in e ? e.id : 0,
            ),
        ).toEqual([2, 3]);
    });

    it("fetches each unknown parent exactly once", async () => {
        const seen: string[] = [];
        const base = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                {
                    ...inlineComment({}),
                    id: 2,
                    user: {login: "dev-one"},
                    in_reply_to_id: 900,
                },
                {
                    ...inlineComment({}),
                    id: 3,
                    user: {login: "dev-two"},
                    in_reply_to_id: 900,
                },
            ],
            "/repos/Khan/fixture/pulls/comments/900": {
                id: 900,
                user: {login: BOT},
            },
        });
        const port: FeedbackPort = {
            ...base,
            rest: async (path) => {
                seen.push(path);
                return base.rest(path);
            },
        };
        await collectFeedback(port, options());
        expect(
            seen.filter((path) => path.endsWith("/pulls/comments/900")),
        ).toHaveLength(1);
    });

    it("does not treat the bot's own reply as human feedback", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1}),
                inlineComment({id: 2, in_reply_to_id: 1}),
            ],
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "human_reply")).toEqual([]);
        // The bot's reply is a reply, not a finding: it must not inflate the
        // posted-comment count either.
        expect(kinds(result.events, "bot_inline_comment")).toHaveLength(1);
    });
});

describe("collectFeedback: search caps at 1,000 results silently", () => {
    it("records a truncation warning when total_count exceeds the cap", async () => {
        const port = portOf({
            "/search/issues": {
                total_count: SEARCH_RESULT_CAP + 1,
                items: [{number: 7}],
            },
        });
        const result = await collectFeedback(port, options());
        expect(result.meta.truncationWarnings.join(" ")).toContain(
            "LOWER BOUND",
        );
    });

    it("records no warning when the match count fits under the cap", async () => {
        const port = portOf({
            "/search/issues": {total_count: 3, items: [{number: 7}]},
        });
        const result = await collectFeedback(port, options());
        expect(result.meta.truncationWarnings).toEqual([]);
        expect(result.meta.prNumbers).toEqual([7]);
    });
});

describe("collectFeedback: thread resolution state comes from GraphQL", () => {
    it("records resolution, resolver, opener downvotes and who opened the thread", async () => {
        const base = portOf({
            "/search/issues": {total_count: 1, items: [{number: 7}]},
        });
        const port: FeedbackPort = {
            ...base,
            graphql: async () => ({
                data: {
                    repository: {
                        pullRequest: {
                            reviewThreads: {
                                nodes: [
                                    {
                                        id: "PRRT_bot",
                                        path: "src/a.ts",
                                        line: 10,
                                        isResolved: true,
                                        resolvedBy: {login: "dev-one"},
                                        comments: {
                                            nodes: [
                                                {
                                                    author: {
                                                        login: "github-actions",
                                                    },
                                                    body: "**issue (blocking):** x",
                                                    url: "https://github.com/Khan/fixture/pull/7#discussion_r1",
                                                    reactions: {
                                                        nodes: [
                                                            {
                                                                content:
                                                                    "THUMBS_DOWN",
                                                                user: {
                                                                    login: "dev-two",
                                                                },
                                                            },
                                                        ],
                                                    },
                                                },
                                                {
                                                    author: {login: "dev-one"},
                                                    body: "fixed",
                                                    reactions: {nodes: []},
                                                },
                                            ],
                                        },
                                    },
                                    {
                                        id: "PRRT_human",
                                        path: "src/b.ts",
                                        line: 2,
                                        isResolved: false,
                                        comments: {
                                            nodes: [
                                                {
                                                    author: {login: "dev-two"},
                                                    body: "human thread",
                                                    reactions: {nodes: []},
                                                },
                                            ],
                                        },
                                    },
                                ],
                                pageInfo: {hasNextPage: false},
                            },
                        },
                    },
                },
            }),
        };
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "thread_state")).toEqual([
            {
                kind: "thread_state",
                thread_id: "PRRT_bot",
                pr: 7,
                path: "src/a.ts",
                line: 10,
                url: "https://github.com/Khan/fixture/pull/7#discussion_r1",
                botOpened: true,
                resolved: true,
                resolvedBy: "dev-one",
                openerDownvotes: 1,
                commentCount: 2,
            },
            {
                kind: "thread_state",
                thread_id: "PRRT_human",
                pr: 7,
                path: "src/b.ts",
                line: 2,
                url: "",
                botOpened: false,
                resolved: false,
                resolvedBy: "",
                openerDownvotes: 0,
                commentCount: 1,
            },
        ]);
    });

    it("degrades a PR whose threads fail (a GET-only broker blocks GraphQL) to a warning", async () => {
        const base = portOf({
            "/search/issues": {total_count: 1, items: [{number: 7}]},
        });
        const port: FeedbackPort = {
            ...base,
            graphql: async () => ({errors: [{message: "forbidden"}]}),
        };
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "thread_state")).toEqual([]);
        expect(result.meta.truncationWarnings.join(" ")).toContain(
            "review threads for PR 7",
        );
    });
});

describe("collectFeedback: skip-ai-review label events", () => {
    it("keeps only the opt-out label, only inside the window", async () => {
        const port = portOf({
            "/search/issues": {total_count: 1, items: [{number: 7}]},
            "/repos/Khan/fixture/issues/7/events": [
                {
                    event: "labeled",
                    label: {name: "skip-ai-review"},
                    actor: {login: "dev-one"},
                    created_at: IN,
                },
                {
                    event: "unlabeled",
                    label: {name: "skip-ai-review"},
                    actor: {login: "dev-one"},
                    created_at: BEFORE,
                },
                {
                    event: "labeled",
                    label: {name: "needs-review"},
                    actor: {login: "dev-two"},
                    created_at: IN,
                },
                {event: "closed", actor: {login: "dev-two"}, created_at: IN},
            ],
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "label_event")).toEqual([
            {
                kind: "label_event",
                pr: 7,
                label: "skip-ai-review",
                action: "labeled",
                actor: "dev-one",
                created_at: IN,
            },
        ]);
    });
});

describe("collectFeedback: bot identity is per install", () => {
    const saved = process.env.REVIEW_BOT_LOGIN;
    beforeEach(() => {
        delete process.env.REVIEW_BOT_LOGIN;
    });
    afterEach(() => {
        if (saved === undefined) {
            delete process.env.REVIEW_BOT_LOGIN;
        } else {
            process.env.REVIEW_BOT_LOGIN = saved;
        }
    });

    it("reads REVIEW_BOT_LOGIN when no login is passed", async () => {
        process.env.REVIEW_BOT_LOGIN = "claude[bot]";
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1, user: {login: "claude[bot]"}}),
                inlineComment({id: 2, user: {login: BOT}}),
            ],
        });
        const result = await collectFeedback(port, {
            repo: "Khan/fixture",
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            collectedAt: "2026-08-19T01:00:00Z",
        });
        expect(result.meta.botLogin).toBe("claude[bot]");
        expect(
            kinds(result.events, "bot_inline_comment").map((e) =>
                "id" in e ? e.id : 0,
            ),
        ).toEqual([1]);
    });

    it("matches across the [bot] suffix split, so a GraphQL-spelled login is still the bot", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 1, user: {login: "github-actions"}}),
            ],
        });
        const result = await collectFeedback(port, options());
        expect(kinds(result.events, "bot_inline_comment")).toHaveLength(1);
    });
});

describe("collectFeedback: output shape", () => {
    it("fills the meta record and serializes one JSON object per line", async () => {
        const port = portOf({
            "/repos/Khan/fixture/pulls/comments": [inlineComment({id: 1})],
            "/search/issues": {total_count: 1, items: [{number: 7}]},
        });
        const result = await collectFeedback(port, options());
        expect(result.meta).toEqual({
            repo: "Khan/fixture",
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            botLogin: BOT,
            collected_at: "2026-08-19T01:00:00Z",
            truncationWarnings: [],
            prNumbers: [7],
        });
        const lines = toJsonl(result.events).trimEnd().split("\n");
        expect(lines).toHaveLength(result.events.length);
        expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
            kind: "bot_inline_comment",
            id: 1,
            pr: 7,
            label: "nitpick",
            bodyLength: "**nitpick:** placeholder finding.".length,
        });
    });

    it("is deterministic: the same responses produce byte-identical jsonl", async () => {
        const routes = {
            "/repos/Khan/fixture/pulls/comments": [
                inlineComment({id: 3}),
                inlineComment({id: 1}),
                inlineComment({id: 2}),
            ],
        };
        const first = await collectFeedback(portOf(routes), options());
        const second = await collectFeedback(portOf(routes), options());
        expect(toJsonl(first.events)).toBe(toJsonl(second.events));
        expect(
            kinds(first.events, "bot_inline_comment").map((e) =>
                "id" in e ? e.id : 0,
            ),
        ).toEqual([1, 2, 3]);
    });

    it("rejects a repo that is not owner/name rather than fetching nonsense", async () => {
        await expect(
            collectFeedback(portOf({}), options({repo: "fixture"})),
        ).rejects.toThrow(/owner\/name/);
    });
});
