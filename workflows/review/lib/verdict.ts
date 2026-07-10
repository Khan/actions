/**
 * The computed review verdict.
 *
 * The verdict is a pure function of (1) the Conventional-Comment labels on the
 * comments that will actually be posted, (2) which review dimensions were
 * assessed this run, and (3) any policy-named conflicts a lens flagged. It emits
 * one of three events with a machine-readable list of reasons. No prose is
 * synthesised here: reasons are structured records, not
 * sentences about the code.
 *
 * Relationship to #194: #194 already established the *mechanical label model* —
 * REQUEST_CHANGES iff at least one posted comment carries a blocking label,
 * APPROVE otherwise. This module CONSUMES that rule (via
 * {@link isBlockingLabel}); it does not re-implement label assignment. What it
 * ADDS on top is the third outcome the pipeline needs:
 *
 *   - HOLD_FOR_HUMAN when a *core* review dimension (correctness or the
 *     skill/severity pass) produced no output and the run would otherwise have
 *     auto-approved: never approve a change a core dimension never looked at.
 *     This is the gate *on top of* #194's visibility-only skipped-dimension note
 *     (`review.md` Step 6): #194 surfaces the gap in the body; this refuses to
 *     let the run resolve to APPROVE on a partial assessment.
 *   - HOLD_FOR_HUMAN when a lens flags a policy-named conflict it cannot
 *     adjudicate (e.g. two policies that disagree) — a human decides, again only
 *     where the alternative would have been an auto-approval.
 *
 * The hold never withholds actionable feedback: with blocking findings present
 * the verdict stays REQUEST_CHANGES (the author already has concrete changes to
 * make, and the re-review after those changes retries the failed dimension),
 * with the missing dimension or conflict still recorded in `reasons` and
 * rendered into the review body.
 *
 * A lost *pattern-triage* pass does NOT hold: it is note-and-continue (surfaced
 * as a reason and via `review.md`'s skipped-dimension note).
 *
 * Verdicts follow the labels on the *posted* set specifically because
 * `claim-validator` and the newly-changed-code scope filter (both upstream, in
 * `review.md` Step 3) can drop or downgrade a candidate before it is posted;
 * this module is handed the final labels, so it never needs the raw findings to
 * decide blocking. Callers derive those labels from findings via
 * `labelForFinding` in `render-comment.ts`.
 */

import {isBlockingLabel} from "./render-comment";
import type {VerdictEvent} from "./render-comment";

export type {VerdictEvent} from "./render-comment";

/**
 * The two dimensions whose absence forces a hold. Named to match the
 * review passes: `correctness` (the correctness reviewer) and `skill-severity`
 * (the skill/severity pass).
 */
export type CoreDimension = "correctness" | "skill-severity";

/** Whether a review dimension produced usable output this run. */
export type DimensionStatus = "assessed" | "unavailable";

/**
 * Availability of the dimensions the verdict cares about. `correctness` and
 * `skillSeverity` are core (their absence -> HOLD_FOR_HUMAN); `patternTriage` is
 * non-core (its absence -> note-and-continue, never a hold).
 */
export type DimensionReport = {
    correctness: DimensionStatus;
    skillSeverity: DimensionStatus;
    patternTriage: DimensionStatus;
};

/**
 * A conflict between named policies that a lens surfaced but could not resolve.
 * `detail` is text the lens/model authored describing the conflict — it is
 * passed through untouched (this module never composes it), so surfacing it in a
 * reason does not cross the prose boundary.
 */
export type PolicyConflict = {
    /** The policy (or the pair of policies) in conflict. */
    policy: string;
    /** Model-authored description of the conflict, passed through verbatim. */
    detail: string;
};

/** A single, structured reason contributing to the verdict. */
export type VerdictReason =
    | {code: "blocking-label"; label: string}
    | {code: "core-dimension-unavailable"; dimension: CoreDimension}
    | {code: "pattern-triage-unavailable"}
    | {code: "policy-conflict"; policy: string; detail: string};

export type Verdict = {
    event: VerdictEvent;
    reasons: VerdictReason[];
};

