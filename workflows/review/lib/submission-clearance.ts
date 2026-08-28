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

import {parseRereviewStamp} from "./rereview-mode";
import type {ReReviewStamp} from "./rereview-mode";

/**
 * The dismissal justification for a reduced-depth clearance (the timeline
 * shows it verbatim under "dismissed the review"). Shared with the
 * post-step CLI (dismiss-review.ts) and the tests so the surfaces cannot
 * drift.
 */
export const DISMISSAL_MESSAGE =
    "All blocking review threads are resolved; approval still requires a full-roster review round.";

/**
 * THIS workflow's live standing CHANGES_REQUESTED review ids from a
 * chronological review list (`prior-reviews.json`, or the executor's live
 * fetch). Two scoping rules, both restrictive:
 *
 *   - Identity is the body's re-review stamp ({@link parseRereviewStamp}),
 *     not the login: every Actions workflow reviewing with the default
 *     token posts as the same `github-actions[bot]` account, and this
 *     predicate feeds an authenticated dismissal, so a foreign workflow's
 *     review must neither count as our standing block nor become a
 *     dismissal target. Only this workflow's CLI renders the stamp into
 *     every submitted body; pre-stamp-form reviews stop counting, which
 *     degrades toward more review (the block stands until a full round
 *     supersedes it with a genuine verdict).
 *   - GitHub derives a reviewer's effective state from its latest
 *     APPROVED/CHANGES_REQUESTED review, so an entry a later (stamped)
 *     APPROVED superseded is NOT standing; every CHANGES_REQUESTED after
 *     the last APPROVED is (dismissing only the newest would let an older
 *     one resurface as the effective state). A DISMISSED entry neither
 *     stands nor resets: an approval dismiss-stale-approvals dismissed no
 *     longer supersedes, so the older CHANGES_REQUESTED reads as standing
 *     again. Whether GitHub itself resurfaces that older block is not
 *     something we have verified in both directions, so the direction is
 *     chosen on asymmetric costs: if it does resurface and we reset, an
 *     author stays stranded behind a block no round clears; if it does
 *     not and we stand, the worst outcomes are a full-roster COMMENT
 *     round (zero blocking findings by construction) upgrading to the
 *     APPROVE that same roster stands behind, and a reduced round
 *     dismissing an inert review, which changes nothing.
 *
 * Entries without `id`/`state`/`body` (pre-upgrade staging) do not count.
 * Shared by the plan CLI, the dispatch gate's rule 5c, and the dismissal
 * executor so the three surfaces cannot drift.
 */
