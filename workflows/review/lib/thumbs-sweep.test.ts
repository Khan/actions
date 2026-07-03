import {describe, it, expect} from "vitest";

import {
    FEEDBACK_GRAINS,
    THUMBS_UP,
    THUMBS_DOWN,
    DOWNVOTE_REASONS,
    buildFollowupMarker,
    parseFollowupMarkers,
    renderFollowupBody,
    validateSweepConfig,
    sweepThumbs,
    type BotComment,
    type FeedbackGrain,
    type PostedFollowup,
    type ThumbsSweepConfig,
    type ThumbsSweepPort,
} from "./thumbs-sweep.ts";

/**
 * Unit tests for the R4 thumbs feedback sweep (task-8-2). The task calls out four
 * behaviors that must hold; each has its own describe block below:
 *   - new-👎 detection    -> a comment that carries a 👎 is picked up
 *   - single follow-up    -> exactly one follow-up per newly-downvoted comment
 *   - no re-ping          -> a comment already followed up is never pinged again
 *   - two-grain collection -> inline + summary comments are both swept
 *
 * The sweep is a pure function of its port's responses, so every test drives an
 * in-memory fake port and asserts on the recorded side effects — no network, no
 * model, fully deterministic.
 */

const VALID_CONFIG: ThumbsSweepConfig = {
    owner: "Khan",
    repo: "webapp",
    botLogin: "khan-review-bot",
};

const up = (): {content: string} => ({content: THUMBS_UP});
const down = (): {content: string} => ({content: THUMBS_DOWN});

/**
 * An in-memory {@link ThumbsSweepPort}. Comments are supplied per grain; posted
 * follow-ups are captured; `existingFollowups` seeds the durable idempotency
 * source (as if prior sweeps had run). `postFollowup` also appends to
 * `existingFollowups` so a second sweep in the same test sees the first sweep's
 * markers — exactly what a real GitHub thread would show on the next poll.
 */
class FakePort implements ThumbsSweepPort {
    posted: PostedFollowup[] = [];

    constructor(
        private readonly commentsByGrain: Record<FeedbackGrain, BotComment[]>,
        private readonly existingFollowups: string[] = [],
    ) {}

    listBotComments(grain: FeedbackGrain): Promise<BotComment[]> {
        return Promise.resolve(this.commentsByGrain[grain] ?? []);
    }

    listExistingFollowups(): Promise<string[]> {
        return Promise.resolve(this.existingFollowups);
    }

    postFollowup(followup: PostedFollowup): Promise<void> {
        this.posted.push(followup);
        // Mirror the real thread: the follow-up (with its marker) is now visible
        // to any later sweep.
        this.existingFollowups.push(followup.body);
        return Promise.resolve();
    }
}

const makeComment = (
    grain: FeedbackGrain,
    id: number,
    reactions: Array<{content: string}> = [],
): BotComment => ({grain, id, reactions});

const noComments = (): Record<FeedbackGrain, BotComment[]> => ({
    inline: [],
    summary: [],
});

describe("exported constants", () => {
    it("FEEDBACK_GRAINS is exactly inline + summary", () => {
        expect([...FEEDBACK_GRAINS]).toEqual(["inline", "summary"]);
    });

    it("thumbs signals key off GitHub's +1 / -1 reaction content", () => {
        expect(THUMBS_UP).toBe("+1");
        expect(THUMBS_DOWN).toBe("-1");
    });

    it("DOWNVOTE_REASONS is the fixed closed vocabulary", () => {
        expect([...DOWNVOTE_REASONS]).toEqual([
            "incorrect",
            "unimportant",
            "unclear",
            "duplicate",
        ]);
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

describe("marker + follow-up rendering", () => {
    it("builds a hidden HTML marker encoding grain + comment id", () => {
        const marker = buildFollowupMarker("inline", 123);
        expect(marker).toBe(
            "<!-- review-thumbs-followup grain=inline comment-id=123 -->",
        );
    });

    it("round-trips a marker through parseFollowupMarkers", () => {
        const body = renderFollowupBody("summary", 987);
        const refs = parseFollowupMarkers(body);
        expect(refs).toEqual([{grain: "summary", commentId: 987}]);
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
        const body = renderFollowupBody("inline", 55);
        expect(parseFollowupMarkers(body)).toEqual(parseFollowupMarkers(body));
    });

    it("the follow-up body offers the full reason vocabulary plus free text", () => {
        const body = renderFollowupBody("inline", 7);
        for (const reason of DOWNVOTE_REASONS) {
            expect(body).toContain(reason);
        }
        expect(body).toMatch(/free-text/i);
        // The idempotency promise is stated to the reader, too.
        expect(body).toMatch(/won't ask again/i);
    });
});

describe("new-👎 detection", () => {
    it("posts a follow-up for a comment carrying a 👎", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 10, [down()])],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(1);
        expect(port.posted[0]).toMatchObject({grain: "inline", commentId: 10});
        expect(result.followupsPosted).toBe(1);

        const action = result.actions.find((a) => a.commentId === 10);
        expect(action).toMatchObject({
            grain: "inline",
            downvotes: 1,
            posted: true,
            reason: "posted",
        });
    });

    it("counts multiple 👎 but still treats the comment as one downvoted unit", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 11, [down(), down(), up()])],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(1);
        const action = result.actions.find((a) => a.commentId === 11);
        expect(action?.downvotes).toBe(2);
        expect(action?.posted).toBe(true);
    });

    it("does NOT follow up a comment with only 👍 or no reactions", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 20, [up()]),
                makeComment("inline", 21, []),
            ],
            summary: [makeComment("summary", 22, [up(), up()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(0);
        expect(result.followupsPosted).toBe(0);
        for (const action of result.actions) {
            expect(action.posted).toBe(false);
            expect(action.reason).toBe("no-downvote");
            expect(action.downvotes).toBe(0);
        }
    });

    it("ignores unrelated reaction emoji, keying strictly on -1", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 30, [
                    {content: "heart"},
                    {content: "laugh"},
                    {content: "confused"},
                ]),
            ],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        expect(port.posted).toHaveLength(0);
        expect(result.actions[0]?.reason).toBe("no-downvote");
    });
});

