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
 * **Degrading, and why it is not a weakened guard.** An earlier version refused
 * outright whenever no fingerprint could be read. That made autofix unusable
 * against the reviewer as actually deployed: on Khan/webapp#41130 the reviewer
 * posted a correct blocking finding under a body of exactly "Changes requested
 * — see inline comments." and no stamp, and autofix refused every time.
 *
 * The fingerprint is not the only currency signal, and it is not even the
 * primary one. GitHub marks a review comment outdated when the diff hunk it
 * anchors to changes, which `worklist.ts` already reads (a null anchor is
 * dropped as `outdated-anchor`). That per-thread signal covers the case that
 * actually matters: the author edited the flagged code. The fingerprint adds
 * coarser file-level detection — "something else in this file moved" — whose
 * failure mode is a redundant fix that the following re-review catches.
 *
 * So the policy is: use the fingerprint when it is there, fall back to anchors
 * when it is not, and **say so in the summary** so a weaker check is never
 * silent. Refuse only when there is no review at all, which is the one state
 * where there is genuinely nothing to act on.
 */

import {
    computeDivergence,
    computeHunkSignature,
    findLatestStamp,
} from "../../review/lib/rereview-mode.ts";
import type {Divergence, PriorReview} from "../../review/lib/rereview-mode.ts";

export type CurrencyAssessment =
    | {
          /** The reviewer has never reviewed this PR; there is nothing to act on. */
          status: "no-review";
      }
    | {
          /**
           * Reviews exist but carry no usable fingerprint, so the file-level
           * check cannot run. This is NOT a refusal — see the note on degrading
           * below.
           */
          status: "unverifiable";
          why: "unstamped" | "overflow";
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
    // "No review at all" and "reviews exist but none carry a fingerprint" are
    // different facts and must not be collapsed. Collapsing them told the author
    // of Khan/webapp#41130 that "no reviewer feedback has been posted on this
    // PR", on a PR carrying a blocking finding that the reviewer had just
    // posted. The message was wrong because the state was wrong.
    if (reviews.length === 0) {
        return {status: "no-review"};
    }

    const stamp = findLatestStamp(reviews);
    if (stamp === null) {
        return {status: "unverifiable", why: "unstamped"};
    }
    if (stamp.anchorHunks === "overflow") {
        return {status: "unverifiable", why: "overflow"};
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
export const REFUSAL_REASONS: Readonly<Record<"no-review", string>> = {
    "no-review":
        "the reviewer has not reviewed this PR yet, so there is nothing to " +
        "autofix. Re-run the reviewer and arm autofix again once a review " +
        "exists.",
};

/**
 * What to tell the author when the file-level check could not run. Rendered into
 * the summary so a weaker check is never silent.
 */
export const DEGRADED_NOTES: Readonly<
    Record<"unstamped" | "overflow", string>
> = {
    unstamped:
        "The reviewer's review carries no diff fingerprint, so the file-level " +
        "currency check could not run; findings were checked against their " +
        "thread anchors only.",
    overflow:
        "The reviewer's diff fingerprint overflowed (very large diff), so the " +
        "file-level currency check could not run; findings were checked " +
        "against their thread anchors only.",
};
