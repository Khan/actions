import {describe, it, expect} from "vitest";

import {
    FEEDBACK_GRAINS,
    POSITIVE_REACTIONS,
    NEGATIVE_REACTIONS,
    buildFollowupMarker,
    parseFollowupMarkers,
    validateSweepConfig,
    sweepThumbs,
    type BotComment,
    type FeedbackGrain,
    type ThumbsSweepConfig,
    type ThumbsSweepPort,
} from "./thumbs-sweep.ts";

/**
 * Unit tests for the thumbs feedback sweep. Three behaviors must hold:
 *   - 👎 tally           -> human downvotes are counted, the bot's own never
 *   - two-grain collection -> inline + summary comments are both swept
 *   - read-only          -> the sweep needs nothing but listBotComments
 *
 * The sweep is a pure function of its port's responses, so every test drives
 * an in-memory fake port — no network, no model, fully deterministic.
 */

const VALID_CONFIG: ThumbsSweepConfig = {
    owner: "Khan",
    repo: "webapp",
    botLogin: "khan-review-bot",
};

const up = (): {content: string} => ({content: "+1"});
const down = (): {content: string} => ({content: "-1"});

/** An in-memory read-only {@link ThumbsSweepPort}. */
class FakePort implements ThumbsSweepPort {
    constructor(
        private readonly commentsByGrain: Record<FeedbackGrain, BotComment[]>,
    ) {}

    listBotComments(grain: FeedbackGrain): Promise<BotComment[]> {
        return Promise.resolve(this.commentsByGrain[grain] ?? []);
    }
}

const makeComment = (
    grain: FeedbackGrain,
    id: number,
    reactions: Array<{content: string; user?: string}> = [],
): BotComment => ({grain, id, reactions});

const noComments = (): Record<FeedbackGrain, BotComment[]> => ({
    inline: [],
    summary: [],
});

describe("self-reaction filtering", () => {
    const BOT = VALID_CONFIG.botLogin;

    it("the bot's own thumbs-down never counts", async () => {
        // The bot's reactions exist on real comments: the review workflow
        // seeds the 👍/👎 nudge pair on its comments at post time.
        const port = new FakePort({
            inline: [makeComment("inline", 1, [{content: "-1", user: BOT}])],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions[0]?.downvotes).toBe(0);
        expect(result.downvotedComments).toBe(0);
    });

    it("a real user's thumbs-down still counts alongside the bot's reactions", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 1, [
                    {content: "+1", user: BOT},
                    {content: "-1", user: BOT},
                    {content: "-1", user: "a-real-dev"},
                ]),
            ],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions[0]?.downvotes).toBe(1);
        expect(result.downvotedComments).toBe(1);
    });

    it("a reaction with no login is treated as a real user's", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 1, [{content: "-1"}])],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions[0]?.downvotes).toBe(1);
    });
});

describe("exported constants", () => {
    it("FEEDBACK_GRAINS is exactly inline + summary", () => {
        expect([...FEEDBACK_GRAINS]).toEqual(["inline", "summary"]);
    });

    it("reaction sets match gh-aw's outcome-collector", () => {
        expect([...POSITIVE_REACTIONS]).toEqual([
            "+1",
            "heart",
            "hooray",
            "rocket",
        ]);
        expect([...NEGATIVE_REACTIONS]).toEqual(["-1", "confused"]);
    });
});

describe("validateSweepConfig", () => {
    it("accepts a well-formed config", () => {
        const result = validateSweepConfig(VALID_CONFIG);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.repo).toBe("webapp");
        }
    });

    it("rejects a non-object input", () => {
        expect(validateSweepConfig(null).ok).toBe(false);
        expect(validateSweepConfig("nope").ok).toBe(false);
    });

    it("collects every missing/blank field at once", () => {
        const result = validateSweepConfig({
            owner: "",
            repo: "   ",
            botLogin: 42,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toHaveLength(3);
            expect(result.errors.some((e) => /owner/.test(e))).toBe(true);
            expect(result.errors.some((e) => /repo/.test(e))).toBe(true);
            expect(result.errors.some((e) => /botLogin/.test(e))).toBe(true);
        }
    });

    it("both consumer repos are configurable purely by owner/repo", () => {
        expect(validateSweepConfig({...VALID_CONFIG, repo: "webapp"}).ok).toBe(
            true,
        );
        expect(
            validateSweepConfig({...VALID_CONFIG, repo: "frontend"}).ok,
        ).toBe(true);
    });
});

