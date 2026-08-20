/**
 * Deterministic linked-ticket staging: fetch the Jira issues the PR
 * references and write them to /tmp/gh-aw/review/ticket-context.json
 * alongside the rest of the pre-agent staging (stage-pr.ts), so the
 * sub-agents that reason about the PR's stated intent (completeness,
 * first-principles) read the actual tickets instead of reconstructing intent
 * from the author's summary of them.
 *
 * History: the completeness prompt used to GRANT itself a Jira/Confluence
 * network read ("the tokens are scoped read-only and provided by the consumer
 * repo"), but no consumer ever provided a token and the firewall egress list
 * never included the Jira host, so the grant was dead text and the fallback
 * clause ("fall back to the PR description alone") fired on every run. This
 * module replaces that unplumbed in-agent fetch with the same pattern every
 * other input already follows: fetched once, deterministically, before any
 * model runs, with the agent sandbox needing no Jira egress at all.
 *
 * Candidate stance: every key-shaped token in the title, head branch, and
 * description is a candidate (deduped, in order of appearance). Known
 * key-shaped noise (UTF-8, SHA-256, CVE-2024-1234 all match the regex) sinks
 * to the back of the candidate list before the MAX_TICKET_FETCHES cap
 * applies, so the cap spends its budget on plausible keys first; whatever
 * survives the cap is tried, and misses simply 404 and drop silently. The
 * residual bound: a real key is only ever crowded out by MAX_TICKET_FETCHES
 * or more earlier key-shaped tokens that are not on the noise list.
 *
 * Failure stance: a ticket is context, not a prerequisite; a review must run
 * identically on a PR with no ticket, a repo with no Jira credentials, or a
 * Jira outage. So this staging NEVER fails the run: every degradation writes
 * `{available: false, reason}` and the prompts fall back to the PR
 * description, exactly as they did before this existed. The file is always
 * written, so readers never need an existence check.
 *
 * Trust stance: ticket text is untrusted input under review, same as the PR
 * description. The staged JSON carries content verbatim (size-capped); the
 * consuming prompts carry the never-follow-instructions rule. The disclosure
 * bound (which tickets author-written keys can pull into a review that posts
 * publicly) is the service account's Jira permissions, enforced server-side:
 * grant it Browse Projects on only the projects reviews may quote, and
 * anything else 404s like a stale key.
 *
 * Determinism boundary: authenticated GETs plus pure functions of their
 * results; no model call, no prose about the code under review.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** One staged ticket (content fields verbatim, size-capped). */
export type StagedTicket = {
    key: string;
    url: string;
    summary: string;
    status: string;
    resolution: string | null;
    type: string;
    labels: string[];
    description: string;
    comments: {author: string; created: string; body: string}[];
    truncated: boolean;
};

/**
 * The staged shape. `available: false` always carries a `reason`;
 * `available: true` carries every ticket that resolved, in candidate order.
 */
export type TicketContext =
    | {available: true; tickets: StagedTicket[]}
    | {
          available: false;
          reason:
              | "not-configured" // no Jira base URL / credentials in the consumer repo
              | "no-issue-key" // nothing key-shaped in the PR title/branch/description
              | "not-found" // every candidate 404d (noise, stale, or not browsable)
              | "fetch-failed"; // auth failure, 5xx, or network error; none resolved
      };

/**
 * One JSON GET, injected so tests never touch the network. Returns the HTTP
 * status and the parsed body (body may be anything on an error status).
 */
export type TicketFetch = (
    url: string,
    headers: Record<string, string>,
) => Promise<{status: number; json: unknown}>;

export type StageTicketOptions = {
    /** e.g. https://khanacademy.atlassian.net; empty means not configured. */
    baseUrl: string;
    /** Atlassian API token auth pair; empty means not configured. */
    email: string;
    apiToken: string;
    /** Key-extraction inputs, in precedence order (title, branch, body). */
    title: string;
    headBranch: string;
    description: string;
};

/* -------------------------------------------------------------------------- */
/* Pure pieces                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A Jira issue key: uppercase project key (letter first, 2-10 chars total),
 * hyphen, number. Word-bounded so PROJ-123 inside a URL or backticks still
 * matches but lowercase prose ("re-123") does not. The shape alone is NOT
 * precise (UTF-8, SHA-256, CVE-2024-1234 all match); precision comes from
 * trying every candidate and letting the misses 404.
 */
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/**
 * Well-known key-shaped tokens that are never Jira issue keys. Not a
 * precision filter (unknown noise still 404s out downstream): this only
 * keeps the usual suspects from spending the fetch budget ahead of a real
 * key when a PR body mentions more than MAX_TICKET_FETCHES key-shaped
 * tokens.
 */
