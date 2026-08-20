/**
 * The thumbs feedback sweep — pure, deterministic code (no model in the
 * loop) that turns reviewer-comment reactions into structured feedback.
 *
 * Reviewers on a PR react to the bot's comments with 👍 / 👎. This sweep runs
 * on a poll (e.g. a scheduled workflow), collects those reactions at two
 * grains, and reports them. It is READ-ONLY: it posts nothing.
 *
 * It used to post a "why?" follow-up on every newly-downvoted comment,
 * offering a closed reason vocabulary. That surface was retired after the
 * 2026-08-20 version audit: 31 follow-ups drew 2 reason replies ever, 26 of
 * them landed as bursts on a single PR, and GitHub wraps each posted reply in
 * an implicit empty COMMENTED review event that pollutes run counts and the
 * PR timeline. A bare 👎 has adjudicated the finding directly since v1.17.0
 * (the staging reads thread-opener reactions), so the ask carried no
 * remaining purpose. The follow-up marker parser below is retained so the
 * traversal keeps recognising the historical follow-ups still present on PRs.
 *
 * Division of labour (mirrors the finding-schema / verdict split):
 *   - CODE (this module) owns the two-grain tally and the config guard. There
 *     is no prose synthesis and no model call here.
 *   - The GitHub reads (listing comments, reading reactions) live behind an
 *     injected {@link ThumbsSweepPort} so this module stays pure and
 *     unit-testable, and so the same logic can be pointed at either consumer
 *     repo (Khan/webapp, Khan/frontend) purely by constructing the port +
 *     config differently — the interface guarantee of §4.3. No consumer
 *     commit is required.
 */

/**
 * The two grains at which reviewers leave 👍 / 👎:
 *   - `inline`: a per-line pull-request review comment (fine grain — feedback on
 *     one specific finding).
 *   - `summary`: the standalone risk/patterns PR comment (coarse grain —
 *     feedback on the run as a whole).
 * The sweep collects both so a reviewer can signal "this specific comment was
 * wrong" and "this review overall was noise" independently.
 */
export const FEEDBACK_GRAINS = ["inline", "summary"] as const;

export type FeedbackGrain = typeof FEEDBACK_GRAINS[number];

/**
 * GitHub reaction `content` values treated as positive/negative feedback.
 * These match gh-aw's outcome-collector exactly, so the sweep and the outcome
 * collector agree on what counts as a signal: 👍/❤️/🎉/🚀 are positive,
 * 👎/😕 are negative. (GitHub models 👍 as `"+1"` and 👎 as `"-1"` on the
 * reactions API.)
 */
export const POSITIVE_REACTIONS = ["+1", "heart", "hooray", "rocket"] as const;
export const NEGATIVE_REACTIONS = ["-1", "confused"] as const;

/** A single reaction observed on a bot comment. */
export type Reaction = {
    /** GitHub reaction content, e.g. `"+1"` / `"-1"` (other emoji are ignored). */
    content: string;
    /**
     * Reactor login. Used to exclude the bot's own reactions (e.g. the 👍/👎
     * nudge pair the review workflow seeds on its comments at post time) from
     * feedback counts; a reaction with no login is treated as a real user's.
     */
    user?: string;
};

/** A bot-authored comment (at one grain) together with its current reactions. */
export type BotComment = {
    grain: FeedbackGrain;
    /**
     * GitHub id of the comment. Inline review-comment ids and issue-comment ids
     * are separate id spaces that can collide, so a comment is always
     * identified by the (grain, id) pair.
     */
    id: number;
    /** Reactions currently on the comment (as returned by the reactions API). */
    reactions: Reaction[];
};

/**
 * Per-repo configuration. `owner`/`repo` make the sweep config-driven for either
 * consumer repo; `botLogin` identifies whose comments carry feedback-worthy
 * reactions (the port implementation uses it to filter). These are validated up
 * front so a misconfigured deploy fails loudly rather than sweeping nothing.
 */
export type ThumbsSweepConfig = {
    owner: string;
    repo: string;
    botLogin: string;
};

/**
 * The GitHub side-effect boundary. A real deployment supplies an octokit-backed
 * implementation; tests supply an in-memory fake. The port is read-only: the
 * sweep never writes to GitHub.
 */
export interface ThumbsSweepPort {
    /** Bot-authored comments at `grain`, each carrying its current reactions. */
    listBotComments(grain: FeedbackGrain): Promise<BotComment[]>;
}

/** The per-comment tally the sweep produced. */
export type SweepAction = {
    grain: FeedbackGrain;
    commentId: number;
    /** Number of 👎 currently on the comment (0 when none; the bot's own 👎 never counts). */
    downvotes: number;
};

