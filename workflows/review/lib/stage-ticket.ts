/**
 * Deterministic linked-ticket staging: fetch the Jira issue the PR references
 * and write it to /tmp/gh-aw/review/ticket-context.json alongside the rest of
 * the pre-agent staging (stage-pr.ts), so the sub-agents that reason about
 * the PR's stated intent (completeness, first-principles) read the actual
 * ticket instead of reconstructing intent from the author's summary of it.
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
 * Failure stance: a ticket is context, not a prerequisite; a review must run
 * identically on a PR with no ticket, a repo with no Jira credentials, or a
 * Jira outage. So this staging NEVER fails the run: every degradation writes
 * `{available: false, reason}` and the prompts fall back to the PR
 * description, exactly as they did before this existed. The file is always
 * written, so readers never need an existence check.
 *
 * Trust stance: ticket text is untrusted input under review, same as the PR
 * description. The staged JSON carries content verbatim (size-capped); the
 * consuming prompts carry the never-follow-instructions rule. The project
 * allowlist (REVIEW_JIRA_PROJECTS) bounds WHICH tickets author text can pull
 * in: an issue key is author-controlled input, and without the allowlist any
 * key written into a PR would fetch an arbitrary internal ticket with the
 * org token and feed it to prompts that post publicly.
 *
 * Determinism boundary: one authenticated GET plus pure functions of its
 * result; no model call, no prose about the code under review.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The staged shape. `available: false` always carries a `reason`; the content
 * fields exist only when `available: true`.
 */
export type TicketContext = {
    available: boolean;
    reason?:
        | "not-configured" // no Jira base URL / credentials / project allowlist
        | "no-issue-key" // no allowlisted issue key in the PR title/branch/description
        | "not-found" // the key resolved but Jira returned 404 (stale/foreign key)
        | "fetch-failed"; // auth failure, 5xx, network error
    key?: string;
    url?: string;
    summary?: string;
    status?: string;
    resolution?: string | null;
    type?: string;
    labels?: string[];
    description?: string;
    comments?: {author: string; created: string; body: string}[];
    truncated?: boolean;
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
    /**
     * Comma-separated project-key allowlist (REVIEW_JIRA_PROJECTS, e.g.
     * "KORE,FEI"); empty means not configured. Required: it is both the
     * false-positive filter (UTF-8, SHA-256, CVE-2024-1234 all match the
     * key regex) and the disclosure bound (see the trust stance above).
     */
    projects: string;
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
 * enough (UTF-8, SHA-256, CVE-2024-1234 all match), so every candidate is
 * gated on the project allowlist.
 */
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** REVIEW_JIRA_PROJECTS ("KORE, FEI") → normalized project keys. */
export const parseProjectAllowlist = (raw: string): string[] =>
    raw
        .split(",")
        .map((project) => project.trim().toUpperCase())
        .filter((project) => project !== "");

const allowedKeys = (text: string, projects: string[]): string[] =>
    [...text.matchAll(ISSUE_KEY_RE)]
        .map((match) => match[1])
        .filter((key) => projects.includes(key.split("-")[0]));

/**
 * The PR's own ticket key, gated on the project allowlist. Title and branch
 * outrank the body because a body routinely *mentions* other tickets in
 * prose while the title/branch carry the PR's identity; within the title and
 * branch the FIRST allowed match wins, but within the description the LAST
 * one does (the `~/bin/gh` convention puts the tracking key at the end of
 * the body, after any tickets the prose mentions).
 */
export const extractIssueKey = (
    title: string,
    headBranch: string,
    description: string,
    projects: string[],
): string | null => {
    return (
        allowedKeys(title, projects)[0] ??
        allowedKeys(headBranch, projects)[0] ??
        allowedKeys(description, projects).at(-1) ??
        null
    );
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
export const buildTicketContext = (
    key: string,
    baseUrl: string,
    issue: JiraIssue | null,
): TicketContext => {
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
        available: true,
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

/**
 * Resolve the PR's linked ticket to a `TicketContext`. Every path returns a
 * writable context; nothing here throws.
 */
export const stageTicketContext = async (
    fetchJson: TicketFetch,
    options: StageTicketOptions,
): Promise<StageTicketResult> => {
    const {baseUrl, email, apiToken} = options;
    if (baseUrl === "" || email === "" || apiToken === "") {
        return {
            context: {available: false, reason: "not-configured"},
            warnings: [],
        };
    }
    const projects = parseProjectAllowlist(options.projects);
    if (projects.length === 0) {
        // Credentials without the allowlist is a half-configured consumer,
        // not an unconfigured one: warn, so the misconfiguration is visible.
        return {
            context: {available: false, reason: "not-configured"},
            warnings: [
                'ticket staging: REVIEW_JIRA_BASE_URL is set but REVIEW_JIRA_PROJECTS is not; staged unavailable (set the project-key allowlist, e.g. "KORE,FEI", to enable ticket staging)',
            ],
        };
    }
    const key = extractIssueKey(
        options.title,
        options.headBranch,
        options.description,
        projects,
    );
    if (key === null) {
        return {
            context: {available: false, reason: "no-issue-key"},
            warnings: [],
        };
    }
    const url = `${baseUrl.replace(
        /\/+$/,
        "",
    )}/rest/api/2/issue/${key}?fields=${[
        "summary",
        "description",
        "status",
        "resolution",
        "issuetype",
        "labels",
        "comment",
    ].join(",")}`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    try {
        const response = await fetchJson(url, {
            accept: "application/json",
            authorization: `Basic ${auth}`,
        });
        if (response.status === 404) {
            // A stale or foreign-project key is normal PR noise, not a
            // configuration problem: no warning.
            return {
                context: {available: false, reason: "not-found", key},
                warnings: [],
            };
        }
        if (response.status !== 200) {
            return {
                context: {available: false, reason: "fetch-failed", key},
                warnings: [
                    `ticket staging: GET ${key} -> ${response.status}; staged unavailable (prompts fall back to the PR description)`,
                ],
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
                context: {available: false, reason: "fetch-failed", key},
                warnings: [
                    `ticket staging: GET ${key} -> 200 with a non-issue body; staged unavailable (prompts fall back to the PR description)`,
                ],
            };
        }
        return {
            context: buildTicketContext(
                key,
                baseUrl.replace(/\/+$/, ""),
                response.json as JiraIssue | null,
            ),
            warnings: [],
        };
    } catch (error) {
        return {
            context: {available: false, reason: "fetch-failed", key},
            warnings: [
                `ticket staging: GET ${key} failed (${
                    error instanceof Error ? error.message : String(error)
                }); staged unavailable (prompts fall back to the PR description)`,
            ],
        };
    }
};