const NON_KEY_PREFIXES = new Set([
    "UTF",
    "SHA",
    "MD",
    "CVE",
    "RFC",
    "ISO",
    "AES",
    "RSA",
    "HTTP",
    "IPV",
]);

/**
 * The fetch cap: the staged file is prompt input, and a PR body that
 * mentions dozens of key-shaped tokens must not turn staging into a crawl.
 */
export const MAX_TICKET_FETCHES = 5;

/**
 * Every candidate key (title, then head branch, then description), deduped,
 * with well-known noise sunk to the back, capped at MAX_TICKET_FETCHES.
 * The sink caps the FETCHES rather than the raw candidate list: without it,
 * a title like "Fix UTF-8 and SHA-256 handling" spends cap slots on tokens
 * that can only 404, and enough of them silently crowd out the real key.
 * Survivors keep order of appearance within their tier; whatever is left
 * gets tried, and noise or stale keys 404 out downstream.
 */
export const extractIssueKeys = (
    title: string,
    headBranch: string,
    description: string,
): string[] => {
    const keys: string[] = [];
    for (const text of [title, headBranch, description]) {
        for (const match of text.matchAll(ISSUE_KEY_RE)) {
            if (!keys.includes(match[1])) {
                keys.push(match[1]);
            }
        }
    }
    const isNoise = (key: string): boolean =>
        NON_KEY_PREFIXES.has(key.slice(0, key.indexOf("-")));
    return keys
        .map((key, index) => ({key, index}))
        .sort(
            (a, b) =>
                Number(isNoise(a.key)) - Number(isNoise(b.key)) ||
                a.index - b.index,
        )
        .slice(0, MAX_TICKET_FETCHES)
        .map((candidate) => candidate.key);
};

/** Size caps: the staged file is prompt input, not an archive. */
const DESCRIPTION_CAP = 8000;
const COMMENT_BODY_CAP = 2000;
const COMMENT_COUNT_CAP = 20;

const capText = (text: string, cap: number): {text: string; cut: boolean} =>
    text.length > cap
        ? {text: `${text.slice(0, cap)}\n[truncated]`, cut: true}
        : {text, cut: false};

/** The fields this module reads from GET /rest/api/2/issue/{key}. */
type JiraIssue = {
    fields?: {
        summary?: string;
        description?: string | null;
        status?: {name?: string};
        resolution?: {name?: string} | null;
        issuetype?: {name?: string};
        labels?: unknown;
        comment?: {
            comments?: {
                author?: {displayName?: string};
                created?: string;
                body?: string;
            }[];
            /**
             * The field is a pagination envelope: `comments` is one page and
             * `total` the true count, so `total > comments.length` means the
             * staged trail is partial even before this module's own cap.
             */
            total?: number;
        };
    };
};

/**
 * The staged shape from a fetched issue. Comments keep the LAST
 * COMMENT_COUNT_CAP of the returned page (Jira returns them oldest-first,
 * and the decision trail a reviewer wants ("experiment concluded, graduate
 * everywhere") lands at the end). When the envelope's `total` exceeds the
 * page, the true tail may live beyond it; `truncated` covers that too, and
 * a dedicated comment fetch is not worth a second HTTP call until a real
 * run shows a long ticket whose tail mattered.
 */
export const buildStagedTicket = (
    key: string,
    baseUrl: string,
    issue: JiraIssue | null,
): StagedTicket => {
    const fields = issue?.fields ?? {};
    let truncated = false;
    const description = capText(fields.description ?? "", DESCRIPTION_CAP);
    truncated = truncated || description.cut;
    const allComments = fields.comment?.comments ?? [];
    truncated =
        truncated ||
        allComments.length > COMMENT_COUNT_CAP ||
        (typeof fields.comment?.total === "number" &&
            fields.comment.total > allComments.length);
    const comments = allComments.slice(-COMMENT_COUNT_CAP).map((comment) => {
        const body = capText(comment.body ?? "", COMMENT_BODY_CAP);
        truncated = truncated || body.cut;
        return {
            author: comment.author?.displayName ?? "",
            created: comment.created ?? "",
            body: body.text,
        };
    });
    return {
        key,
        url: `${baseUrl}/browse/${key}`,
        summary: fields.summary ?? "",
        status: fields.status?.name ?? "",
        resolution: fields.resolution?.name ?? null,
        type: fields.issuetype?.name ?? "",
        labels: Array.isArray(fields.labels)
            ? fields.labels.filter((l): l is string => typeof l === "string")
            : [],
        description: description.text,
        comments,
        truncated,
    };
};