export type VerdictInput = {
    /**
     * Conventional-Comment labels of the comments that will actually be posted,
     * after the scope filter and `claim-validator` corrections. Blocking is
     * decided from these (#194's rule).
     */
    postedLabels: readonly string[];
    /** Availability of the core + pattern-triage dimensions this run. */
    dimensions: DimensionReport;
    /** Policy-named conflicts requiring human adjudication (optional). */
    policyConflicts?: readonly PolicyConflict[];
    /**
     * Blocking-label count at or above which the run is REQUEST_CHANGES. See
     * {@link DEFAULT_BLOCKING_THRESHOLD}. A run with zero blocking labels is
     * never REQUEST_CHANGES regardless of this value.
     */
    blockingThreshold?: number;
};

/**
 * Default blocking threshold: a *single* blocking label is enough to request
 * changes.
 *
 * Rationale: #194's
 * established mechanical model is "REQUEST_CHANGES iff at least one posted
 * comment carries a blocking label" — i.e. a threshold of 1. We keep that exact
 * behaviour as the launch default so this module is a faithful consumer of #194
 * rather than a re-tuning of it. A blocking finding is, by construction (see
 * `review.md` "What should carry a blocking label"), a defect CI would not
 * catch; there is no principled reason to let one such defect through, so the
 * threshold is 1 and not higher.
 *
 * It is exposed as a tunable input so the eval suite can experiment with a
 * higher bar without a code change. Values < 1 are treated as 1 (a run with blocking labels always
 * blocks; a run without them never does).
 */
export const DEFAULT_BLOCKING_THRESHOLD = 1;

/**
 * Compute the review verdict. Pure: no I/O, no clock, no randomness — the same
 * input always yields the same verdict, which is what makes the determinism
 * boundary testable.
 *
 * Precedence is REQUEST_CHANGES > HOLD_FOR_HUMAN > APPROVE:
 *
 *   1. If the blocking-label count meets the threshold -> REQUEST_CHANGES. A
 *      blocking finding is actionable on its own: the author gets concrete
 *      changes to make even when another dimension failed, and the re-review
 *      after those changes retries the failed dimension anyway. Any missing
 *      core dimension or policy conflict is still recorded in `reasons` (and
 *      rendered into the body), so nothing is hidden.
 *   2. Otherwise, if any core dimension is unavailable or any policy conflict
 *      is present, the run must not resolve to an approval the automation
 *      cannot stand behind -> HOLD_FOR_HUMAN.
 *   3. Otherwise -> APPROVE.
 *
 * The hold therefore only ever replaces what would otherwise have been an
 * auto-approval; it never sits in front of feedback the author could already
 * act on.
 */
export const computeVerdict = (input: VerdictInput): Verdict => {
    const threshold = Math.max(
        1,
        input.blockingThreshold ?? DEFAULT_BLOCKING_THRESHOLD,
    );
    const reasons: VerdictReason[] = [];

    // (a) Blocking labels — the #194 mechanical signal.
    const blockingLabelCount = input.postedLabels.reduce((count, label) => {
        if (isBlockingLabel(label)) {
            reasons.push({code: "blocking-label", label});
            return count + 1;
        }
        return count;
    }, 0);

    // (b) Core-dimension gate.
    const missingCore: CoreDimension[] = [];
    if (input.dimensions.correctness === "unavailable") {
        missingCore.push("correctness");
    }
    if (input.dimensions.skillSeverity === "unavailable") {
        missingCore.push("skill-severity");
    }
    for (const dimension of missingCore) {
        reasons.push({code: "core-dimension-unavailable", dimension});
    }

    // (c) Lost pattern-triage — note-and-continue, never a hold.
    if (input.dimensions.patternTriage === "unavailable") {
        reasons.push({code: "pattern-triage-unavailable"});
    }

    // (d) Policy-named conflicts — human adjudicates.
    const policyConflicts = input.policyConflicts ?? [];
    for (const {policy, detail} of policyConflicts) {
        reasons.push({code: "policy-conflict", policy, detail});
    }

    // Precedence: a blocking finding is actionable on its own, so it wins.
    // A run with zero blocking labels is never REQUEST_CHANGES (review.md Step 4).
    if (blockingLabelCount > 0 && blockingLabelCount >= threshold) {
        return {event: "REQUEST_CHANGES", reasons};
    }

    // The hold only ever replaces what would otherwise be an auto-approval.
    if (missingCore.length > 0 || policyConflicts.length > 0) {
        return {event: "HOLD_FOR_HUMAN", reasons};
    }

    return {event: "APPROVE", reasons};
};
