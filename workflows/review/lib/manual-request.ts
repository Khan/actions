/**
 * The manual `/review` ask: distinguishing a human's comment-triggered
 * review request from the automation that posts the same command.
 *
 * Consumers that keep a `/review` comment trigger declare it as
 * `issue_comment`, and a reduced `re-review` mode would otherwise answer an
 * explicit ask with a cheaper round (under `fast`, reconcile-only and
 * nothing reviewed). But the trigger event alone cannot carry the decision:
 * on Khan/webapp the reviewer's ONLY trigger is `issue_comment`, because a
 * shim (review-kore-prs.yml) posts `/review` on every push, so treating
 * every comment-triggered run as manual would make the configured mode dead
 * config on exactly the consumer the modes are for. The comment author and
 * body are the signals that remain: a human's bare `/review` forces full,
 * automation's follows the mode dial like the push it stands in for.
 *
 * A human may also name the depth: `/review scoped` (or `/review delta`,
 * `/review diff`, `/review diff-only`) asks for one scoped round over the
 * hunks no full review has seen, whatever the dial says
 * ({@link requestedDepthFromComment}). The token is advisory to the planner,
 * which honors it only at or above the configured dial (a comment may buy
 * more review than the repo configured, never less) and still applies every
 * guard (no anchor fingerprint, ready-for-review anchor, overflow, tripwire),
 * falling back to full when one trips.
 */

import {RE_REVIEW_MODES} from "./routing-config";
import type {ReReviewMode} from "./routing-config";

/** The automation logins assumed when `REVIEW_AUTOMATION_LOGINS` is unset. */
export const DEFAULT_AUTOMATION_LOGINS = "khan-actions-bot";

/**
 * `/review` comment authors whose ask is automation, never a human.
 * `comment.user.type === "Bot"` covers GitHub Apps (github-actions[bot]),
 * but khan-actions-bot is a classic-PAT machine account whose type is
 * `User` (it posts the webapp shim's `/review` because a GITHUB_TOKEN
 * comment triggers no workflows), so it must be named by login. Deployment
 * config rather than a compiled-in constant, same as `threads.ts`'s
 * `REVIEW_BOT_LOGIN`: which account fronts a consumer's automation is a
 * property of that installation, and a comma-separated
 * `REVIEW_AUTOMATION_LOGINS` env lets a consumer whose shim posts under a
 * different account fix it in config instead of waiting on a release. The
 * comparison is case-folded ({@link isManualReviewRequest}); logins are
 * case-insensitive on GitHub.
 */
export const automationCommentAuthors = (): ReadonlySet<string> =>
    new Set(
        // `||`, not `??`: an empty or whitespace-only value restores the
        // default instead of emptying the carve-out, same as
        // threads.ts's REVIEW_BOT_LOGIN and autofix's AUTOFIX_BOT_LOGIN.
        (
            process.env.REVIEW_AUTOMATION_LOGINS?.trim() ||
            DEFAULT_AUTOMATION_LOGINS
        )
            .split(",")
            .map((login) => login.trim().toLowerCase())
            .filter((login) => login !== ""),
    );

/** The triggering comment's author, from the runner's event payload. */
export type CommentAuthor = {login?: string; type?: string};

/**
 * Whether this run is an explicit human ask for a review: an
 * `issue_comment`-triggered run whose comment author is neither a Bot-type
 * account nor a named machine account ({@link automationCommentAuthors}).
 * An unreadable event payload on a comment trigger counts as manual: the
 * failure direction is more review, never a silently cheaper round.
 */
export const isManualReviewRequest = (
    eventName: string | undefined,
    author: CommentAuthor | undefined,
): boolean => {
    if (eventName !== "issue_comment") {
        return false;
    }
    if (author === undefined) {
        return true;
    }
    if (author.type === "Bot") {
        return false;
    }
    return !automationCommentAuthors().has((author.login ?? "").toLowerCase());
};

/**
 * Synonyms a human may type in place of a mode name. `delta`, `diff`, and
 * `diff-only` all read as "just the new stuff", which is what `scoped`
 * stages.
 */
export const DEPTH_SYNONYMS: Readonly<Record<string, ReReviewMode>> = {
    delta: "scoped",
    diff: "scoped",
    "diff-only": "scoped",
};

/**
 * The depth a `/review` comment asks for: the first whitespace-separated
 * token after `/review` on the comment's first line, case-folded, resolved
 * through {@link DEPTH_SYNONYMS} and validated against the mode list.
 * Returns null for a bare `/review`, for a token that names no mode (the
 * ask still counts as manual, so the planner's default of full applies:
 * a typo never buys a cheaper round), and for a body that is not a
 * `/review` command at all.
 */
export const requestedDepthFromComment = (
    body: string | undefined,
): ReReviewMode | null => {
    if (body === undefined) {
        return null;
    }
    const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
    const match = /^\s*\/review[ \t]+(\S+)/.exec(firstLine);
    if (match === null) {
        return null;
    }
    const token = match[1].toLowerCase();
    const resolved = DEPTH_SYNONYMS[token] ?? token;
    return (RE_REVIEW_MODES as readonly string[]).includes(resolved)
        ? (resolved as ReReviewMode)
        : null;
};

/** The slice of `fs` the event-payload read needs (injectable for tests). */
export type EventFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
};

/** The triggering comment as the planner reads it from the event payload. */
export type TriggeringComment = {author?: CommentAuthor; body?: string};

/**
 * Read the triggering comment (author and body) from the runner's event
 * payload. Undefined when the payload is missing or unparseable; each field
 * is undefined when the payload does not carry it.
 */
export const commentFromEvent = (
    fs: EventFs,
    eventPath: string | undefined,
): TriggeringComment | undefined => {
    if (eventPath === undefined || !fs.existsSync(eventPath)) {
        return undefined;
    }
    let event: unknown;
    try {
        event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    } catch {
        return undefined;
    }
    const comment = (event as {comment?: unknown})?.comment;
    if (
        comment === undefined ||
        comment === null ||
        typeof comment !== "object"
    ) {
        return {};
    }
    const {body, user} = comment as {body?: unknown; user?: unknown};
    const author =
        user === undefined || user === null || typeof user !== "object"
            ? undefined
            : {
                  ...(typeof (user as {login?: unknown}).login === "string"
                      ? {login: (user as {login: string}).login}
                      : {}),
                  ...(typeof (user as {type?: unknown}).type === "string"
                      ? {type: (user as {type: string}).type}
                      : {}),
              };
    return {
        ...(typeof body === "string" ? {body} : {}),
        ...(author !== undefined ? {author} : {}),
    };
};
