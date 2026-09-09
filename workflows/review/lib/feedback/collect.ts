/**
 * Deterministic collection for the weekly feedback report: one repo, one
 * window, one `events.jsonl` (see `./types.ts`) plus a collection-meta record.
 *
 * This is the whole no-LLM half of KORE-2455. The 08-18 manual sweep of webapp
 * (encoded as the `review-feedback-audit` skill) found 10 human reactions and
 * 45 human replies on bot threads and took a day of `gh api | jq` to surface;
 * this module is that sweep with each of its sharp edges written down once,
 * next to a test:
 *
 *   - **`since=` filters on `updated_at`, not `created_at`.** Every list
 *     endpoint here is re-filtered on the record's own creation time, or an
 *     old comment edited inside the window pollutes the sample.
 *   - **Reactions do not bump `updated_at`.** They are invisible to a `since=`
 *     sweep entirely, so they are enumerated per comment (only when the
 *     listing's `reactions.total_count > 0`, which keeps the fan-out bounded)
 *     and filtered by the REACTION's own `created_at`.
 *   - **Reactors must be filtered to humans.** `claude[bot]` seeds a 👍/👎
 *     pair on every comment as vote buttons (PRA-2), so a raw reaction tally
 *     measures the widget, not the feedback. Any `[bot]` login is dropped, not
 *     just this install's review bot.
 *   - **A reply's `in_reply_to_id` is the thread ROOT**, never the comment it
 *     answers. Parents outside the window's bot-comment set are resolved with
 *     direct fetches and kept only when bot-authored, or the tally silently
 *     includes replies in human-opened threads.
 *   - **Search caps at 1,000 results silently.** The PR enumeration compares
 *     `total_count` against the cap and records a truncation warning in the
 *     meta, because every per-PR count is a lower bound once it trips.
 *   - **Runs are counted by the `review-v<version>` footer**, not by review
 *     events: autofix's thread replies arrive as implicit empty `COMMENTED`
 *     reviews, so an event count overstates runs.
 *   - **Bot identity is per install.** It comes from `threads.ts`
 *     ({@link reviewBotLogin} / {@link isReviewBotAuthor}), the module that
 *     already owns "is this login our review bot" across the reviewer and
 *     autofix — re-deriving it here is exactly the disagreement Khan/actions#302
 *     cost a release.
 *
 * Structure follows `counters.ts`: a pure core ({@link collectFeedback} and
 * the parsers below) that takes injected fetchers and is fully deterministic —
 * no clock, no filesystem, no randomness, no network — and a thin CLI shell at
 * the bottom that wires those fetchers to `fetch` against the GitHub API with
 * `GITHUB_TOKEN`. Consumer repos run:
 *
 *     npx -y tsx gh-aw-review-lib/workflows/review/lib/feedback/collect.ts <out-dir>
 *
 * Determinism boundary: GitHub reads plus pure shape mapping. This module
 * authors no prose; every string it emits is an id, a login, a label token, a
 * timestamp, or a body copied verbatim from the API.
 */

