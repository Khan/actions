/**
 * The reduced-depth clearance's executor: dismiss the standing
 * CHANGES_REQUESTED review(s) this run earned back (post-step, review.md).
 *
 * The decision is made in code by the plan CLI (submission.ts): a
 * flip-gated/fast round over a prior REQUEST_CHANGES whose blocking
 * objections are all resolved stages `out/dismiss-decision.json`
 * (`{reviewIds, message}`) instead of minting an approval no full roster
 * stands behind. This CLI reads that decision back and executes it with
 * `PUT /repos/{repo}/pulls/{n}/reviews/{id}/dismissals`. The decision file
 * lives in the agent-writable `out/` scratch directory, so its ids are
 * never trusted verbatim: only ids present as CHANGES_REQUESTED entries in
 * the pre-agent-staged `prior-reviews.json` execute (the dispatch gate
 * mirrors the same check, rule 5c, before this step runs).
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
 * with a genuine verdict. The known ordering window is documented at the
 * step: this runs in the agent job, before the safe_outputs job posts the
 * COMMENT review carrying the explanatory note, so a safe_outputs infra
 * failure can leave a dismissal whose note never posted. The dismissal
 * message itself renders in the PR timeline, so even that window is not
 * silent.
 *
 * Determinism boundary: staged JSON in, one authenticated REST call per
 * review id out. No model call, no prose about the code under review.
 */

const REVIEW_DIR = "/tmp/gh-aw/review";
const DECISION_PATH = `${REVIEW_DIR}/out/dismiss-decision.json`;
const PR_CONTEXT_PATH = `${REVIEW_DIR}/pr-context.json`;
const PRIOR_REVIEWS_PATH = `${REVIEW_DIR}/prior-reviews.json`;

export type DismissReviewFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
};

/** One authenticated REST PUT; injected so tests never touch the network. */
export type DismissPut = (
    path: string,
    body: {message: string},
) => Promise<{ok: boolean; status: number}>;

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
 * The review ids this run may dismiss at all: `prior-reviews.json`'s
 * CHANGES_REQUESTED entries. That file is staged pre-agent by stage-pr.ts
 * (already filtered to the bot's own reviews), while the decision file
 * lives in `out/`, the orchestrator's scratch directory, so the decision's
 * ids are cross-checked here rather than trusted verbatim; the dispatch
 * gate mirrors the same check before this step runs.
 */
const dismissableIds = (fs: DismissReviewFs): Set<number> => {
    const prior = readJsonIfPresent(fs, PRIOR_REVIEWS_PATH);
    return new Set(
        (Array.isArray(prior) ? prior : [])
            .filter(
                (review): review is {id: number; state: string} =>
                    typeof (review as {id?: unknown}).id === "number" &&
                    (review as {state?: unknown}).state === "CHANGES_REQUESTED",
            )
            .map((review) => review.id),
    );
};

/**
 * Execute the staged dismissal decision, when one exists. No decision file
 * is the common case (every full/scoped round, every reduced round with a
 * kept blocking thread) and returns empty-handed.
 */
export const runDismissReviewCli = async (
    fs: DismissReviewFs,
    put: DismissPut,
): Promise<DismissReviewResult> => {
    const dismissed: number[] = [];
    const warnings: string[] = [];

    if (!fs.existsSync(DECISION_PATH)) {
        return {dismissed, warnings};
    }
    const decision = readJsonIfPresent(fs, DECISION_PATH) as
        | {reviewIds?: unknown; message?: unknown}
        | undefined;
    if (decision === undefined) {
        // Present but unparseable is not the common no-op: the stated
        // failure posture is a warning, never silence.
        warnings.push(
            `dismiss decision staged but unparseable (${DECISION_PATH}): block stands`,
        );
        return {dismissed, warnings};
    }
    const allowed = dismissableIds(fs);
    const stagedIds = Array.isArray(decision.reviewIds)
        ? decision.reviewIds.filter(
              (id): id is number => typeof id === "number",
          )
        : [];
    const reviewIds = stagedIds.filter((id) => allowed.has(id));
    for (const id of stagedIds) {
        if (!allowed.has(id)) {
            warnings.push(
                `dismissal of review ${id} refused: not a CHANGES_REQUESTED id in ${PRIOR_REVIEWS_PATH}`,
            );
        }
    }
    const message =
        typeof decision.message === "string" ? decision.message : "";
    if (reviewIds.length === 0 || message === "") {
        warnings.push(
            `dismiss decision staged but unusable (${DECISION_PATH}): block stands`,
        );
        return {dismissed, warnings};
    }

    const prContext = readJsonIfPresent(fs, PR_CONTEXT_PATH) as
        | {number?: unknown; repo?: unknown}
        | undefined;
    const prNumber = prContext?.number;
    const repo = prContext?.repo;
    if (typeof prNumber !== "number" || typeof repo !== "string") {
        warnings.push(
            `pr context not staged (${PR_CONTEXT_PATH}): block stands`,
        );
        return {dismissed, warnings};
    }

    for (const id of reviewIds) {
        try {
            const response = await put(
                `/repos/${repo}/pulls/${prNumber}/reviews/${id}/dismissals`,
                {message},
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
    const token = process.env["GH_TOKEN"];
    // The runner's own API base (GHES-safe), same as the repo's other
    // callers; the public default is the fallback.
    const apiBase = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
    const put: DismissPut = async (path, body) => {
        if (token === undefined || token === "") {
            throw new Error("GH_TOKEN is not set");
        }
        const response = await fetch(`${apiBase}${path}`, {
            method: "PUT",
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github+json",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        return {ok: response.ok, status: response.status};
    };
    void runDismissReviewCli(fs, put)
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
