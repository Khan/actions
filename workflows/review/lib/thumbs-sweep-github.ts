/**
 * The octokit-backed {@link ThumbsSweepPort} — the production GitHub
 * implementation of the side-effect boundary `thumbs-sweep.ts` defines.
 *
 * Division of labour (unchanged from the sweep module): `thumbs-sweep.ts` owns
 * all control flow and idempotency; this module owns only the GitHub traversal —
 * which comments are the reviewer's, at which grain, with which reactions and
 * thread state — and the write call (`postFollowup`). It holds no sweep logic:
 * a bug here can mis-list or mis-post, but it cannot re-ping, because that rule
 * lives in the sweep core.
 *
 * How the reviewer's comments are identified (per grain):
 *
 *   - `summary` — issue comments authored by `botLogin` that carry one of the
 *     workflow's hidden markers: the risks/patterns marker
 *     (`pr-reviewer:risks-and-patterns`, the exact marker line `review.md`
 *     Step 7 requires the comment to begin with) or gh-aw's engine-emitted
 *     `gh-aw-workflow-call-id` marker for the repo's review install (what
 *     observed production comments actually carry). The marker, not the
 *     author, is what scopes the sweep to the reviewer:
 *     `github-actions[bot]` authors many other workflows' comments.
 *   - `inline` — pull-request review comments authored by `botLogin` whose body
 *     starts with one of the reviewer's code-owned Conventional-Comment labels
 *     (`**issue (blocking):** …`, `render-comment.ts`'s taxonomy). Inline
 *     comments carry no hidden marker at current releases, so the label grammar
 *     is the identifying signature; it is code-owned and templated, so the match
 *     is exact, not heuristic prose-sniffing.
 *
 * Comments containing a thumbs-followup marker are never candidates at either
 * grain — they are returned through `listExistingFollowups` instead, which is
 * what makes the sweep idempotent across restarts with no state store.
 *
 * API-call bounding: the traversal reads only pull requests updated within
 * `lookbackDays` (default 14), newest first, capped at `maxPulls`; closed or
 * merged PRs are skipped once closed for more than `closedGraceDays` (default
 * 3) — feedback lands around merge time, and a landed PR's reactions stop
 * changing shortly after. Reactions are fetched per comment only when the
 * comment's reaction summary shows any reactions at all. Resolved inline
 * threads are counted with one GraphQL query per PR that has reviewer inline
 * comments (thread resolution is not on the REST comment listing). Every
 * request is counted and reported via {@link GithubThumbsSweepPort.stats} so
 * each run's API budget is auditable.
 */

import type {
    BotComment,
    FeedbackGrain,
    PostedFollowup,
    Reaction,
    ThumbsSweepPort,
} from "./thumbs-sweep.ts";
import {
    NEGATIVE_REACTIONS,
    parseFollowupMarkers,
    POSITIVE_REACTIONS,
} from "./thumbs-sweep.ts";
import {BLOCKING_LABELS, NON_BLOCKING_LABELS} from "./render-comment.ts";

/**
 * The one octokit surface this module needs: `octokit.request`. Kept this
 * narrow so tests fake a single function and the module never depends on
 * octokit's types; the real client (constructed in `run-thumbs-sweep.ts`)
 * satisfies it directly.
 */
export type OctokitRequestFn = (
    route: string,
    params?: Record<string, unknown>,
) => Promise<{data: unknown}>;

/**
 * The hidden marker that identifies the reviewer's risks/patterns summary
 * comment (`review.md` Step 7 requires the comment to begin with this exact
 * marker line). Matched as a substring so surrounding whitespace or the
 * version marker never break identification.
 */
export const SUMMARY_COMMENT_MARKER = "<!-- pr-reviewer:risks-and-patterns -->";

/**
 * The engine-emitted marker gh-aw appends to every comment a workflow posts:
 * `<!-- gh-aw-workflow-call-id: <owner>/<repo>/<workflow-id> -->`. Observed
 * production summary comments carry this but not the `pr-reviewer` marker
 * (the orchestrator's marker line is not reliably emitted on older pins), so
 * the sweep accepts either. The reviewer's only `add-comment` output is the
 * risks/patterns comment (`max: 1`, status comments disabled), so scoping by
 * the review workflow's call id is exact, not heuristic.
 */
export const workflowCallIdMarker = (
    owner: string,
    repo: string,
    workflowId: string,
): string => `<!-- gh-aw-workflow-call-id: ${owner}/${repo}/${workflowId} -->`;

