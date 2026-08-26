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
 * collapsed `<details>` block in its body, precisely because that record
 * survives when cache memory does not (`review.md` Step 6;
 * `rereview-mode.ts`). Comparing the
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
 * **Which reviews carry a stamp.** The stamp was an HTML comment for its
 * whole pre-2026-08 history, and gh-aw's safe-output ingest sanitizer strips
 * every XML/HTML comment before a review posts (`removeXmlComments` in
 * `sanitize_content_core.cjs`, a depth-tracking scan with no allowlist), so
 * no review posted in that window carries a fingerprint; Khan/actions#287
 * documents it end to end. The stamp now posts as a collapsed `<details>`
 * block (webapp#41742 was the failure; `rereview-mode.ts` has the carrier
 * story), so reviews from that reviewer release on stamp normally and the
 * fingerprint branch below is LIVE for them. Unstamped stays common, not
 * exceptional: every pre-fix body, and any body a consumer's pinned older
 * reviewer posts.
 *
 * The reviewer's second carrier, its cache-memory record, is not available
 * here: cache memory is scoped per workflow, and autofix is a different
 * workflow from the reviewer, so it cannot read the reviewer's. (It is dead
 * on the reviewer's side too for /review-triggered runs: GitHub's 2026-06-30
 * cache policy denies cache writes from issue_comment-triggered runs.)
 *
 * **Degrading, and why it is not a weakened guard.** An earlier version refused
 * outright whenever no fingerprint could be read, which given the above made
 * autofix refuse every real run: on Khan/webapp#41130 the reviewer posted a
 * correct blocking finding under a body of exactly "Changes requested
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
          why: "unstamped" | "overflow" | "unreadable-diff";
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
 * `diffText` is the PR's full diff, NOT the reviewer's generated-file-stripped
 * copy, so a lockfile or bundle churning after the review does appear in the
 * signature and does land in `stalePaths`. That is harmless here and the
 * asymmetry is deliberate: `plan.ts` consults `stalePaths` only for paths that
 * carry a finding, and the reviewer does not raise findings on generated files,
 * so a stale generated path can never drop real work. Stripping would mean
 * threading the router's `generatedFiles` through staging to buy nothing.
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

    // A signature with no paths means the diff told us nothing: it was empty,
    // or it carried no `diff --git`/`---`/`+++` headers for `splitUnifiedDiff`
    // to recognise a file section from. Falling through would make the
    // stale-path loop vacuous and return `current` with zero stale paths and no
    // note, i.e. the guard would report a clean full check having performed
    // none. That is the one failure direction this module must not have, so an
    // unreadable diff degrades like any other unusable input.
    if (Object.keys(current).length === 0) {
        return {status: "unverifiable", why: "unreadable-diff"};
    }

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
    Record<"unstamped" | "overflow" | "unreadable-diff", string>
> = {
    "unreadable-diff":
        "The PR's diff could not be parsed, so the file-level currency check " +
        "could not run; findings were checked against their thread anchors " +
        "only.",
    unstamped:
        "The reviewer's review carries no diff fingerprint, so the file-level " +
        "currency check could not run; findings were checked against their " +
        "thread anchors only.",
    overflow:
        "The reviewer's diff fingerprint overflowed (very large diff), so the " +
        "file-level currency check could not run; findings were checked " +
        "against their thread anchors only.",
};
