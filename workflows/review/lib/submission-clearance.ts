/**
 * The full-roster approval rule and the reduced-depth clearance,
 * split out of submission.ts for the same reason every sibling split
 * happened (the shared eslint config caps a file at 1000 lines and
 * submission.ts sat at exactly 1000): one concern per module, no behavior
 * change at the callsite.
 *
 * An APPROVE is a statement that the enabled roster looked, so only the
 * depths that dispatch it (`full`, `scoped`; dispatch "all") may submit
 * one. At flip-gated/fast the roster is reconciliation plus at most the
 * correctness pass, and a would-be APPROVE demotes to COMMENT; a standing
 * block those depths earned back is cleared by a staged dismissal decision
 * (`out/dismiss-decision.json`, executed by the deterministic post-step,
 * dismiss-review.ts), never by minting an approval no full roster stands
 * behind (the 08-18 false-resolution reopen on webapp#41358 is what an
 * unreviewed reduced-depth approval looks like when the reconciler is
 * wrong).
 *
 * A COMMENT cannot clear this workflow's own prior REQUEST_CHANGES:
 * GitHub derives a reviewer's state only from its latest APPROVE or
 * REQUEST_CHANGES. So when the prior stamped verdict is REQUEST_CHANGES
 * and this run's blocking objections are all resolved (a COMMENT verdict
 * implies exactly that: zero blocking labels AND zero kept blocking
 * threads), a full-roster run approves instead, or the author stays
 * blocked by a stale state their fixes already earned back. A
 * reduced-depth run keeps the COMMENT and stages the dismissal decision.
 *
 * Determinism boundary: a pure function of the verdict, the depth, and the
 * staged prior reviews; the caller does the writes. No model call, no
 * prose about the code under review.
 */

import type {ReReviewStamp} from "./rereview-mode";

/**
 * The dismissal justification for a reduced-depth clearance (the timeline
 * shows it verbatim under "dismissed the review"). Shared with the
 * post-step CLI (dismiss-review.ts) and the tests so the surfaces cannot
 * drift.
 */
export const DISMISSAL_MESSAGE =
    "All blocking review threads are resolved; approval still requires a full-roster review round.";

export type ClearanceInput = {
    /** computeVerdict's event (the hold path returns before this runs). */
    verdictEvent: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
    /** The executed depth (dispatch-result.json). */
    depth: string;
    /** The most recent stamped fingerprint, or null. */
    priorStamp: ReReviewStamp | null;
    /** Parsed `prior-reviews.json`, unfiltered (the id/state source). */
    priorReviewsRaw: unknown;
    /** `rereview.json`'s keptBlockingCount. */
    keptBlockingCount: number;
    /** Blocking suppressions matched to blocking threads (submission.ts). */
    suppressedBlocking: number;
};

export type ClearanceResult = {
    /** The event to submit after the full-roster rule. */
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
    /** True when a reduced depth demoted a would-be APPROVE. */
    approveDemoted: boolean;
    /** True when the prior stamped verdict is REQUEST_CHANGES. */
    priorRcStands: boolean;
    /** Artifact-only observations for the plan's notes. */
    notes: string[];
    /** A `Note:` line for the review body when a dismissal stages. */
    bodyNote: string | null;
    /** The dismissal decision to stage, or null (the common case). */
    dismissal: {reviewIds: number[]; message: string} | null;
};

/**
 * Decide the submitted event and the reduced-depth clearance. Pure. The
 * kept/suppressed checks are redundant with the verdict floor (kept
 * blocking forces REQUEST_CHANGES at reduced depths) and stay as defense
 * in depth. A staging without review ids (pre-upgrade stage-pr) yields no
 * dismissal: the block stands, degrading toward more review. Never a safe
 * output: the pinned gh-aw (v0.85.4) ships no dismiss output, and
 * `supersede-older-reviews` fires on every replacement review,
 * kept-blocking rounds included.
 */