/* -------------------------------------------------------------------------- */
/* The staging run                                                            */
/* -------------------------------------------------------------------------- */

export type StageTicketResult = {
    context: TicketContext;
    /** Non-fatal degradations worth a step-log line (never a 404). */
    warnings: string[];
};

/** One candidate's outcome. */
type Attempt =
    | {kind: "ticket"; ticket: StagedTicket}
    | {kind: "not-found"}
    | {kind: "failed"; warning: string};

const attemptFetch = async (
    fetchJson: TicketFetch,
    baseUrl: string,
    auth: string,
    key: string,
): Promise<Attempt> => {
    // v2, not Jira Cloud's current v3: v2 returns `description` and comment
    // bodies as plain text, while v3 returns Atlassian Document Format JSON,
    // which is useless as prompt input.
    const url = `${baseUrl}/rest/api/2/issue/${key}?fields=${[
        "summary",
        "description",
        "status",
        "resolution",
        "issuetype",
        "labels",
        "comment",
    ].join(",")}`;
    try {
        const response = await fetchJson(url, {
            accept: "application/json",
            authorization: `Basic ${auth}`,
        });
        // 404 is normal candidate noise (key-shaped tokens, stale keys,
        // tickets the service account cannot browse): dropped silently.
        // 400 is the same noise in malformed-key form.
        if (response.status === 404 || response.status === 400) {
            return {kind: "not-found"};
        }
        if (response.status !== 200) {
            return {
                kind: "failed",
                warning: `ticket staging: GET ${key} -> ${response.status}`,
            };
        }
        if (
            response.json === null ||
            typeof response.json !== "object" ||
            Array.isArray(response.json)
        ) {
            // A 200 whose body is not a JSON object (an SSO login page on a
            // misconfigured host, say) is a config problem, not a ticket.
            return {
                kind: "failed",
                warning: `ticket staging: GET ${key} -> 200 with a non-issue body`,
            };
        }
        return {
            kind: "ticket",
            ticket: buildStagedTicket(
                key,
                baseUrl,
                response.json as JiraIssue | null,
            ),
        };
    } catch (error) {
        return {
            kind: "failed",
            warning: `ticket staging: GET ${key} failed (${
                error instanceof Error ? error.message : String(error)
            })`,
        };
    }
};

/**
 * Resolve the PR's linked tickets to a `TicketContext`. Every path returns a
 * writable context; nothing here throws.
 */
export const stageTicketContext = async (
    fetchJson: TicketFetch,
    options: StageTicketOptions,
): Promise<StageTicketResult> => {
    const {email, apiToken} = options;
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (baseUrl === "" || email === "" || apiToken === "") {
        return {
            context: {available: false, reason: "not-configured"},
            warnings: [],
        };
    }
    const keys = extractIssueKeys(
        options.title,
        options.headBranch,
        options.description,
    );
    if (keys.length === 0) {
        return {
            context: {available: false, reason: "no-issue-key"},
            warnings: [],
        };
    }
    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    const attempts = await Promise.all(
        keys.map((key) => attemptFetch(fetchJson, baseUrl, auth, key)),
    );
    const tickets = attempts.flatMap((attempt) =>
        attempt.kind === "ticket" ? [attempt.ticket] : [],
    );
    const warnings = attempts.flatMap((attempt) =>
        attempt.kind === "failed"
            ? [
                  `${attempt.warning}; ${
                      tickets.length > 0
                          ? "other tickets staged"
                          : "staged unavailable (prompts fall back to the PR description)"
                  }`,
              ]
            : [],
    );
    if (tickets.length > 0) {
        return {context: {available: true, tickets}, warnings};
    }
    return {
        context: {
            available: false,
            reason: warnings.length > 0 ? "fetch-failed" : "not-found",
        },
        warnings,
    };
};