/** Aggregate outcome of one sweep. */
export type SweepResult = {
    actions: SweepAction[];
    /** Count of comments carrying at least one human 👎. */
    downvotedComments: number;
};

/**
 * Hidden HTML marker the retired follow-ups were stamped with. Parsing is
 * retained so the traversal keeps recognising historical follow-ups (they are
 * bot-authored comments on PRs inside the lookback window and must never be
 * classified as reviewer findings). It encodes the grain + comment id the
 * follow-up answered. Same mechanism as #194's HTML comment markers —
 * invisible in the rendered thread, machine readable on a poll.
 */
const MARKER_PREFIX = "review-thumbs-followup";

const MARKER_RE = new RegExp(
    `<!--\\s*${MARKER_PREFIX}\\s+grain=(${FEEDBACK_GRAINS.join(
        "|",
    )})\\s+comment-id=(\\d+)\\s*-->`,
    "g",
);

/** Build the hidden marker for a (grain, commentId) pair (test fixtures). */
export const buildFollowupMarker = (
    grain: FeedbackGrain,
    commentId: number,
): string => `<!-- ${MARKER_PREFIX} grain=${grain} comment-id=${commentId} -->`;

/** A (grain, commentId) reference recovered from a follow-up marker. */
export type FollowupRef = {grain: FeedbackGrain; commentId: number};

/**
 * Extract every follow-up marker from a comment body. A body normally carries
 * one, but parsing all of them is robust to any accidental concatenation.
 */
export const parseFollowupMarkers = (body: string): FollowupRef[] => {
    const refs: FollowupRef[] = [];
    // `matchAll` needs a fresh lastIndex; construct a per-call regex to stay
    // pure (a shared /g regex would carry lastIndex between calls).
    const re = new RegExp(MARKER_RE.source, "g");
    for (const match of body.matchAll(re)) {
        refs.push({
            grain: match[1] as FeedbackGrain,
            commentId: Number(match[2]),
        });
    }
    return refs;
};

/**
 * Count the negative reactions (👎/😕, per {@link NEGATIVE_REACTIONS}) on a
 * comment. The bot's own reactions (e.g. post-time seeded nudges) are never
 * feedback.
 */
const countDownvotes = (comment: BotComment, botLogin: string): number =>
    comment.reactions.filter(
        (r) =>
            r.user !== botLogin &&
            (NEGATIVE_REACTIONS as readonly string[]).includes(r.content),
    ).length;

/**
 * Validate a {@link ThumbsSweepConfig}. Returns every problem (like the finding
 * validator) so a misconfigured deploy is fully diagnosable. Both consumer repos
 * are configured by supplying different `owner`/`repo` values here.
 */
export type ConfigValidation =
    | {ok: true; config: ThumbsSweepConfig}
    | {ok: false; errors: string[]};

export const validateSweepConfig = (input: unknown): ConfigValidation => {
    const errors: string[] = [];
    const isNonEmptyString = (v: unknown): v is string =>
        typeof v === "string" && v.trim().length > 0;

    if (typeof input !== "object" || input === null) {
        return {ok: false, errors: ["config: must be an object"]};
    }
    const cfg = input as Record<string, unknown>;

    if (!isNonEmptyString(cfg["owner"])) {
        errors.push("owner: required non-empty string");
    }
    if (!isNonEmptyString(cfg["repo"])) {
        errors.push("repo: required non-empty string");
    }
    if (!isNonEmptyString(cfg["botLogin"])) {
        errors.push("botLogin: required non-empty string");
    }

    if (errors.length > 0) {
        return {ok: false, errors};
    }
    return {ok: true, config: cfg as unknown as ThumbsSweepConfig};
};

/**
 * Run one thumbs sweep: for each grain, for each bot comment, count its human
 * 👎 reactions and record the tally. The result is fully determined by the
 * port's responses, so the whole thing is unit-testable with an in-memory
 * fake, and nothing is ever written to GitHub.
 */
export const sweepThumbs = async (
    port: ThumbsSweepPort,
    config: ThumbsSweepConfig,
): Promise<SweepResult> => {
    const validation = validateSweepConfig(config);
    if (!validation.ok) {
        throw new Error(
            `Invalid thumbs-sweep config:\n${validation.errors
                .map((e) => `  - ${e}`)
                .join("\n")}`,
        );
    }

    const actions: SweepAction[] = [];

    for (const grain of FEEDBACK_GRAINS) {
        const comments = await port.listBotComments(grain);
        for (const comment of comments) {
            actions.push({
                grain,
                commentId: comment.id,
                downvotes: countDownvotes(comment, config.botLogin),
            });
        }
    }

    return {
        actions,
        downvotedComments: actions.filter((a) => a.downvotes > 0).length,
    };
};