export const decideEventAndClearance = (
    input: ClearanceInput,
): ClearanceResult => {
    const notes: string[] = [];
    const fullRoster = input.depth === "full" || input.depth === "scoped";
    const priorRcStands =
        input.priorStamp !== null &&
        input.priorStamp.verdict === "REQUEST_CHANGES";

    const commentWouldStrandPriorRc =
        input.verdictEvent === "COMMENT" && priorRcStands && fullRoster;
    if (commentWouldStrandPriorRc) {
        notes.push(
            "COMMENT verdict upgraded to APPROVE: a comment cannot clear the prior request-changes state, and every blocking objection is resolved",
        );
    }
    const approveDemoted = !fullRoster && input.verdictEvent === "APPROVE";
    if (approveDemoted) {
        notes.push(
            `APPROVE demoted to COMMENT: approval requires a full-roster review, and this run dispatched ${input.depth} depth`,
        );
    }
    const event =
        input.verdictEvent === "REQUEST_CHANGES"
            ? "REQUEST_CHANGES"
            : approveDemoted ||
              (input.verdictEvent === "COMMENT" && !commentWouldStrandPriorRc)
            ? "COMMENT"
            : "APPROVE";

    let bodyNote: string | null = null;
    let dismissal: ClearanceResult["dismissal"] = null;
    const wantsRcDismissal =
        !fullRoster &&
        priorRcStands &&
        event === "COMMENT" &&
        input.keptBlockingCount === 0 &&
        input.suppressedBlocking === 0;
    if (wantsRcDismissal) {
        const dismissIds = (
            Array.isArray(input.priorReviewsRaw) ? input.priorReviewsRaw : []
        )
            .filter(
                (entry): entry is {id: number; state: string} =>
                    typeof (entry as {id?: unknown}).id === "number" &&
                    (entry as {state?: unknown}).state === "CHANGES_REQUESTED",
            )
            .map((entry) => entry.id);
        if (dismissIds.length > 0) {
            dismissal = {reviewIds: dismissIds, message: DISMISSAL_MESSAGE};
            bodyNote =
                "Note: every blocking objection is resolved; the standing request-changes review is dismissed rather than approved (approval requires a full-roster review round).";
            notes.push(
                `dismissal staged for prior request-changes review(s) ${dismissIds.join(
                    ", ",
                )}`,
            );
        } else {
            notes.push(
                "prior request-changes stands: prior-reviews.json carries no dismissable review id (older staging)",
            );
        }
    }

    return {event, approveDemoted, priorRcStands, notes, bodyNote, dismissal};
};

/**
 * The submission-skip predicate, code-owned so the prompt (Step 6) and the
 * conformance gate read one predicate rather than each describing it (they
 * diverged once, over the collapsed low-confidence `<details>` section
 * riding the body: neither a `Note:` line nor an accountability section,
 * so the prompt's old wording let the orchestrator skip a submission the
 * gate then red-flagged, withholding the approval AND the observations on
 * every later run).
 *
 * Two shapes may queue nothing:
 *
 *   - The redundant-approval skip: an APPROVE with no inline comments
 *     whose body is exactly the bare approve line, on a PR whose last
 *     stamped verdict was already APPROVE.
 *   - The demoted-COMMENT skip, its reduced-depth sibling: a
 *     flip-gated/fast round whose verdict would have been APPROVE, with no
 *     inline comments, no thread resolutions, and no standing block to
 *     clear, has nothing to say that the prior review does not already
 *     say, and posting a near-empty COMMENT review on every such push is
 *     the noise the quiet-the-human-surface lane exists to prevent. The
 *     prior stamp stays the anchor (a fast round carries it forward
 *     verbatim anyway), so skipping loses nothing.
 */
export const decideSkipSubmission = (input: {
    event: string;
    approveDemoted: boolean;
    priorRcStands: boolean;
    inlineCount: number;
    resolveCount: number;
    /** Whether the rendered core body is exactly the bare approve line. */
    bareApproveBody: boolean;
    /** Whether the last stamped verdict was APPROVE. */
    priorApproveStands: boolean;
}): boolean =>
    (input.event === "APPROVE" &&
        input.inlineCount === 0 &&
        input.bareApproveBody &&
        input.priorApproveStands) ||
    (input.approveDemoted &&
        input.inlineCount === 0 &&
        input.resolveCount === 0 &&
        !input.priorRcStands);