/**
 * Body prefixes that identify a reviewer inline comment: the code-owned
 * Conventional-Comment label taxonomy, exactly as `renderComment` templates it
 * (`**<label>:** …`). Built from `render-comment.ts`'s canonical label lists so
 * a taxonomy change cannot silently desynchronise the sweep.
 */
export const INLINE_COMMENT_PREFIXES: readonly string[] = [
    ...BLOCKING_LABELS,
    ...NON_BLOCKING_LABELS,
].map((label) => `**${label}:**`);

/** Whether a body is templated like a reviewer inline comment. */
export const isReviewerInlineBody = (body: string): boolean =>
    INLINE_COMMENT_PREFIXES.some((prefix) => body.startsWith(prefix));

/** Whether a body is the reviewer's risks/patterns summary comment. */
export const isReviewerSummaryBody = (
    body: string,
    extraMarkers: readonly string[] = [],
): boolean =>
    body.includes(SUMMARY_COMMENT_MARKER) ||
    extraMarkers.some((marker) => body.includes(marker));

/** Whether a body is a thumbs-sweep follow-up (any grain). */
export const isFollowupBody = (body: string): boolean =>
    parseFollowupMarkers(body).length > 0;

/** Traversal bounds and identity for one repo's sweep. */
export type GithubThumbsSweepOptions = {
    owner: string;
    repo: string;
    /** The login the reviewer's comments are authored as. */
    botLogin: string;
    /** Only PRs updated within this many days are swept. Default 14. */
    lookbackDays?: number;
    /** Hard cap on PRs traversed per sweep. Default 200. */
    maxPulls?: number;
    /**
     * Closed/merged PRs stay in the sweep for this many days after closing
     * (feedback often lands right around merge time), then are skipped. Default
     * 3.
     */
    closedGraceDays?: number;
    /**
     * The gh-aw workflow id(s) of the repo's review install(s), used to build
     * the {@link workflowCallIdMarker}(s) that identify the summary comment.
     * Default `["review"]`; a repo running a preview arm adds its id here.
     */
    reviewWorkflowIds?: readonly string[];
    /** Clock override (ms since epoch) so tests can pin the lookback window. */
    now?: number;
};

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_MAX_PULLS = 200;
const DEFAULT_CLOSED_GRACE_DAYS = 3;
const PER_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-sweep traversal stats, for the auditable job summary. */
export type SweepTraversalStats = {
    /** PRs whose comments were traversed this sweep. */
    pullsScanned: number;
    /** Total GitHub API requests issued (reads and writes). */
    apiRequests: number;
    /**
     * Real-user reaction tallies observed across the reviewer's comments (the
     * bot's own reactions excluded), using the shared
     * {@link POSITIVE_REACTIONS} / {@link NEGATIVE_REACTIONS} sets
     * (👍/❤️/🎉/🚀 vs 👎/😕) — the live agree/disagree numbers.
     */
    reactions: {positive: number; negative: number};
    /**
     * Reviewer inline threads currently resolved — reported as its own
     * positive column, not folded into the reaction tallies (threads are also
     * resolved just to clear noise, and a resolution can't answer a "why?"
     * follow-up).
     */
    resolvedInlineThreads: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];

const loginOf = (value: unknown): string | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const user = value["user"];
    if (!isRecord(user)) {
        return undefined;
    }
    const login = user["login"];
    return typeof login === "string" ? login : undefined;
};

const bodyOf = (value: unknown): string => {
    if (!isRecord(value)) {
        return "";
    }
    const body = value["body"];
    return typeof body === "string" ? body : "";
};

const idOf = (value: unknown): number | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const id = value["id"];
    return typeof id === "number" && Number.isInteger(id) ? id : undefined;
};

const reactionTotalOf = (value: unknown): number => {
    if (!isRecord(value)) {
        return 0;
    }
    const reactions = value["reactions"];
    if (!isRecord(reactions)) {
        return 0;
    }
    const total = reactions["total_count"];
    return typeof total === "number" ? total : 0;
};

/** The shared reaction vocabularies as sets, for the live tallies. */
const positive: ReadonlySet<string> = new Set(POSITIVE_REACTIONS);
const negative: ReadonlySet<string> = new Set(NEGATIVE_REACTIONS);