export const standingChangesRequestedIds = (
    priorReviewsRaw: unknown,
): number[] => {
    let standing: number[] = [];
    for (const entry of Array.isArray(priorReviewsRaw) ? priorReviewsRaw : []) {
        const {id, state, body} = (entry ?? {}) as {
            id?: unknown;
            state?: unknown;
            body?: unknown;
        };
        if (typeof body !== "string" || parseRereviewStamp(body) === null) {
            continue;
        }
        if (state === "APPROVED") {
            standing = [];
        } else if (state === "CHANGES_REQUESTED" && typeof id === "number") {
            standing.push(id);
        }
    }
    return standing;
};

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
    /**
     * True when the prior stamped verdict is REQUEST_CHANGES, or a
     * standing (unsuperseded) CHANGES_REQUESTED review is live on the PR
     * (the failed-dismissal recovery; see the derivation comment).
     */
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
    // An unrecognized depth reads as reduced here (demote: more review,
    // never less) while the gate's resolveDepth defaults unrecognized to
    // full, the strictest frame for ITS dispatch rules; each side degrades
    // toward safety in its own direction, so the demote mismatch is
    // deliberate. The dismissal is different: it requires an explicitly
    // recognized reduced depth, because a decision staged at a depth the
    // gate reads as full would be blocked as unlicensed (rule 5c), turning
    // two safe defaults into a red run.
    const fullRoster = input.depth === "full" || input.depth === "scoped";
    const reducedRoster =
        input.depth === "flip-gated" || input.depth === "fast";
    // The stamp alone is not enough: a reduced round's demoted COMMENT
    // stamps its own verdict inside the agent step, before the best-effort
    // dismissal post-step runs, so a failed dismissal would otherwise erase
    // the one signal that retries the clearance (or upgrades at full depth)
    // while the block still stands on GitHub. The live review state joins
    // the stamp; after a successful dismissal the entry reads DISMISSED and
    // the stamp is again the only carrier.
    const standingRcIds = standingChangesRequestedIds(input.priorReviewsRaw);
    const priorRcStands =
        (input.priorStamp !== null &&
            input.priorStamp.verdict === "REQUEST_CHANGES") ||
        standingRcIds.length > 0;

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
        reducedRoster &&
        priorRcStands &&
        event === "COMMENT" &&
        input.keptBlockingCount === 0 &&
        input.suppressedBlocking === 0;
    if (wantsRcDismissal) {
        const dismissIds = standingRcIds;
        if (dismissIds.length > 0) {
            dismissal = {reviewIds: dismissIds, message: DISMISSAL_MESSAGE};
            // Intent, not fact: the note posts from the safe_outputs job
            // regardless of whether the agent job's best-effort dismissal
            // post-step executed, so it must not assert the block cleared.
            bodyNote =
                "Note: every blocking objection is resolved; the standing request-changes review is being dismissed rather than approved (approval requires a full-roster review round; if the dismissal did not take effect, the block stands).";
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

const REVIEW_DIR = "/tmp/gh-aw/review";

/** The staged decision path (out/ is the one directory the run uploads). */
export const DISMISS_DECISION_PATH = `${REVIEW_DIR}/out/dismiss-decision.json`;

/** The write half's fs dependency (production passes `node:fs`). */
export type ClearanceFs = {
    writeFileSync: (p: string, data: string) => void;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
    existsSync: (p: string) => boolean;
    rmSync: (p: string, opts: {force: boolean}) => void;
};

/**
 * Write the decision file (or clear a stale one). The decision itself is
 * pure ({@link decideEventAndClearance}); this is its one write, kept
 * beside it so the caller cannot half-apply it. The clear matters: the
 * file is the dismissal executor's input and the gate's rule-5c subject,
 * so a decision staged by an earlier plan-CLI invocation in the same run
 * must not survive a later invocation that decided against it (it would
 * execute a dismissal the final plan never licensed, or red-flag a
 * conforming run at the gate).
 */
export const stageDismissalDecision = (
    fs: ClearanceFs,
    dismissal: ClearanceResult["dismissal"],
): void => {
    if (dismissal !== null) {
        fs.mkdirSync(`${REVIEW_DIR}/out`, {recursive: true});
        fs.writeFileSync(
            DISMISS_DECISION_PATH,
            JSON.stringify(dismissal, null, 2),
        );
    } else if (fs.existsSync(DISMISS_DECISION_PATH)) {
        fs.rmSync(DISMISS_DECISION_PATH, {force: true});
    }
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
 * Two shapes may queue nothing (neither while a standing block remains:
 * both judge "does the prior state still stand" on the same stamp-plus-
 * live-state evidence, and an APPROVE that would supersede a standing
 * CHANGES_REQUESTED is never redundant):
 *
 *   - The redundant-approval skip: an APPROVE with no inline comments
 *     whose body is exactly the bare approve line, on a PR whose last
 *     stamped verdict was already APPROVE and whose block is not
 *     standing.
 *   - The demoted-COMMENT skip, its reduced-depth sibling: a
 *     flip-gated/fast round whose verdict would have been APPROVE, with no
 *     inline comments, no thread resolutions, no standing block to clear,
 *     and nothing riding the body beyond the demoted head and the depth
 *     note, has nothing to say that the prior review does not already
 *     say, and posting a near-empty COMMENT review on every such push is
 *     the noise the quiet-the-human-surface lane exists to prevent. The
 *     body check matters for the same reason the first branch guards on
 *     `bareApproveBody`: the collapsed observations section and the
 *     mandatory shed/unavailable disclosure notes are content, and
 *     skipping a body that carries either withholds it on every later
 *     run (the drift that already shipped once). The prior stamp stays
 *     the anchor (a fast round carries it forward verbatim anyway), so
 *     skipping loses nothing.
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
    /**
     * Whether nothing rides the core body beyond the head and the depth
     * note: no collapsed observations section, no shed/unavailable
     * disclosure note, and no re-review accountability section (which
     * rides the head and renders non-empty whenever the round resolved or
     * kept threads, kept non-blocking ones included; submission.ts passes
     * all three checks). The demoted body always carries the COMMENT head
     * and the depth note, so it can never equal the bare approve line;
     * this is its own emptiness signal.
     */
    bodyCarriesOnlyDepthNote: boolean;
}): boolean =>
    (input.event === "APPROVE" &&
        input.inlineCount === 0 &&
        input.bareApproveBody &&
        input.priorApproveStands &&
        !input.priorRcStands) ||
    (input.approveDemoted &&
        input.inlineCount === 0 &&
        input.resolveCount === 0 &&
        input.bodyCarriesOnlyDepthNote &&
        !input.priorRcStands);
