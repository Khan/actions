/**
 * The reduced-depth clearance's executor: dismiss the standing
 * CHANGES_REQUESTED review(s) this run earned back (post-step, review.md).
 *
 * The decision is made in code by the plan CLI (submission.ts): a
 * flip-gated/fast round over a prior REQUEST_CHANGES whose blocking
 * objections are all resolved stages `out/dismiss-decision.json`
 * (`{reviewIds, message}`) instead of minting an approval no full roster
 * stands behind. This CLI reads that decision back and executes it with
 * `PUT /repos/{repo}/pulls/{n}/reviews/{id}/dismissals`.
 *
 * Trust boundary, and why the allowlist is fetched live: everything under
 * `/tmp/gh-aw/review/` is writable by the orchestrator (the decision file,
 * `prior-reviews.json`, `pr-context.json` alike), and this step performs an
 * authenticated write that removes a merge gate, so nothing staged may feed
 * it. The dismissable set is re-derived from a live
 * `GET /repos/{repo}/pulls/{n}/reviews` (the token this CLI already holds),
 * scoped to the intersection of the bot author ({@link isReviewBotAuthor};
 * the stamp is public, posted verbatim in every review body, so a human
 * reviewer could copy it) and this workflow's own re-review stamp (the
 * shared {@link standingChangesRequestedIds} predicate; the login alone is
 * every Actions workflow in the repo), and the repo/PR coordinates come
 * from the runner's own env (`GITHUB_REPOSITORY`, `REVIEW_PR_NUMBER`, the
 * event payload as the fallback), not from staged JSON. What the executor
 * verifies is the TARGET SET, never the license: whether this round's plan
 * licensed a dismissal at all is the gate's rule 5c (fail-open on infra
 * failure), so the residual on that path is a forged decision that can
 * still only dismiss this workflow's genuine standing blocks on this PR,
 * with the fixed message; the effect equals the legitimate clearance. The dispatch gate's rule 5c
 * mirrors the same predicate over the staged copy before this step runs;
 * that mirror is best-effort (same-directory input, documented fail-open),
 * this one is authoritative. A failed fetch dismisses nothing.
 *
 * Why a post-step and not a safe output: the pinned gh-aw (v0.85.4) ships
 * no dismiss output, and `supersede-older-reviews` dismisses on every
 * replacement review, kept-blocking rounds included. Why the bot token:
 * dismissal requires write access, the same reason the
 * resolve-pull-request-review-thread output already carries
 * KHAN_ACTIONS_BOT_TOKEN.
 *
 * Failure posture: every failure is a warning, never a red run. A dismissal
 * that does not happen leaves the block standing, which is the safe
 * direction (more review, never less); the next full-roster round clears it
 * with a genuine verdict, and the posted body note states the dismissal as
 * intent, not fact, for exactly this case.
 *
 * Determinism boundary: staged JSON and one authenticated list call in, one
 * authenticated REST call per review id out. No model call, no prose about
 * the code under review.
 */

import {
    DISMISS_DECISION_PATH,
    DISMISSAL_MESSAGE,
    standingChangesRequestedIds,
} from "./submission-clearance";
import {isReviewBotAuthor} from "./threads";

export type DismissReviewFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
};

/** One authenticated REST PUT; injected so tests never touch the network. */
export type DismissPut = (
    path: string,
    body: {message: string},
) => Promise<{ok: boolean; status: number}>;

/**
 * One authenticated REST GET returning parsed JSON; injected like
 * {@link DismissPut}. Throws or `ok: false` on failure.
 */
export type DismissGet = (
    path: string,
) => Promise<{ok: boolean; status: number; body: unknown}>;

export type DismissReviewResult = {
    /** Review ids successfully dismissed. */
    dismissed: number[];
    /** Fixed-format problems (each one a warning, never a failure). */
    warnings: string[];
};

