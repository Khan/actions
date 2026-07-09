import {describe, it, expect} from "vitest";

import {
    GithubThumbsSweepPort,
    INLINE_COMMENT_PREFIXES,
    isReviewerInlineBody,
    isReviewerSummaryBody,
    type OctokitRequestFn,
} from "./thumbs-sweep-github.ts";
import {buildFollowupMarker, sweepThumbs} from "./thumbs-sweep.ts";

/**
 * Tests for the octokit-backed port. A fake `request` function dispatches on
 * the route template and records writes, so the traversal, the two-grain
 * classification, the reaction resolution, and the write routing are all
 * exercised without a network.
 */

const BOT = "github-actions[bot]";
const NOW = Date.parse("2026-07-08T00:00:00Z");
const RECENT = "2026-07-07T12:00:00Z"; // inside the 14-day window
const STALE = "2026-05-01T00:00:00Z"; // far outside it

// Production summary comments carry gh-aw's engine-emitted call-id marker,
// not (yet) the pr-reviewer marker — mirror that shape here.
const SUMMARY_BODY = [
    "## Review Guidance",
    "<!-- gh-aw-workflow-call-id: Khan/webapp/review -->",
].join("\n");

const PR_REVIEWER_SUMMARY_BODY = [
    "<!-- pr-reviewer:risks-and-patterns -->",
    "## Review Guidance",
    "<!-- pr-reviewer:version v=review-v1.4.0 schema=1 -->",
].join("\n");

type RecordedWrite = {route: string; params: Record<string, unknown>};

/**
 * A fake GitHub: one recent PR (#7) carrying reviewer comments at both grains
 * plus decoys, and one stale PR (#1) that must never be traversed.
 */
const makeFakeGithub = () => {
    const writes: RecordedWrite[] = [];

    const inlineComments = [
        {
            id: 101,
            user: {login: BOT},
            body: "**issue (blocking):** off-by-one in the prune loop.",
            reactions: {total_count: 2},
        },
        {
            // The sweep's own earlier follow-up reply: idempotency source,
            // never a candidate.
            id: 102,
            user: {login: BOT},
            body: `${buildFollowupMarker("inline", 999)}\nThanks!`,
            reactions: {total_count: 0},
        },
        {
            // Bot-authored but not templated like a finding -> ignored.
            id: 103,
            user: {login: BOT},
            body: "some other workflow's inline note",
            reactions: {total_count: 5},
        },
        {
            // Human comment -> ignored.
            id: 104,
            user: {login: "human-dev"},
            body: "**issue (blocking):** looks reviewer-shaped but human.",
            reactions: {total_count: 1},
        },
    ];

    const issueComments = [
        {
            id: 201,
            user: {login: BOT},
            body: SUMMARY_BODY,
            reactions: {total_count: 0},
        },
        {
            // Bot-authored, no risks/patterns marker -> another workflow's.
            id: 202,
            user: {login: BOT},
            body: "Test results: all green",
            reactions: {total_count: 3},
        },
    ];

    const reactionsByComment: Record<number, unknown[]> = {
        101: [
            {content: "-1", user: {login: "human-dev"}},
            {content: "+1", user: {login: BOT}}, // seeded; must not count
        ],
    };

    const request: OctokitRequestFn = async (route, params = {}) => {
        if (route === "GET /repos/{owner}/{repo}/pulls") {
            const page = params["page"] as number;
            return {
                data:
                    page === 1
                        ? [
                              {number: 7, updated_at: RECENT},
                              {number: 1, updated_at: STALE},
                          ]
                        : [],
            };
        }
        if (
            route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"
        ) {
            expect(params["pull_number"]).toBe(7);
            return {data: params["page"] === 1 ? inlineComments : []};
        }
        if (
            route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
        ) {
            expect(params["issue_number"]).toBe(7);
            return {data: params["page"] === 1 ? issueComments : []};
        }
        if (
            route ===
            "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
        ) {
            const id = params["comment_id"] as number;
            return {
                data: params["page"] === 1 ? reactionsByComment[id] ?? [] : [],
            };
        }
        if (
            route ===
            "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
        ) {
            return {data: []};
        }
        if (route.startsWith("POST ")) {
            writes.push({route, params});
            return {data: {}};
        }
        throw new Error(`unexpected route: ${route}`);
    };

    return {request, writes};
};

const makePort = (request: OctokitRequestFn) =>
    new GithubThumbsSweepPort(request, {
        owner: "Khan",
        repo: "webapp",
        botLogin: BOT,
        now: NOW,
    });

