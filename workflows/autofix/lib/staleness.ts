/**
 * The review-currency guard: is there a review recent enough to act on?
 *
 * The failure this prevents is the one most likely to make autofix look broken
 * for reasons unrelated to fix quality. Someone labels a PR whose review
 * predates the current head; the findings then describe code that has already
 * changed, and an agent acting on them edits on the strength of a stale
 * statement. Nothing about the label tells you this happened, so it has to be
 * checked before any work is planned.
 *
 * The check reuses the reviewer's own fingerprint rather than inventing a
 * freshness signal. Every review stamps the hunk signature it reviewed into a
 * hidden comment in its body, precisely because that record survives when cache
 * memory does not (`review.md` Step 6; `rereview-mode.ts`). Comparing the
 * current diff's signature against that stamp answers "has this code changed
 * since a review saw it" exactly, across force-pushes and rebases, because the
 * hashes cover added-line content rather than commit SHAs or line numbers.
 *
 * Granularity is per-path, not per-PR, and that is deliberate. An all-or-nothing
 * gate would refuse the whole run because the author pushed one unrelated fix
 * after the review, which is both common and harmless for findings in other
 * files. Reporting the stale paths lets the caller drop just the affected work
 * items and fix the rest, so the guard degrades to partial work instead of
 * refusal.
 *
 * Every unreadable state fails closed (refuse, do not fix). The reviewer's
 * equivalent states fail the other way — an unreadable fingerprint there means
 * "review more deeply", extra work on a safe side. Here the safe side is doing
 * nothing.
 */

import {
    computeDivergence,
    computeHunkSignature,
    findLatestStamp,
} from "../../review/lib/rereview-mode.ts";
import type {Divergence, PriorReview} from "../../review/lib/rereview-mode.ts";

export type CurrencyAssessment =
    | {
          /** No review has ever stamped this PR; there are no findings to act on. */
          status: "no-review";
      }
    | {
          /**
           * A review exists but its fingerprint is unreadable — `hunks=overflow`
           * on a diff too large to stamp, or a stamp this schema version does
           * not understand. Currency cannot be established, so the run stops.
           */
          status: "no-fingerprint";
      }
    | {
          status: "current";
          divergence: Divergence;
          /** Paths carrying hunks no stamped review has seen. */
          stalePaths: string[];
      };

/**
 * Compare the current diff against the most recent stamped review.
 *
 * `diffText` should be the same stripped diff the reviewer fingerprints
 * (`full-stripped.diff`), so generated-file churn does not read as staleness.
 */
export const assessReviewCurrency = (
    reviews: readonly PriorReview[],
    diffText: string,
): CurrencyAssessment => {
    const stamp = findLatestStamp(reviews);
    if (stamp === null) {
        return {status: "no-review"};
    }
    if (stamp.anchorHunks === "overflow") {
        return {status: "no-fingerprint"};
    }

    const current = computeHunkSignature(diffText);
    const divergence = computeDivergence(current, stamp.anchorHunks);

    const stalePaths: string[] = [];
    for (const [path, hashes] of Object.entries(current)) {
        const seen = new Set(stamp.anchorHunks[path] ?? []);
        if (hashes.some((hash) => !seen.has(hash))) {
            stalePaths.push(path);
        }
    }

    return {status: "current", divergence, stalePaths: stalePaths.sort()};
};

/** Human-readable reason a refusal is a refusal; rendered into the PR comment. */
export const REFUSAL_REASONS: Readonly<
    Record<"no-review" | "no-fingerprint", string>
> = {
    "no-review":
        "no reviewer feedback has been posted on this PR yet, so there is " +
        "nothing to autofix. Push a commit (or re-run the reviewer) and label " +
        "again once a review exists.",
    "no-fingerprint":
        "the most recent review could not be matched to the current diff " +
        "(its fingerprint is unavailable, which happens on very large diffs). " +
        "Autofix will not edit code it cannot confirm was reviewed.",
};