const readJsonIfPresent = (fs: DismissReviewFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/**
 * The PR coordinates, from the runner's env (never from staged JSON).
 * `REVIEW_PR_NUMBER` first: it is expression-expanded by Actions when the
 * job starts (the same convention the staging step uses), so the agent
 * cannot rewrite it the way it could a file; the event payload is the
 * fallback for a step that predates the env line.
 */
export const prCoordinatesFromEnv = (
    fs: DismissReviewFs,
    repository: string | undefined = process.env.GITHUB_REPOSITORY,
    prNumberEnv: string | undefined = process.env.REVIEW_PR_NUMBER,
    eventPath: string | undefined = process.env.GITHUB_EVENT_PATH,
): {repo: string; prNumber: number} | null => {
    if (repository === undefined || repository === "") {
        return null;
    }
    const fromEnv = Number(prNumberEnv ?? "");
    if (Number.isInteger(fromEnv) && fromEnv > 0) {
        return {repo: repository, prNumber: fromEnv};
    }
    const event =
        eventPath === undefined || eventPath === ""
            ? undefined
            : readJsonIfPresent(fs, eventPath);
    const payload = (event ?? {}) as {
        pull_request?: {number?: unknown};
        issue?: {number?: unknown};
    };
    const prNumber = payload.pull_request?.number ?? payload.issue?.number;
    return typeof prNumber === "number" ? {repo: repository, prNumber} : null;
};

/**
 * The live dismissable set: every review page fetched, filtered to the
 * bot author (the stamp is public and copyable; the intersection of
 * author and stamp is the identity, matching stage-pr.ts's staging
 * filter), then the shared standing predicate (stamp-scoped,
 * latest-decisive-wins) over the chronological list. Throws on a failed
 * page, a non-array page (sibling readers throw on shape violations too),
 * or a list past the page cap; the caller treats any throw as "dismiss
 * nothing".
 *
 * The cap bounds the loop against a pathological or lying API (30 pages =
 * 3,000 reviews; this workflow posts roughly one review per push, so any
 * real PR sits orders of magnitude below it, and a list that large means
 * something is wrong enough that refusing is the right answer).
 */
const MAX_REVIEW_PAGES = 30;
const fetchDismissableIds = async (
    get: DismissGet,
    repo: string,
    prNumber: number,
): Promise<Set<number>> => {
    const reviews: unknown[] = [];
    for (let page = 1; ; page += 1) {
        if (page > MAX_REVIEW_PAGES) {
            throw new Error(
                `review list exceeds ${MAX_REVIEW_PAGES} pages: refusing to derive an allowlist`,
            );
        }
        const response = await get(
            `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
        );
        if (!response.ok) {
            throw new Error(
                `review list fetch failed (HTTP ${response.status})`,
            );
        }
        if (!Array.isArray(response.body)) {
            throw new Error("review list page is not an array");
        }
        const items = response.body;
        reviews.push(...items);
        if (items.length < 100) {
            break;
        }
    }
    const botReviews = reviews.filter((entry) => {
        const login = (entry as {user?: {login?: unknown}} | null)?.user?.login;
        return typeof login === "string" && isReviewBotAuthor(login);
    });
    return new Set(standingChangesRequestedIds(botReviews));
};

/**
 * Execute the staged dismissal decision, when one exists. No decision file
 * is the common case (every full/scoped round, every reduced round with a
 * kept blocking thread) and returns empty-handed.
 */
export const runDismissReviewCli = async (
    fs: DismissReviewFs,
    put: DismissPut,
    get: DismissGet,
    coordinates: {repo: string; prNumber: number} | null = prCoordinatesFromEnv(
        fs,
    ),
): Promise<DismissReviewResult> => {
    const dismissed: number[] = [];
    const warnings: string[] = [];

    if (!fs.existsSync(DISMISS_DECISION_PATH)) {
        return {dismissed, warnings};
    }
    // Normalized like the gate's rule 5c: a JSON `null` (or any
    // non-object) parses fine and must warn as unusable, not throw on
    // member access.
    const parsed = readJsonIfPresent(fs, DISMISS_DECISION_PATH);
    const decision =
        typeof parsed === "object" && parsed !== null
            ? (parsed as {reviewIds?: unknown; message?: unknown})
            : undefined;
    if (decision === undefined) {
        // Present but unparseable is not the common no-op: the stated
        // failure posture is a warning, never silence.
        warnings.push(
            `dismiss decision staged but unparseable (${DISMISS_DECISION_PATH}): block stands`,
        );
        return {dismissed, warnings};
    }
    const stagedIds = Array.isArray(decision.reviewIds)
        ? decision.reviewIds.filter(
              (id): id is number => typeof id === "number",
          )
        : [];
    // The message is never sent verbatim from the agent-writable file:
    // only the shared constant posts to the timeline, and a drifted staged
    // message marks the decision unusable (the gate checks the same thing,
    // rule 5c; this covers its fail-open path independently).
    if (stagedIds.length === 0 || decision.message !== DISMISSAL_MESSAGE) {
        warnings.push(
            `dismiss decision staged but unusable (${DISMISS_DECISION_PATH}): block stands`,
        );
        return {dismissed, warnings};
    }

    if (coordinates === null) {
        warnings.push(
            "pr coordinates unavailable (GITHUB_REPOSITORY / event payload): block stands",
        );
        return {dismissed, warnings};
    }
    const {repo, prNumber} = coordinates;

    let allowed: Set<number>;
    try {
        allowed = await fetchDismissableIds(get, repo, prNumber);
    } catch (error) {
        warnings.push(
            `standing-review fetch failed (${
                error instanceof Error ? error.message : String(error)
            }): block stands`,
        );
        return {dismissed, warnings};
    }
    const reviewIds = stagedIds.filter((id) => allowed.has(id));
    for (const id of stagedIds) {
        if (!allowed.has(id)) {
            warnings.push(
                `dismissal of review ${id} refused: not one of this workflow's standing CHANGES_REQUESTED reviews`,
            );
        }
    }

    for (const id of reviewIds) {
        try {
            const response = await put(
                `/repos/${repo}/pulls/${prNumber}/reviews/${id}/dismissals`,
                {message: DISMISSAL_MESSAGE},
            );
            if (response.ok) {
                dismissed.push(id);
            } else {
                warnings.push(
                    `dismissal of review ${id} failed (HTTP ${response.status}): block stands`,
                );
            }
        } catch (error) {
            warnings.push(
                `dismissal of review ${id} failed (${
                    error instanceof Error ? error.message : String(error)
                }): block stands`,
            );
        }
    }
    return {dismissed, warnings};
};