describe("historical follow-up markers", () => {
    // The follow-up surface is retired, but its markers exist on older PRs and
    // the traversal still uses the parser to exclude them from candidates.
    it("builds a hidden HTML marker encoding grain + comment id", () => {
        const marker = buildFollowupMarker("inline", 123);
        expect(marker).toBe(
            "<!-- review-thumbs-followup grain=inline comment-id=123 -->",
        );
    });

    it("parses every marker in a body and ignores prose without one", () => {
        expect(parseFollowupMarkers("just a normal comment")).toEqual([]);
        const concatenated =
            buildFollowupMarker("inline", 1) +
            "\nsome text\n" +
            buildFollowupMarker("summary", 2);
        expect(parseFollowupMarkers(concatenated)).toEqual([
            {grain: "inline", commentId: 1},
            {grain: "summary", commentId: 2},
        ]);
    });

    it("parseFollowupMarkers is pure across repeated calls (no shared lastIndex)", () => {
        const body = buildFollowupMarker("inline", 55);
        expect(parseFollowupMarkers(body)).toEqual(parseFollowupMarkers(body));
    });
});

describe("👎 tally", () => {
    it("counts multiple 👎 on one comment", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 11, [down(), down(), up()])],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        const action = result.actions.find((a) => a.commentId === 11);
        expect(action?.downvotes).toBe(2);
        expect(result.downvotedComments).toBe(1);
    });

    it("a comment with only 👍 or no reactions is not downvoted", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 20, [up()]),
                makeComment("inline", 21, []),
            ],
            summary: [makeComment("summary", 22, [up(), up()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.downvotedComments).toBe(0);
        for (const action of result.actions) {
            expect(action.downvotes).toBe(0);
        }
    });

    it("ignores emoji outside the outcome-collector sets", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 30, [
                    {content: "heart"},
                    {content: "laugh"},
                    {content: "eyes"},
                ]),
            ],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions[0]?.downvotes).toBe(0);
    });

    it("treats confused as a negative signal (outcome-collector set)", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 31, [{content: "confused"}])],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions[0]?.downvotes).toBe(1);
        expect(result.downvotedComments).toBe(1);
    });

    it("counts each downvoted comment once in downvotedComments", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 40, [down()]),
                makeComment("inline", 41, [down(), up()]),
            ],
            summary: [makeComment("summary", 42, [down()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.downvotedComments).toBe(3);
    });
});

describe("two-grain collection", () => {
    it("sweeps both inline and summary comments in one pass", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 110, [down()])],
            summary: [makeComment("summary", 111, [down()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        const grains = new Set(result.actions.map((a) => a.grain));
        expect(grains).toEqual(new Set(["inline", "summary"]));
        expect(result.downvotedComments).toBe(2);
    });

    it("does not confuse the two id spaces (same id, different grain)", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 100, [down()])],
            summary: [makeComment("summary", 100, [up()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(
            result.actions.find(
                (a) => a.grain === "inline" && a.commentId === 100,
            )?.downvotes,
        ).toBe(1);
        expect(
            result.actions.find(
                (a) => a.grain === "summary" && a.commentId === 100,
            )?.downvotes,
        ).toBe(0);
    });

    it("produces one action per comment across both grains", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 130, [down()]),
                makeComment("inline", 131, [up()]),
            ],
            summary: [makeComment("summary", 132, [])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions).toHaveLength(3);
    });

    it("no comments at either grain -> a clean no-op sweep", async () => {
        const port = new FakePort(noComments());
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(result.actions).toHaveLength(0);
        expect(result.downvotedComments).toBe(0);
    });
});

describe("config guard", () => {
    it("throws (rather than sweeping) on an invalid config", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 140, [down()])],
            summary: [],
        });
        await expect(
            sweepThumbs(port, {
                owner: "",
                repo: "",
                botLogin: "",
            } as ThumbsSweepConfig),
        ).rejects.toThrow(/Invalid thumbs-sweep config/);
    });
});