describe("single follow-up", () => {
    it("posts exactly one follow-up per downvoted comment in a sweep", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 40, [down()]),
                makeComment("inline", 41, [down(), up()]),
            ],
            summary: [makeComment("summary", 42, [down()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        // Three distinct downvoted comments -> three follow-ups, one each.
        expect(result.followupsPosted).toBe(3);
        const postedKeys = port.posted.map((p) => `${p.grain}:${p.commentId}`);
        expect(postedKeys).toEqual(["inline:40", "inline:41", "summary:42"]);
        // No duplicates.
        expect(new Set(postedKeys).size).toBe(postedKeys.length);
    });

    it("invariant: followupsPosted never exceeds the new-downvote count", async () => {
        const port = new FakePort({
            inline: [
                makeComment("inline", 50, [down()]),
                makeComment("inline", 51, [up()]),
            ],
            summary: [makeComment("summary", 52, [down()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);
        const newDownvotedComments = result.actions.filter(
            (a) => a.downvotes > 0 && a.reason !== "already-followed-up",
        ).length;
        expect(result.followupsPosted).toBeLessThanOrEqual(
            newDownvotedComments,
        );
        expect(result.followupsPosted).toBe(2);
    });

    it("dedups a colliding comment id that appears within the same sweep", async () => {
        // Real GitHub would not list the same (grain,id) twice, but the guard is
        // defensive: the in-sweep set must prevent a second post.
        const dup = makeComment("inline", 60, [down()]);
        const port = new FakePort({
            inline: [dup, {...dup, reactions: [down()]}],
            summary: [],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(1);
        const reasons = result.actions
            .filter((a) => a.commentId === 60)
            .map((a) => a.reason);
        expect(reasons).toContain("posted");
        expect(reasons).toContain("already-followed-up");
    });
});

describe("no re-ping", () => {
    it("skips a comment whose follow-up marker already exists (prior sweep)", async () => {
        const port = new FakePort(
            {inline: [makeComment("inline", 70, [down()])], summary: []},
            [buildFollowupMarker("inline", 70)],
        );
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(0);
        expect(result.followupsPosted).toBe(0);
        const action = result.actions.find((a) => a.commentId === 70);
        expect(action).toMatchObject({
            downvotes: 1,
            posted: false,
            reason: "already-followed-up",
        });
    });

    it("is idempotent across consecutive sweeps of the same downvoted comment", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 80, [down()])],
            summary: [],
        });

        const first = await sweepThumbs(port, VALID_CONFIG);
        expect(first.followupsPosted).toBe(1);

        // The FakePort records the posted body into existingFollowups, so the
        // second sweep sees the marker exactly as a real re-poll would.
        const second = await sweepThumbs(port, VALID_CONFIG);
        expect(second.followupsPosted).toBe(0);
        expect(port.posted).toHaveLength(1);
        expect(second.actions.find((a) => a.commentId === 80)?.reason).toBe(
            "already-followed-up",
        );
    });

    it("re-pings a DIFFERENT comment even when another was already followed up", async () => {
        const port = new FakePort(
            {
                inline: [
                    makeComment("inline", 90, [down()]), // already handled
                    makeComment("inline", 91, [down()]), // brand new 👎
                ],
                summary: [],
            },
            [buildFollowupMarker("inline", 90)],
        );
        await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(1);
        expect(port.posted[0]?.commentId).toBe(91);
    });

    it("does not confuse the two id spaces (same id, different grain)", async () => {
        // inline #100 already followed up; summary #100 is a distinct comment
        // and must still be pinged — the key pairs id WITH grain.
        const port = new FakePort(
            {
                inline: [makeComment("inline", 100, [down()])],
                summary: [makeComment("summary", 100, [down()])],
            },
            [buildFollowupMarker("inline", 100)],
        );
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(1);
        expect(port.posted[0]).toMatchObject({
            grain: "summary",
            commentId: 100,
        });
        expect(
            result.actions.find(
                (a) => a.grain === "inline" && a.commentId === 100,
            )?.reason,
        ).toBe("already-followed-up");
        expect(
            result.actions.find(
                (a) => a.grain === "summary" && a.commentId === 100,
            )?.reason,
        ).toBe("posted");
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
        expect(result.followupsPosted).toBe(2);
        expect(port.posted.map((p) => p.grain).sort()).toEqual([
            "inline",
            "summary",
        ]);
    });

    it("collects the two grains independently — a summary miss doesn't gate inline", async () => {
        const port = new FakePort({
            inline: [makeComment("inline", 120, [down()])],
            summary: [makeComment("summary", 121, [up()])],
        });
        const result = await sweepThumbs(port, VALID_CONFIG);

        expect(port.posted).toHaveLength(1);
        expect(port.posted[0]?.grain).toBe("inline");
        expect(result.actions.find((a) => a.grain === "summary")?.reason).toBe(
            "no-downvote",
        );
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
        expect(result.followupsPosted).toBe(0);
        expect(port.posted).toHaveLength(0);
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
        // Nothing was posted because the guard fires before any traversal.
        expect(port.posted).toHaveLength(0);
    });
});
