/**
 * The thumbs feedback sweep — pure, deterministic code (no model in the
 * loop) that turns reviewer-comment reactions into structured feedback.
 *
 * Reviewers on a PR react to the bot's comments with 👍 / 👎. This sweep runs
 * on a poll (e.g. a scheduled workflow), collects those reactions at two grains,
 * and for every comment that has newly acquired a 👎 posts exactly ONE follow-up
 * asking *why* — offering the fixed reason vocabulary (incorrect / unimportant /
 * unclear / duplicate) plus free text. It never re-pings: once a comment has a
 * follow-up it is skipped on every later sweep.
 *
 * Division of labour (mirrors the finding-schema / verdict split):
 *   - CODE (this module) owns all control flow, the two-grain traversal, the
 *     idempotency rule, and the fixed follow-up template. There is no prose
 *     synthesis and no model call here — the follow-up body is a constant string.
 *   - The GitHub side effects (listing comments, reading reactions, posting the
 *     follow-up) live behind an injected {@link ThumbsSweepPort} so this module
 *     stays pure and unit-testable, and so the same logic can be pointed at
 *     either consumer repo (Khan/webapp, Khan/frontend) purely by constructing
 *     the port + config differently — the interface guarantee of §4.3. No
 *     consumer commit is required.
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
 * GitHub's reaction `content` values for the thumbs signals. GitHub models 👍 as
 * `"+1"` and 👎 as `"-1"` on the reactions API; we key off those exact strings.
 */
export const THUMBS_UP = "+1";
export const THUMBS_DOWN = "-1";

/**
 * The fixed vocabulary a follow-up offers the reactor for *why* they downvoted.
 * Deliberately closed so the labels aggregate cleanly (they calibrate the
 * eval-suite judge and feed the dismissal-learning candidates); free text
 * is invited in addition, not instead.
 */
export const DOWNVOTE_REASONS = [
    "incorrect",
    "unimportant",
    "unclear",
    "duplicate",
] as const;

export type DownvoteReason = typeof DOWNVOTE_REASONS[number];

/** A single reaction observed on a bot comment. */
export type Reaction = {
    /** GitHub reaction content, e.g. `"+1"` / `"-1"` (other emoji are ignored). */
    content: string;
    /** Reactor login — carried for audit/logging only; not used for idempotency. */
    user?: string;
};