/**
 * Review threads for one PR, paged. `comments(first: 1)` yields the thread's
 * root comment, whose `databaseId` is the REST comment id the traversal
 * already classified — the join key back to the sweep's inline candidates.
 */
const RESOLVED_THREADS_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                    isResolved
                    comments(first: 1) { nodes { databaseId } }
                }
            }
        }
    }
}`;

/** The `reviewThreads` connection from a GraphQL response body, if present. */
const threadsConnectionOf = (
    body: unknown,
): Record<string, unknown> | undefined => {
    if (!isRecord(body)) {
        return undefined;
    }
    const data = body["data"];
    if (!isRecord(data)) {
        return undefined;
    }
    const repository = data["repository"];
    if (!isRecord(repository)) {
        return undefined;
    }
    const pullRequest = repository["pullRequest"];
    if (!isRecord(pullRequest)) {
        return undefined;
    }
    const threads = pullRequest["reviewThreads"];
    return isRecord(threads) ? threads : undefined;
};

/** REST comment id of a thread's root comment, if the node carries one. */
const threadRootCommentIdOf = (
    node: Record<string, unknown>,
): number | undefined => {
    const comments = node["comments"];
    if (!isRecord(comments)) {
        return undefined;
    }
    const [first] = asArray(comments["nodes"]);
    if (!isRecord(first)) {
        return undefined;
    }
    const id = first["databaseId"];
    return typeof id === "number" && Number.isInteger(id) ? id : undefined;
};

/** The cursor for the next threads page, or null when this was the last. */
const nextThreadsCursorOf = (
    threads: Record<string, unknown>,
): string | null => {
    const pageInfo = threads["pageInfo"];
    if (!isRecord(pageInfo) || pageInfo["hasNextPage"] !== true) {
        return null;
    }
    const cursor = pageInfo["endCursor"];
    return typeof cursor === "string" ? cursor : null;
};

/** One traversed comment, before its reactions are resolved. */
type CandidateComment = {
    grain: FeedbackGrain;
    id: number;
    pullNumber: number;
    /** Reaction summary total from the listing (0 -> skip the detail fetch). */
    reactionTotal: number;
};

/**
 * The octokit-backed port. Construct once per sweep; the GitHub traversal runs
 * lazily on the first port call and is cached, so the sweep core's
 * per-grain/per-comment calls never re-fetch.
 */
export class GithubThumbsSweepPort implements ThumbsSweepPort {
    private readonly request: OctokitRequestFn;
    private readonly owner: string;
    private readonly repo: string;
    private readonly botLogin: string;
    private readonly lookbackDays: number;
    private readonly maxPulls: number;
    private readonly closedGraceDays: number;
    private readonly summaryMarkers: readonly string[];
    private readonly now: number | undefined;

    private apiRequests = 0;
    private positiveReactions = 0;
    private negativeReactions = 0;
    private resolvedInlineThreads = 0;
    private pullsScanned = 0;

    /** (grain, commentId) -> PR number, filled by the traversal. */
    private readonly pullByComment = new Map<string, number>();

    private snapshot:
        | Promise<{
              comments: Map<FeedbackGrain, BotComment[]>;
              followupBodies: string[];
          }>
        | undefined;

    constructor(request: OctokitRequestFn, options: GithubThumbsSweepOptions) {
        this.request = request;
        this.owner = options.owner;
        this.repo = options.repo;
        this.botLogin = options.botLogin;
        this.lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
        this.maxPulls = options.maxPulls ?? DEFAULT_MAX_PULLS;
        this.closedGraceDays =
            options.closedGraceDays ?? DEFAULT_CLOSED_GRACE_DAYS;
        this.summaryMarkers = (options.reviewWorkflowIds ?? ["review"]).map(
            (workflowId) =>
                workflowCallIdMarker(options.owner, options.repo, workflowId),
        );
        this.now = options.now;
    }

    /** Traversal stats for the job summary. Call after the sweep completes. */
    stats(): SweepTraversalStats {
        return {
            pullsScanned: this.pullsScanned,
            apiRequests: this.apiRequests,
            reactions: {
                positive: this.positiveReactions,
                negative: this.negativeReactions,
            },
            resolvedInlineThreads: this.resolvedInlineThreads,
        };
    }

    async listBotComments(grain: FeedbackGrain): Promise<BotComment[]> {
        const {comments} = await this.load();
        return comments.get(grain) ?? [];
    }

    async listExistingFollowups(): Promise<string[]> {
        const {followupBodies} = await this.load();
        return followupBodies;
    }

    async postFollowup(followup: PostedFollowup): Promise<void> {
        const pullNumber = this.pullByComment.get(
            `${followup.grain}:${followup.commentId}`,
        );
        if (pullNumber === undefined) {
            throw new Error(
                `postFollowup: unknown comment ${followup.grain}:${followup.commentId}`,
            );
        }
        if (followup.grain === "inline") {
            // Reply in the inline comment's own thread, so the "why?" prompt
            // sits next to the finding it asks about.
            await this.write(
                "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
                {
                    owner: this.owner,
                    repo: this.repo,
                    pull_number: pullNumber,
                    comment_id: followup.commentId,
                    body: followup.body,
                },
            );
            return;
        }
        // Summary follow-ups are ordinary PR (issue) comments.
        await this.write(
            "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
            {
                owner: this.owner,
                repo: this.repo,
                issue_number: pullNumber,
                body: followup.body,
            },
        );
    }

    private load() {
        this.snapshot ??= this.traverse();
        return this.snapshot;
    }

    private async get(
        route: string,
        params: Record<string, unknown>,
    ): Promise<unknown> {
        this.apiRequests += 1;
        const {data} = await this.request(route, params);
        return data;
    }

    private async write(
        route: string,
        params: Record<string, unknown>,
    ): Promise<void> {
        this.apiRequests += 1;
        await this.request(route, params);
    }

    /** All pages of a list endpoint, in listing order. */
    private async paginate(
        route: string,
        params: Record<string, unknown>,
    ): Promise<unknown[]> {
        const items: unknown[] = [];
        for (let page = 1; ; page += 1) {
            const data = await this.get(route, {
                ...params,
                per_page: PER_PAGE,
                page,
            });
            const batch = asArray(data);
            items.push(...batch);
            if (batch.length < PER_PAGE) {
                return items;
            }
        }
    }

    /**
     * PR numbers updated within the lookback window, newest first, capped.
     * Closed/merged PRs past the closed-grace window are skipped: feedback
     * lands around merge time, so a short grace period captures the post-merge
     * tail without re-sweeping long-landed PRs forever.
     */
    private async recentPullNumbers(): Promise<number[]> {
        const nowMs = this.now ?? Date.now();
        const cutoff = nowMs - this.lookbackDays * DAY_MS;
        const closedCutoff = nowMs - this.closedGraceDays * DAY_MS;
        const numbers: number[] = [];
        for (let page = 1; numbers.length < this.maxPulls; page += 1) {
            const data = await this.get("GET /repos/{owner}/{repo}/pulls", {
                owner: this.owner,
                repo: this.repo,
                state: "all",
                sort: "updated",
                direction: "desc",
                per_page: PER_PAGE,
                page,
            });
            const batch = asArray(data);
            for (const pull of batch) {
                if (!isRecord(pull)) {
                    continue;
                }
                const number = pull["number"];
                const updatedAt = pull["updated_at"];
                if (
                    typeof number !== "number" ||
                    typeof updatedAt !== "string"
                ) {
                    continue;
                }
                if (Date.parse(updatedAt) < cutoff) {
                    // Sorted by updated desc: everything after is older still.
                    return numbers;
                }
                const closedAt = pull["closed_at"];
                if (
                    pull["state"] === "closed" &&
                    typeof closedAt === "string" &&
                    Date.parse(closedAt) < closedCutoff
                ) {
                    // Skip, but keep scanning: update order is not close order.
                    continue;
                }
                numbers.push(number);
                if (numbers.length >= this.maxPulls) {
                    return numbers;
                }
            }
            if (batch.length < PER_PAGE) {
                return numbers;
            }
        }
        return numbers;
    }

    /** Resolve a candidate's reactions (with reactor logins) when it has any. */
    private async reactionsFor(
        candidate: CandidateComment,
    ): Promise<Reaction[]> {
        if (candidate.reactionTotal === 0) {
            return [];
        }
        const route =
            candidate.grain === "inline"
                ? "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
                : "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions";
        const raw = await this.paginate(route, {
            owner: this.owner,
            repo: this.repo,
            comment_id: candidate.id,
        });
        const reactions: Reaction[] = [];
        for (const entry of raw) {
            if (!isRecord(entry)) {
                continue;
            }
            const content = entry["content"];
            if (typeof content !== "string") {
                continue;
            }
            const user = loginOf(entry);
            reactions.push(user === undefined ? {content} : {content, user});
        }
        return reactions;
    }

    private async traverse(): Promise<{
        comments: Map<FeedbackGrain, BotComment[]>;
        followupBodies: string[];
    }> {
        const candidates: CandidateComment[] = [];
        const followupBodies: string[] = [];

        const pullNumbers = await this.recentPullNumbers();
        for (const pullNumber of pullNumbers) {
            this.pullsScanned += 1;

            const inline = await this.paginate(
                "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
                {owner: this.owner, repo: this.repo, pull_number: pullNumber},
            );
            const summary = await this.paginate(
                "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
                {owner: this.owner, repo: this.repo, issue_number: pullNumber},
            );

            const classify = (
                grain: FeedbackGrain,
                raw: unknown[],
                isCandidateBody: (body: string) => boolean,
            ) => {
                for (const comment of raw) {
                    if (loginOf(comment) !== this.botLogin) {
                        continue;
                    }
                    const body = bodyOf(comment);
                    // Follow-ups are collected for idempotency at both grains
                    // and are never themselves candidates.
                    if (isFollowupBody(body)) {
                        followupBodies.push(body);
                        continue;
                    }
                    const id = idOf(comment);
                    if (id === undefined || !isCandidateBody(body)) {
                        continue;
                    }
                    this.pullByComment.set(`${grain}:${id}`, pullNumber);
                    candidates.push({
                        grain,
                        id,
                        pullNumber,
                        reactionTotal: reactionTotalOf(comment),
                    });
                }
            };
            classify("inline", inline, isReviewerInlineBody);
            classify("summary", summary, (body) =>
                isReviewerSummaryBody(body, this.summaryMarkers),
            );
        }

        const comments = new Map<FeedbackGrain, BotComment[]>([
            ["inline", []],
            ["summary", []],
        ]);
        for (const candidate of candidates) {
            const reactions = await this.reactionsFor(candidate);
            for (const reaction of reactions) {
                if (reaction.user === this.botLogin) {
                    // The bot's own reactions (e.g. post-time seeded nudges)
                    // are never live signal.
                    continue;
                }
                if (positive.has(reaction.content)) {
                    this.positiveReactions += 1;
                } else if (negative.has(reaction.content)) {
                    this.negativeReactions += 1;
                }
            }
            comments.get(candidate.grain)?.push({
                grain: candidate.grain,
                id: candidate.id,
                reactions,
            });
        }

        // Resolved inline threads, one GraphQL query per PR that has reviewer
        // inline comments. Counted here (not fed to the sweep core): resolution
        // is a reported positive signal, never a follow-up trigger.
        const inlineByPull = new Map<number, Set<number>>();
        for (const candidate of candidates) {
            if (candidate.grain !== "inline") {
                continue;
            }
            const ids = inlineByPull.get(candidate.pullNumber) ?? new Set();
            ids.add(candidate.id);
            inlineByPull.set(candidate.pullNumber, ids);
        }
        for (const [pullNumber, ids] of inlineByPull) {
            this.resolvedInlineThreads += await this.resolvedThreadCount(
                pullNumber,
                ids,
            );
        }

        return {comments, followupBodies};
    }

    /**
     * Count this PR's resolved review threads whose root comment is one of the
     * sweep's inline candidates. Thread resolution is only exposed via GraphQL
     * (`pullRequest.reviewThreads`), not the REST comment listing.
     */
    private async resolvedThreadCount(
        pullNumber: number,
        candidateIds: ReadonlySet<number>,
    ): Promise<number> {
        let resolved = 0;
        let cursor: string | null = null;
        do {
            const data = await this.get("POST /graphql", {
                query: RESOLVED_THREADS_QUERY,
                variables: {
                    owner: this.owner,
                    repo: this.repo,
                    number: pullNumber,
                    cursor,
                },
            });
            const threads = threadsConnectionOf(data);
            if (threads === undefined) {
                // Missing/unreadable response (e.g. GraphQL error): report
                // what was counted so far rather than failing the sweep.
                return resolved;
            }
            for (const node of asArray(threads["nodes"])) {
                if (!isRecord(node) || node["isResolved"] !== true) {
                    continue;
                }
                const rootId = threadRootCommentIdOf(node);
                if (rootId !== undefined && candidateIds.has(rootId)) {
                    resolved += 1;
                }
            }
            cursor = nextThreadsCursorOf(threads);
        } while (cursor !== null);
        return resolved;
    }
}