import {
    collectReviewThreads,
    isBotLogin,
    isReviewBotAuthor,
    reviewBotLogin,
    sameLogin,
    type GhGraphql,
} from "../threads";
import {
    toJsonl,
    type BotInlineCommentEvent,
    type CollectionResult,
    type FeedbackEvent,
    type GuidanceCommentEvent,
    type HumanReplyEvent,
    type LabelEvent,
    type ReactionEvent,
    type ReactionSubject,
    type ReviewVerdictEvent,
    type ThreadStateEvent,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Injected I/O                                                               */
/* -------------------------------------------------------------------------- */

/** One authenticated REST GET of a single resource, parsed. */
export type GhRest = (path: string) => Promise<unknown>;

/**
 * One authenticated REST GET of a LIST resource, every page concatenated. The
 * shell owns `per_page`/`page`, so paths here carry only semantic query
 * parameters.
 */
export type GhRestPaged = (path: string) => Promise<unknown[]>;

/** Everything collection reads. Injected so tests never touch the network. */
export type FeedbackPort = {
    rest: GhRest;
    restPaged: GhRestPaged;
    graphql: GhGraphql;
};

/** What to collect. All times ISO-8601; the window is `[start, end)`. */
export type CollectOptions = {
    /** `owner/name`. */
    repo: string;
    windowStart: string;
    windowEnd: string;
    /**
     * Collection timestamp for the meta record. Passed in rather than read
     * from `Date.now()` so the core has no clock and its tests are exact.
     */
    collectedAt: string;
    /** Overrides `REVIEW_BOT_LOGIN` / the `threads.ts` default. */
    botLogin?: string;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The marker that identifies the reviewer's PR-level guidance comment. The
 * gh-aw engine appends it; the safe-output sanitizer (`removeXmlComments`)
 * deletes every agent-written HTML comment, so a marker the reviewer emits
 * itself would not survive posting and cannot be used here.
 */
export const GUIDANCE_MARKER = "gh-aw-agentic-workflow";

/** The opt-out label whose application is a (loud) feedback signal. */
export const SKIP_LABEL = "skip-ai-review";

/**
 * GitHub's hard cap on `search/issues` results, applied SILENTLY: past this
 * many matches, pagination just stops. Compared against `total_count` so the
 * report can say its numbers are a lower bound.
 */
export const SEARCH_RESULT_CAP = 1000;

/**
 * Conventional-Comments label vocabulary, as `render-comment.ts` emits it.
 * A closed set, deliberately: a bare `^([a-z]+):` match would read the first
 * word of any prose as a label, and a mislabeled corpus is worse than an
 * unlabeled one.
 */
const LABEL_WORDS = new Set([
    "praise",
    "nitpick",
    "suggestion",
    "issue",
    "todo",
    "question",
    "thought",
    "chore",
    "note",
    "typo",
    "polish",
]);

/* -------------------------------------------------------------------------- */
/* Pure parsers                                                               */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string =>
    typeof value === "string" ? value : "";

const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

const loginOf = (value: unknown): string =>
    isRecord(value) && isRecord(value["user"])
        ? str(value["user"]["login"])
        : "";

/**
 * Whether an ISO-8601 timestamp falls in `[start, end)`.
 *
 * String comparison, not `Date` arithmetic: GitHub emits `Z`-suffixed,
 * fixed-width, zero-padded UTC timestamps, for which lexicographic order IS
 * chronological order, and parsing introduces a timezone question that has no
 * business in a filter. A malformed or empty stamp is out of the window: an
 * unplaceable event must not be counted in one.
 */
export const inWindow = (
    at: string,
    windowStart: string,
    windowEnd: string,
): boolean => at !== "" && at >= windowStart && at < windowEnd;

/**
 * The Conventional-Comments label prefix of a bot body, lowercased and
 * space-normalized (`issue (blocking, correctness)`), or `""` when the body
 * carries none.
 *
 * Tolerates the markdown-stripped form the staged bodies sometimes carry, the
 * same allowance `dedup-threads.ts`'s `threadOpenerIsBlocking` makes. An
 * unrecognized leading word yields `""` rather than a guess, so "unlabeled" is
 * a reportable anomaly instead of a silently invented bucket.
 */
export const parseCommentLabel = (body: string): string => {
    const match = /^\s*\*{0,2}([a-z]+)(\s*\([^)]*\))?\*{0,2}\s*:/i.exec(body);
    const word = match?.[1]?.toLowerCase();
    if (word === undefined || !LABEL_WORDS.has(word)) {
        return "";
    }
    const qualifiers = (match?.[2] ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ", ")
        .trim();
    return qualifiers === "" ? word : `${word} ${qualifiers}`;
};

/**
 * The reviewer version stamped in a review body's collapsed footer
 * (`review-v1.25.1`), or null when the body carries none.
 *
 * This is the run counter. A review WITHOUT the footer is not a reviewer run:
 * autofix's thread replies (and, in pre-retirement windows, sweep follow-ups)
 * post as implicit empty `COMMENTED` reviews, so counting review events
 * overstates runs — the mistake the 08-18 sweep documents.
 */
export const parseReviewVersion = (body: string): string | null =>
    /\breview-v([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*)/.exec(body)?.[1] ?? null;

/** The PR/issue number trailing an API url (`.../pulls/1234`). */
export const numberFromApiUrl = (url: string): number => {
    const tail = /\/(\d+)(?:$|[?#])/.exec(url)?.[1];
    return tail === undefined ? 0 : Number(tail);
};

/**
 * Whether a reaction is a human's.
 *
 * Excludes EVERY `[bot]` login, not merely this install's review bot: on the
 * installs that post as `claude[bot]`, the engine seeds a 👍 and a 👎 on each
 * comment as vote buttons (PRA-2), and any other App's reaction is equally not
 * a reviewer's judgment. An unattributable reactor (deleted account, empty
 * login) is excluded too, matching `threads.ts`'s rule that an empty identity
 * never reads as human feedback.
 */
export const isHumanReactor = (login: string): boolean =>
    login !== "" && !isBotLogin(login) && !isReviewBotAuthor(login);

/* -------------------------------------------------------------------------- */
/* Collection                                                                 */
/* -------------------------------------------------------------------------- */

/** A `since=` query fragment; the value is url-encoded for the API. */
const sinceParam = (windowStart: string): string =>
    `since=${encodeURIComponent(windowStart)}`;

/**
 * Every PR touched in the window, plus a truncation warning when GitHub's
 * search cap hides some.
 *
 * Search is the only repo-wide way to find the PRs to fetch reviews, threads
 * and label events for: there is no repo-wide `since` endpoint for reviews.
 * `updated:>=` (not `created:`) is deliberate — the interesting PRs are older
 * ones that received feedback this week.
 */
const searchWindowPrs = async (
    port: FeedbackPort,
    repo: string,
    windowStart: string,
    warnings: string[],
): Promise<number[]> => {
    const query = encodeURIComponent(
        `repo:${repo} is:pr updated:>=${windowStart}`,
    );
    const numbers = new Set<number>();
    let total: number | null = null;

    // 10 pages x 100 = the 1,000-result cap; a further page cannot return
    // anything, so the loop bound and the cap are the same fact.
    for (let page = 1; page <= SEARCH_RESULT_CAP / 100; page++) {
        const body = await port.rest(
            `/search/issues?q=${query}&per_page=100&page=${page}`,
        );
        if (!isRecord(body)) {
            break;
        }
        if (total === null && typeof body["total_count"] === "number") {
            total = body["total_count"];
        }
        const items = Array.isArray(body["items"]) ? body["items"] : [];
        for (const item of items) {
            if (isRecord(item) && typeof item["number"] === "number") {
                numbers.add(item["number"]);
            }
        }
        if (items.length < 100) {
            break;
        }
    }

    if (total !== null && total > SEARCH_RESULT_CAP) {
        warnings.push(
            `search/issues matched ${total} PRs but caps at ` +
                `${SEARCH_RESULT_CAP}: every per-PR count below is a LOWER ` +
                `BOUND; split the window into sub-ranges for exact numbers`,
        );
    }
    return [...numbers].sort((a, b) => a - b);
};

/**
 * Reactions on one comment, filtered to humans and to the window by the
 * reaction's OWN `created_at`.
 *
 * A per-comment fetch failure (a deleted comment answers 404) degrades this
 * comment's reactions to none and records a warning, rather than failing the
 * whole report: the window's other signals are still worth having.
 */
const reactionsFor = async (
    port: FeedbackPort,
    repo: string,
    subject: ReactionSubject,
    commentId: number,
    pr: number,
    options: CollectOptions,
    warnings: string[],
): Promise<ReactionEvent[]> => {
    const endpoint =
        subject === "inline"
            ? `/repos/${repo}/pulls/comments/${commentId}/reactions`
            : `/repos/${repo}/issues/comments/${commentId}/reactions`;
    let raw: unknown[];
    try {
        raw = await port.restPaged(endpoint);
    } catch (error) {
        warnings.push(
            `reactions for ${subject} comment ${commentId} were unreadable ` +
                `(${String(
                    error,
                )}); its reactions are missing from this report`,
        );
        return [];
    }
    return raw
        .filter(isRecord)
        .filter((reaction) => isHumanReactor(loginOf(reaction)))
        .filter((reaction) =>
            inWindow(
                str(reaction["created_at"]),
                options.windowStart,
                options.windowEnd,
            ),
        )
        .map((reaction) => ({
            kind: "reaction" as const,
            commentId,
            subject,
            pr,
            reactor: loginOf(reaction),
            content: str(reaction["content"]),
            created_at: str(reaction["created_at"]),
        }));
};

/**
 * Collect one repo's feedback signals over one window.
 *
 * Deterministic given its fetchers: same responses in, byte-identical
 * `events.jsonl` out (every group is sorted by a stable key before it is
 * appended). Fetch failures on repo-wide LIST endpoints throw — a missing
 * comment list is not an empty week — while per-item failures degrade to a
 * meta warning, because one deleted comment must not cost the report.
 */
export const collectFeedback = async (
    port: FeedbackPort,
    options: CollectOptions,
): Promise<CollectionResult> => {
    const {repo, windowStart, windowEnd} = options;
    const botLogin = options.botLogin ?? reviewBotLogin();
    // Suffix-stripped, via `threads.ts`'s comparison: REST spells an App
    // `github-actions[bot]` and GraphQL spells the same actor bare, and this
    // module reads both surfaces. An empty login is never the bot.
    const isBot = (login: string): boolean =>
        login !== "" && sameLogin(login, botLogin);
    const warnings: string[] = [];
    const events: FeedbackEvent[] = [];

    /* --- Inline review comments: the bot's findings and everyone's replies. */
    const inlineRaw = (
        await port.restPaged(
            `/repos/${repo}/pulls/comments?${sinceParam(windowStart)}`,
        )
    ).filter(isRecord);
    // `since=` filtered on `updated_at`; re-filter on `created_at`, or an old
    // comment edited this week counts as this week's output.
    const inlineInWindow = inlineRaw.filter((comment) =>
        inWindow(str(comment["created_at"]), windowStart, windowEnd),
    );

    const botInline: BotInlineCommentEvent[] = inlineInWindow
        .filter(
            (comment) =>
                isBot(loginOf(comment)) &&
                typeof comment["in_reply_to_id"] !== "number",
        )
        .map((comment) => {
            const body = str(comment["body"]);
            return {
                kind: "bot_inline_comment" as const,
                id: num(comment["id"]),
                pr: numberFromApiUrl(str(comment["pull_request_url"])),
                path: str(comment["path"]),
                line:
                    typeof comment["line"] === "number"
                        ? comment["line"]
                        : null,
                created_at: str(comment["created_at"]),
                url: str(comment["html_url"]),
                label: parseCommentLabel(body),
                bodyLength: body.length,
                body,
            };
        })
        .sort((a, b) => a.id - b.id);
    events.push(...botInline);

    /* --- Guidance comments (PR-level), by the engine-appended marker. */
    const issueRaw = (
        await port.restPaged(
            `/repos/${repo}/issues/comments?${sinceParam(windowStart)}`,
        )
    ).filter(isRecord);
    const guidance: GuidanceCommentEvent[] = issueRaw
        .filter(
            (comment) =>
                isBot(loginOf(comment)) &&
                str(comment["body"]).includes(GUIDANCE_MARKER) &&
                inWindow(str(comment["created_at"]), windowStart, windowEnd),
        )
        .map((comment) => ({
            kind: "guidance_comment" as const,
            id: num(comment["id"]),
            pr: numberFromApiUrl(str(comment["issue_url"])),
            created_at: str(comment["created_at"]),
            url: str(comment["html_url"]),
            bodyLength: str(comment["body"]).length,
        }))
        .sort((a, b) => a.id - b.id);
    events.push(...guidance);

    /* --- Reactions: enumerated per comment, never swept.
     *
     * Targets come from the RAW `since=` sweep, not the created-in-window
     * subset: a reaction never bumps `updated_at`, but an edit does, so an
     * older bot comment that resurfaced in the sweep can carry this week's
     * reactions, and the reaction's own `created_at` filter (inside
     * `reactionsFor`) keeps out-of-window ones from counting either way. A
     * reaction on an old, untouched comment stays invisible to REST — the
     * adjudicating 👎 on an opener is covered regardless, via the GraphQL
     * thread state's `openerDownvotes`. */
    const reactionTargets: {
        subject: ReactionSubject;
        id: number;
        pr: number;
    }[] = [];
    const countedTotal = (comment: Record<string, unknown>): number =>
        isRecord(comment["reactions"])
            ? num(comment["reactions"]["total_count"])
            : 0;
    for (const comment of inlineRaw) {
        const id = num(comment["id"]);
        if (
            isBot(loginOf(comment)) &&
            typeof comment["in_reply_to_id"] !== "number" &&
            countedTotal(comment) > 0
        ) {
            reactionTargets.push({
                subject: "inline",
                id,
                pr: numberFromApiUrl(str(comment["pull_request_url"])),
            });
        }
    }
    for (const comment of issueRaw) {
        if (
            isBot(loginOf(comment)) &&
            str(comment["body"]).includes(GUIDANCE_MARKER) &&
            countedTotal(comment) > 0
        ) {
            reactionTargets.push({
                subject: "issue",
                id: num(comment["id"]),
                pr: numberFromApiUrl(str(comment["issue_url"])),
            });
        }
    }
    const reactions: ReactionEvent[] = [];
    for (const target of reactionTargets) {
        reactions.push(
            ...(await reactionsFor(
                port,
                repo,
                target.subject,
                target.id,
                target.pr,
                options,
                warnings,
            )),
        );
    }
    events.push(
        ...reactions.sort(
            (a, b) =>
                a.commentId - b.commentId ||
                a.reactor.localeCompare(b.reactor) ||
                a.content.localeCompare(b.content),
        ),
    );

    /* --- Human replies, joined to BOT thread roots. */
    const botInlineIds = new Set(botInline.map((comment) => comment.id));
    const replyCandidates = inlineInWindow.filter(
        (comment) =>
            !isBot(loginOf(comment)) &&
            typeof comment["in_reply_to_id"] === "number",
    );
    // A reply's parent is the thread ROOT. Roots outside this window's
    // bot-comment set are older comments, which may be the bot's (a reply to
    // last week's finding, the most interesting kind) or a human's (a reply in
    // a human-opened thread, which is not our feedback at all): only a direct
    // fetch can tell, and each unknown root is fetched exactly once.
    const unknownParents = [
        ...new Set(
            replyCandidates
                .map((comment) => num(comment["in_reply_to_id"]))
                .filter((id) => id !== 0 && !botInlineIds.has(id)),
        ),
    ].sort((a, b) => a - b);
    const botParentIds = new Set(botInlineIds);
    for (const parentId of unknownParents) {
        let parent: unknown;
        try {
            parent = await port.rest(
                `/repos/${repo}/pulls/comments/${parentId}`,
            );
        } catch (error) {
            warnings.push(
                `thread root ${parentId} was unreadable (${String(error)}); ` +
                    `replies under it are missing from this report`,
            );
            continue;
        }
        if (isRecord(parent) && isBot(loginOf(parent))) {
            botParentIds.add(parentId);
        }
    }
    const replies: HumanReplyEvent[] = replyCandidates
        .filter((comment) => botParentIds.has(num(comment["in_reply_to_id"])))
        .map((comment) => {
            const body = str(comment["body"]);
            return {
                kind: "human_reply" as const,
                id: num(comment["id"]),
                pr: numberFromApiUrl(str(comment["pull_request_url"])),
                parentId: num(comment["in_reply_to_id"]),
                author: loginOf(comment),
                created_at: str(comment["created_at"]),
                url: str(comment["html_url"]),
                bodyLength: body.length,
                body,
            };
        })
        .sort((a, b) => a.id - b.id);
    events.push(...replies);

    /* --- Per-PR: reviews, thread state, label events. */
    const [owner, name] = repo.split("/");
    if (owner === undefined || name === undefined || name === "") {
        throw new Error(
            `repo must be "owner/name", got ${JSON.stringify(repo)}`,
        );
    }
    const prNumbers = await searchWindowPrs(port, repo, windowStart, warnings);

    const verdicts: ReviewVerdictEvent[] = [];
    const threadStates: ThreadStateEvent[] = [];
    const labelEvents: LabelEvent[] = [];
    for (const pr of prNumbers) {
        try {
            const reviews = (
                await port.restPaged(`/repos/${repo}/pulls/${pr}/reviews`)
            ).filter(isRecord);
            for (const review of reviews) {
                if (
                    !isBot(loginOf(review)) ||
                    !inWindow(
                        str(review["submitted_at"]),
                        windowStart,
                        windowEnd,
                    )
                ) {
                    continue;
                }
                const body = str(review["body"]);
                verdicts.push({
                    kind: "review_verdict",
                    id: num(review["id"]),
                    pr,
                    state: str(review["state"]),
                    submitted_at: str(review["submitted_at"]),
                    reviewVersion: parseReviewVersion(body),
                    bodyLength: body.length,
                });
            }
        } catch (error) {
            warnings.push(
                `reviews for PR ${pr} were unreadable (${String(error)}); ` +
                    `its runs and verdicts are missing from this report`,
            );
        }

        try {
            const threads = await collectReviewThreads(
                port.graphql,
                owner,
                name,
                pr,
            );
            for (const thread of threads) {
                const opener = thread.comments[0];
                threadStates.push({
                    kind: "thread_state",
                    thread_id: thread.thread_id,
                    pr,
                    path: thread.path,
                    line: thread.line,
                    url: thread.url ?? "",
                    botOpened: opener !== undefined && isBot(opener.author),
                    resolved: thread.resolved,
                    resolvedBy: thread.resolvedBy,
                    openerDownvotes: thread.openerDownvotes,
                    commentCount: thread.comments.length,
                });
            }
        } catch (error) {
            warnings.push(
                `review threads for PR ${pr} were unreadable ` +
                    `(${String(error)}); its resolution state is missing ` +
                    `from this report`,
            );
        }

        try {
            const timeline = (
                await port.restPaged(`/repos/${repo}/issues/${pr}/events`)
            ).filter(isRecord);
            for (const event of timeline) {
                const action = str(event["event"]);
                const label = isRecord(event["label"])
                    ? str(event["label"]["name"])
                    : "";
                if (
                    (action !== "labeled" && action !== "unlabeled") ||
                    label !== SKIP_LABEL ||
                    !inWindow(str(event["created_at"]), windowStart, windowEnd)
                ) {
                    continue;
                }
                labelEvents.push({
                    kind: "label_event",
                    pr,
                    label,
                    action,
                    actor: isRecord(event["actor"])
                        ? str(event["actor"]["login"])
                        : "",
                    created_at: str(event["created_at"]),
                });
            }
        } catch (error) {
            warnings.push(
                `issue events for PR ${pr} were unreadable ` +
                    `(${String(error)}); its ${SKIP_LABEL} activity is ` +
                    `missing from this report`,
            );
        }
    }
    events.push(...verdicts.sort((a, b) => a.pr - b.pr || a.id - b.id));
    events.push(
        ...threadStates.sort(
            (a, b) => a.pr - b.pr || a.thread_id.localeCompare(b.thread_id),
        ),
    );
    events.push(
        ...labelEvents.sort(
            (a, b) =>
                a.pr - b.pr ||
                a.created_at.localeCompare(b.created_at) ||
                a.action.localeCompare(b.action),
        ),
    );

    return {
        meta: {
            repo,
            windowStart,
            windowEnd,
            botLogin,
            collected_at: options.collectedAt,
            truncationWarnings: warnings,
            prNumbers,
        },
        events,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI shell                                                                  */
/* -------------------------------------------------------------------------- */

/** Window length when `FEEDBACK_WINDOW_DAYS` is unset: the weekly report. */
export const DEFAULT_WINDOW_DAYS = 7;

/** `end` minus `days`, as an ISO-8601 `Z` stamp. Pure; exported for tests. */
export const windowStartFor = (end: string, days: number): string =>
    new Date(Date.parse(end) - days * 24 * 60 * 60 * 1000).toISOString();

// Run only when invoked directly (the consumer's scheduled workflow), never on
// import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const {writeFileSync, mkdirSync} = require("node:fs");
    const {join} = require("node:path");

    const env = (name: string): string => {
        const value = process.env[name];
        if (value === undefined || value.trim() === "") {
            throw new Error(`${name} must be set`);
        }
        return value.trim();
    };

    const outDir = process.argv[2] ?? ".";
    const repo = process.env.FEEDBACK_REPO?.trim() || env("GITHUB_REPOSITORY");
    const token = env("GITHUB_TOKEN");
    const api = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
    const days = Number(
        process.env.FEEDBACK_WINDOW_DAYS?.trim() || DEFAULT_WINDOW_DAYS,
    );
    const windowEnd =
        process.env.FEEDBACK_WINDOW_END?.trim() || new Date().toISOString();
    const windowStart =
        process.env.FEEDBACK_WINDOW_START?.trim() ||
        windowStartFor(windowEnd, days);

    const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "khan-review-feedback-report",
    };
    const get = async (path: string): Promise<unknown> => {
        const res = await fetch(`${api}${path}`, {headers});
        if (!res.ok) {
            throw new Error(`GET ${path} failed: ${res.status}`);
        }
        return res.json();
    };

    const port: FeedbackPort = {
        rest: get,
        restPaged: async (path) => {
            const out: unknown[] = [];
            // 100 is the API maximum. The page cap bounds a pathological
            // window rather than silently truncating a normal one; the core
            // has no way to see the cap trip, so the shell says so itself.
            const maxPages = 30;
            let page = 1;
            for (; page <= maxPages; page++) {
                const sep = path.includes("?") ? "&" : "?";
                const batch = await get(
                    `${path}${sep}per_page=100&page=${page}`,
                );
                if (!Array.isArray(batch) || batch.length === 0) {
                    break;
                }
                out.push(...batch);
                if (batch.length < 100) {
                    break;
                }
            }
            if (page > maxPages) {
                process.stderr.write(
                    `WARNING: ${path} returned ${maxPages} full pages; ` +
                        `later items are missing from this report\n`,
                );
            }
            return out;
        },
        graphql: async (query, variables) => {
            const res = await fetch(`${api}/graphql`, {
                method: "POST",
                headers: {...headers, "content-type": "application/json"},
                body: JSON.stringify({query, variables}),
            });
            if (!res.ok) {
                throw new Error(`GraphQL POST failed: ${res.status}`);
            }
            return res.json();
        },
    };

    collectFeedback(port, {
        repo,
        windowStart,
        windowEnd,
        collectedAt: new Date().toISOString(),
        ...(process.env.REVIEW_BOT_LOGIN?.trim()
            ? {botLogin: process.env.REVIEW_BOT_LOGIN.trim()}
            : {}),
    })
        .then((result) => {
            mkdirSync(outDir, {recursive: true});
            writeFileSync(join(outDir, "events.jsonl"), toJsonl(result.events));
            writeFileSync(
                join(outDir, "collection-meta.json"),
                `${JSON.stringify(result.meta, null, 2)}\n`,
            );
            for (const warning of result.meta.truncationWarnings) {
                process.stderr.write(`WARNING: ${warning}\n`);
            }
            process.stderr.write(
                `collected ${result.events.length} events for ` +
                    `${result.meta.repo} over ` +
                    `${result.meta.windowStart}..${result.meta.windowEnd}\n`,
            );
        })
        .catch((error: unknown) => {
            process.stderr.write(`${String(error)}\n`);
            process.exitCode = 1;
        });
}