describe("comment identification", () => {
    it("recognises every code-owned conventional label as an inline prefix", () => {
        expect(INLINE_COMMENT_PREFIXES).toContain("**issue (blocking):**");
        expect(INLINE_COMMENT_PREFIXES).toContain(
            "**suggestion (non-blocking, best-practice):**",
        );
        expect(isReviewerInlineBody("**todo (blocking):** add the test.")).toBe(
            true,
        );
        expect(isReviewerInlineBody("regular prose")).toBe(false);
    });

    it("identifies the summary comment by either hidden marker", () => {
        // The spec'd pr-reviewer marker matches unconditionally.
        expect(isReviewerSummaryBody(PR_REVIEWER_SUMMARY_BODY)).toBe(true);
        // The engine-emitted call-id marker matches when configured.
        expect(isReviewerSummaryBody(SUMMARY_BODY)).toBe(false);
        expect(
            isReviewerSummaryBody(SUMMARY_BODY, [
                "<!-- gh-aw-workflow-call-id: Khan/webapp/review -->",
            ]),
        ).toBe(true);
        expect(isReviewerSummaryBody("Test results: all green")).toBe(false);
    });
});

describe("traversal and classification", () => {
    it("lists reviewer comments at both grains, excluding decoys and follow-ups", async () => {
        const {request} = makeFakeGithub();
        const port = makePort(request);

        const inline = await port.listBotComments("inline");
        expect(inline.map((c) => c.id)).toEqual([101]);
        // Reactor logins survive so the sweep can exclude the bot's seeds.
        expect(inline[0]?.reactions).toEqual([
            {content: "-1", user: "human-dev"},
            {content: "+1", user: BOT},
        ]);

        const summary = await port.listBotComments("summary");
        expect(summary.map((c) => c.id)).toEqual([201]);

        const followups = await port.listExistingFollowups();
        expect(followups).toHaveLength(1);
        expect(followups[0]).toContain("comment-id=999");
    });

    it("stays within the lookback window and reports auditable stats", async () => {
        const {request} = makeFakeGithub();
        const port = makePort(request);
        await port.listBotComments("inline");

        const stats = port.stats();
        expect(stats.pullsScanned).toBe(1); // the stale PR is never traversed
        // Only the human 👎 counts; the bot's seeded 👍 is excluded.
        expect(stats.thumbs).toEqual({up: 0, down: 1});
        expect(stats.apiRequests).toBeGreaterThan(0);
    });
});

describe("writes", () => {
    it("routes follow-ups per grain (inline reply vs PR comment)", async () => {
        const {request, writes} = makeFakeGithub();
        const port = makePort(request);
        await port.listBotComments("inline"); // populate the comment->PR map

        await port.postFollowup({
            grain: "inline",
            commentId: 101,
            body: "why?",
        });
        await port.postFollowup({
            grain: "summary",
            commentId: 201,
            body: "why?",
        });

        expect(writes.map((w) => w.route)).toEqual([
            "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
            "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        ]);
        expect(writes[0]?.params["pull_number"]).toBe(7);
        expect(writes[0]?.params["comment_id"]).toBe(101);
        expect(writes[1]?.params["issue_number"]).toBe(7);
    });

    it("rejects a follow-up for a comment the traversal never saw", async () => {
        const {request} = makeFakeGithub();
        const port = makePort(request);
        await port.listBotComments("inline");
        await expect(
            port.postFollowup({grain: "inline", commentId: 555, body: "?"}),
        ).rejects.toThrow(/unknown comment/);
    });

    it("seeds reactions on the grain-appropriate endpoint", async () => {
        const {request, writes} = makeFakeGithub();
        const port = makePort(request);
        await port.addReactions("inline", 101, ["+1", "-1"]);
        await port.addReactions("summary", 201, ["+1"]);

        expect(writes.map((w) => [w.route, w.params["content"]])).toEqual([
            [
                "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
                "+1",
            ],
            [
                "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
                "-1",
            ],
            [
                "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
                "+1",
            ],
        ]);
    });
});

describe("end-to-end with the sweep core", () => {
    it("seeds missing nudges and follows up the human 👎 exactly once", async () => {
        const {request, writes} = makeFakeGithub();
        const port = makePort(request);

        const result = await sweepThumbs(port, {
            owner: "Khan",
            repo: "webapp",
            botLogin: BOT,
            seedReactions: true,
        });

        // Comment 101 already has the bot's 👍 -> only 👎 is seeded there;
        // comment 201 has neither -> both are seeded.
        expect(result.reactionsSeeded).toBe(3);
        // The human 👎 on 101 draws exactly one follow-up, threaded inline.
        expect(result.followupsPosted).toBe(1);
        const followupWrites = writes.filter((w) =>
            w.route.includes("replies"),
        );
        expect(followupWrites).toHaveLength(1);
        expect(String(followupWrites[0]?.params["body"])).toContain(
            "review-thumbs-followup grain=inline comment-id=101",
        );
    });
});