/** A bot-authored comment (at one grain) together with its current reactions. */
export type BotComment = {
    grain: FeedbackGrain;
    /**
     * GitHub id of the comment. Inline review-comment ids and issue-comment ids
     * are separate id spaces that can collide, so the idempotency key always
     * pairs the id with its grain.
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
 * implementation; tests supply an in-memory fake. Keeping every network call
 * behind this interface is what makes the sweep a pure function of its inputs.
 */
export interface ThumbsSweepPort {
    /** Bot-authored comments at `grain`, each carrying its current reactions. */
    listBotComments(grain: FeedbackGrain): Promise<BotComment[]>;
    /**
     * Bodies of every follow-up already posted by prior sweeps. The sweep scans
     * these for its marker to decide what has already been pinged — this is the
     * durable idempotency source, so no external state store is needed.
     */
    listExistingFollowups(): Promise<string[]>;
    /** Post a single follow-up comment. Called at most once per (grain, id). */
    postFollowup(followup: PostedFollowup): Promise<void>;
}

/** A follow-up the sweep asks the port to post. */
export type PostedFollowup = {
    grain: FeedbackGrain;
    /** Id of the comment the follow-up is about. */
    commentId: number;
    /** Fully rendered body (hidden marker + the fixed prompt). */
    body: string;
};

/** Why the sweep did (or did not) post a follow-up for one comment. */
export type SweepActionReason =
    | "posted"
    | "no-downvote"
    | "already-followed-up";

/** The decision the sweep made for a single comment. */
export type SweepAction = {
    grain: FeedbackGrain;
    commentId: number;
    /** Number of 👎 currently on the comment (0 when none). */
    downvotes: number;
    /** Whether a follow-up was posted this sweep. */
    posted: boolean;
    reason: SweepActionReason;
};

/** Aggregate outcome of one sweep. */
export type SweepResult = {
    actions: SweepAction[];
    /** Count of follow-ups posted this sweep (invariant: <= new-downvote count). */
    followupsPosted: number;
};

/**
 * Hidden HTML marker that stamps a follow-up so later sweeps recognise it and do
 * not re-ping. It encodes the grain + comment id it answers. Same mechanism as
 * #194's HTML comment markers — invisible in the rendered thread, machine
 * readable on the next poll.
 */
const MARKER_PREFIX = "review-thumbs-followup";

const MARKER_RE = new RegExp(
    `<!--\\s*${MARKER_PREFIX}\\s+grain=(${FEEDBACK_GRAINS.join(
        "|",
    )})\\s+comment-id=(\\d+)\\s*-->`,
    "g",
);

/** Build the hidden idempotency marker for a (grain, commentId) pair. */
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
 * Render the follow-up body: the hidden marker followed by the fixed prompt.
 * Pure and constant given (grain, commentId) — no model, no per-run wording.
 */
export const renderFollowupBody = (
    grain: FeedbackGrain,
    commentId: number,
): string => {
    const reasons = DOWNVOTE_REASONS.map((r) => `\`${r}\``).join(" · ");
    return [
        buildFollowupMarker(grain, commentId),
        "Thanks for the 👎 — a quick note on **why** helps tune the reviewer.",
        "",
        `Reply with one of: ${reasons} — plus any free-text detail.`,
        "You only need to answer once; this bot won't ask again on this comment.",
    ].join("\n");
};

/** Stable idempotency key for a comment across both id spaces. */
const key = (grain: FeedbackGrain, commentId: number): string =>
    `${grain}:${commentId}`;

/** Count the 👎 reactions on a comment. */
const countDownvotes = (comment: BotComment): number =>
    comment.reactions.filter((r) => r.content === THUMBS_DOWN).length;

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
 * Run one thumbs sweep.
 *
 * For each grain, for each bot comment:
 *   1. count its 👎;
 *   2. if none, record `no-downvote` and move on;
 *   3. if it already has a follow-up (marker seen in `listExistingFollowups`, or
 *      posted earlier in THIS sweep), record `already-followed-up` — never
 *      re-ping;
 *   4. otherwise post exactly one follow-up and record `posted`.
 *
 * The result is fully determined by the port's responses, so the whole thing is
 * unit-testable with an in-memory fake. Idempotency holds both across sweeps (via
 * the durable markers) and within a sweep (via the in-memory `followedUp` set).
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

    // Seed the "already handled" set from durable markers on prior follow-ups.
    const followedUp = new Set<string>();
    for (const body of await port.listExistingFollowups()) {
        for (const ref of parseFollowupMarkers(body)) {
            followedUp.add(key(ref.grain, ref.commentId));
        }
    }

    const actions: SweepAction[] = [];

    for (const grain of FEEDBACK_GRAINS) {
        const comments = await port.listBotComments(grain);
        for (const comment of comments) {
            const downvotes = countDownvotes(comment);

            if (downvotes === 0) {
                actions.push({
                    grain,
                    commentId: comment.id,
                    downvotes,
                    posted: false,
                    reason: "no-downvote",
                });
                continue;
            }

            const k = key(grain, comment.id);
            if (followedUp.has(k)) {
                actions.push({
                    grain,
                    commentId: comment.id,
                    downvotes,
                    posted: false,
                    reason: "already-followed-up",
                });
                continue;
            }

            await port.postFollowup({
                grain,
                commentId: comment.id,
                body: renderFollowupBody(grain, comment.id),
            });
            // Guard against a duplicate comment id within this same sweep.
            followedUp.add(k);
            actions.push({
                grain,
                commentId: comment.id,
                downvotes,
                posted: true,
                reason: "posted",
            });
        }
    }

    return {
        actions,
        followupsPosted: actions.filter((a) => a.posted).length,
    };
};
