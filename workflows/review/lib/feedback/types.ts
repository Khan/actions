/**
 * The event vocabulary of the weekly feedback report's DETERMINISTIC half.
 *
 * One repo, one window, one flat stream of typed records (`events.jsonl`,
 * one JSON object per line) plus a single {@link CollectionMeta} record
 * describing the collection itself. Everything downstream — the LLM judgment
 * layer, the renderer, week-over-week trends — reads this stream and nothing
 * else, so the collection layer can be tested, replayed, and diffed without a
 * model or a network.
 *
 * Why a discriminated union in one file rather than a record type per fetch
 * site: the consumers are aggregators. A reader that wants "everything that
 * happened on comment 42" wants the reaction, the reply, and the thread state
 * side by side, and a per-endpoint shape would make that a join across four
 * file formats. The `kind` tag is the only dispatch a reader needs.
 *
 * Privacy: Khan/actions is public, the consumer repos are private, so the
 * report's DATA never leaves the consumer repo — only this code is public.
 * Bodies are carried (the judgment layer must read a reply to classify it),
 * but every record also carries a `bodyLength`, so the counters that only need
 * verbosity never have to touch the prose.
 */

/** Discriminator for every record in `events.jsonl`. */
export type FeedbackEventKind =
    | "bot_inline_comment"
    | "guidance_comment"
    | "thread_state"
    | "reaction"
    | "human_reply"
    | "label_event"
    | "review_verdict";

/** A review comment the bot authored: one posted finding. */
export type BotInlineCommentEvent = {
    kind: "bot_inline_comment";
    /** REST comment id; the join key for reactions and replies. */
    id: number;
    /** PR number the comment lives on. */
    pr: number;
    path: string;
    /** Anchor line, or null for an outdated/file-level comment. */
    line: number | null;
    /** ISO-8601. Always the comment's own `created_at`, never `updated_at`. */
    created_at: string;
    url: string;
    /**
     * The Conventional-Comments label prefix (`issue (blocking, correctness)`,
     * `nitpick`, …), lowercased and space-normalized, or `""` when the body
     * carries none. An unlabeled bot body is an anomaly worth reading, not a
     * bucket, so it is NOT defaulted to a label here.
     */
    label: string;
    /** `body.length`, so verbosity metrics need not load the prose. */
    bodyLength: number;
    /** Verbatim body. The judgment layer classifies against it. */
    body: string;
};

/**
 * The reviewer's PR-level guidance comment, identified by the engine-appended
 * `gh-aw-agentic-workflow` marker rather than any bot-authored marker: the
 * gh-aw safe-output sanitizer strips agent-written HTML comments, so a marker
 * the reviewer emits itself does not survive posting.
 */
export type GuidanceCommentEvent = {
    kind: "guidance_comment";
    id: number;
    pr: number;
    created_at: string;
    url: string;
    bodyLength: number;
};

/**
 * A review thread's resolution state, from GraphQL (REST carries neither
 * `isResolved` nor the resolver). A snapshot at collection time, not a
 * windowed event: GitHub exposes no resolution timestamp, so this records the
 * state of threads on PRs touched in the window and the report must read it
 * that way.
 */
export type ThreadStateEvent = {
    kind: "thread_state";
    /** GraphQL `PRRT_…` node id. */
    thread_id: string;
    pr: number;
    path: string;
    line: number | null;
    url: string;
    /** Whether the thread's OPENING comment is the review bot's. */
    botOpened: boolean;
    resolved: boolean;
    /** Suffix-stripped resolver login; `""` when unresolved/unattributable. */
    resolvedBy: string;
    /** 👎 from attributable non-bot reactors on the OPENER (adjudication). */
    openerDownvotes: number;
    /** Comments in the chain, opener included. */
    commentCount: number;
};

/** Which REST reaction endpoint a reaction was read from. */
export type ReactionSubject = "inline" | "issue";

/**
 * One HUMAN reaction on a bot comment, within the window by the REACTION's
 * own `created_at`. Reactions do not bump the comment's `updated_at`, so they
 * are enumerated per comment rather than swept by a `since=` list.
 */
export type ReactionEvent = {
    kind: "reaction";
    /** Id of the reacted-to comment. */
    commentId: number;
    subject: ReactionSubject;
    pr: number;
    /** Reactor login. Never a `[bot]` account — see collect.ts. */
    reactor: string;
    /** GitHub reaction content token (`+1`, `-1`, `eyes`, …). */
    content: string;
    created_at: string;
};

/** A human reply on a thread the bot opened. */
export type HumanReplyEvent = {
    kind: "human_reply";
    id: number;
    pr: number;
    /** `in_reply_to_id` — always the thread ROOT, not the answered comment. */
    parentId: number;
    author: string;
    created_at: string;
    url: string;
    bodyLength: number;
    body: string;
};

/** A `skip-ai-review` label applied or removed: an opt-out signal. */
export type LabelEvent = {
    kind: "label_event";
    pr: number;
    label: string;
    action: "labeled" | "unlabeled";
    /** Actor login; `""` when the event is unattributable. */
    actor: string;
    created_at: string;
};

/**
 * A review the bot submitted in the window.
 *
 * `reviewVersion` is the report's run counter: autofix's thread replies (and,
 * historically, sweep follow-ups) arrive as implicit empty `COMMENTED` review
 * events, so counting review events overstates runs. A review body carrying
 * the `review-v<version>` footer is a real reviewer run; one without is not.
 */
export type ReviewVerdictEvent = {
    kind: "review_verdict";
    id: number;
    pr: number;
    /** `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / … verbatim. */
    state: string;
    /** ISO-8601 `submitted_at` (reviews have no `created_at`). */
    submitted_at: string;
    /** `1.25.1` from a `review-v1.25.1` footer; null when the body has none. */
    reviewVersion: string | null;
    bodyLength: number;
};

/** Any record in `events.jsonl`. */
export type FeedbackEvent =
    | BotInlineCommentEvent
    | GuidanceCommentEvent
    | ThreadStateEvent
    | ReactionEvent
    | HumanReplyEvent
    | LabelEvent
    | ReviewVerdictEvent;

/**
 * The collection's own record: what was asked for, what answered, and what
 * could not be answered completely.
 *
 * `truncationWarnings` is the load-bearing field. GitHub's search API caps at
 * 1,000 results SILENTLY, so a busy repo's window yields a short PR list with
 * no error; every count derived from it is then a lower bound. A report that
 * cannot say so is worse than no report, so the warning travels with the data
 * rather than being logged and lost.
 */
export type CollectionMeta = {
    /** `owner/name`. */
    repo: string;
    /** Window start, ISO-8601, inclusive. */
    windowStart: string;
    /** Window end, ISO-8601, exclusive. */
    windowEnd: string;
    /** The login treated as the review bot for this collection. */
    botLogin: string;
    /** When collection ran, ISO-8601. Injected, never read from a clock here. */
    collected_at: string;
    /** Human-readable notes about incomplete data; empty when complete. */
    truncationWarnings: string[];
    /** PR numbers the window's per-PR fetches covered. */
    prNumbers: number[];
};

/** Everything one collection run produces. */
export type CollectionResult = {
    meta: CollectionMeta;
    events: FeedbackEvent[];
};

/** Serialize events as JSON Lines, trailing newline included. */
export const toJsonl = (events: readonly FeedbackEvent[]): string =>
    events.map((event) => JSON.stringify(event)).join("\n") +
    (events.length > 0 ? "\n" : "");