// Run only when executed directly (review.md's post-step), never on import
// (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as DismissReviewFs;
    const token = process.env.GH_TOKEN;
    // The runner's own API base (GHES-safe), same as the repo's other
    // callers; the public default is the fallback.
    const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const headers = () => {
        if (token === undefined || token === "") {
            throw new Error("GH_TOKEN is not set");
        }
        return {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
        };
    };
    const put: DismissPut = async (path, body) => {
        const response = await fetch(`${apiBase}${path}`, {
            method: "PUT",
            headers: headers(),
            body: JSON.stringify(body),
        });
        return {ok: response.ok, status: response.status};
    };
    const get: DismissGet = async (path) => {
        const response = await fetch(`${apiBase}${path}`, {
            headers: headers(),
        });
        return {
            ok: response.ok,
            status: response.status,
            body: response.ok ? await response.json() : undefined,
        };
    };
    void runDismissReviewCli(fs, put, get)
        .then((result) => {
            for (const id of result.dismissed) {
                // eslint-disable-next-line no-console
                console.log(`dismissed prior request-changes review ${id}`);
            }
            for (const warning of result.warnings) {
                // eslint-disable-next-line no-console
                console.log(`::warning title=review dismissal::${warning}`);
            }
        })
        .catch((error: unknown) => {
            // Same posture as every failure here: a warning, never a red
            // run (the step wrapper also exits 0 regardless).
            // eslint-disable-next-line no-console
            console.log(
                `::warning title=review dismissal::executor errored (${
                    error instanceof Error ? error.message : String(error)
                }): block stands`,
            );
        });
}
