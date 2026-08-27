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
 * config on exactly the consumer the modes are for. The comment author is
 * the signal that remains: a human's `/review` forces full, automation's
 * follows the mode dial like the push it stands in for.
 */

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

/** The slice of `fs` the event-payload read needs (injectable for tests). */
export type EventFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
};

/** Read the triggering comment's author from the runner's event payload. */
export const commentAuthorFromEvent = (
    fs: EventFs,
    eventPath: string | undefined,
): CommentAuthor | undefined => {
    if (eventPath === undefined || !fs.existsSync(eventPath)) {
        return undefined;
    }
    let event: unknown;
    try {
        event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    } catch {
        return undefined;
    }
    const user = (
        event as {comment?: {user?: {login?: unknown; type?: unknown}}}
    )?.comment?.user;
    if (user === undefined || user === null || typeof user !== "object") {
        return undefined;
    }
    return {
        ...(typeof user.login === "string" ? {login: user.login} : {}),
        ...(typeof user.type === "string" ? {type: user.type} : {}),
    };
};
