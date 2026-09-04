/**
 * The review body's depth notes (Step 3): what the re-review planner decided
 * and why, in the fixed wording the body carries. Split from `submission.ts`
 * by the max-lines budget.
 *
 * Every field read from `rereview-plan.json` is validated before it is
 * interpolated into the posted body: the file is code-written but lives in
 * an agent-writable directory (the same boundary `runRereviewStampCli`
 * guards), so a string that is not one of the four modes renders nothing
 * rather than whatever the file says.
 */

import {RE_REVIEW_MODES} from "./routing-config";
import type {ReReviewMode} from "./routing-config";

/** The slice of the staged plan the notes read. */
export type DepthNotePlan = {
    mode?: unknown;
    manualDepth?: unknown;
    reasons?: unknown;
    tripwireRearmed?: unknown;
    divergence?: unknown;
};

/** The shape every planner reason code has (`mode-fast`, `no-prior-fingerprint`, ...). */
const REASON_CODE_RE = /^[a-z][a-z0-9-]{0,39}$/;

const asMode = (value: unknown): ReReviewMode | null =>
    typeof value === "string" &&
    (RE_REVIEW_MODES as readonly string[]).includes(value)
        ? (value as ReReviewMode)
        : null;

/**
 * Compose the depth notes for a run.
 *
 * - A reduced round says its depth and the dial that set it, naming the
 *   human's `/review <depth>` when that was the dial (the configured mode
 *   alone would not explain a scoped round under `fast`).
 * - A full round that a `/review <depth>` asked to reduce says so and gives
 *   the planner's last reason code, so the human can tell a guard (say,
 *   `no-prior-fingerprint`) from the below-dial rule; a token that named no
 *   mode is never recorded and gets no note.
 * - A re-armed tripwire reports its unreviewed share.
 */
export const renderDepthNotes = (
    plan: DepthNotePlan | undefined,
    depth: string,
    posting: {blockingOnly: boolean; blockingMedium: boolean},
): string[] => {
    if (plan === undefined) {
        return [];
    }
    const notes: string[] = [];
    const asked = asMode(plan.manualDepth);
    if (depth !== "full") {
        const mode = asMode(plan.mode) ?? "full";
        const ask = asked === null ? "" : `requested by /review ${asked}, `;
        const dial = posting.blockingOnly
            ? ", blocking-only"
            : posting.blockingMedium
            ? ", blocking-medium"
            : "";
        notes.push(
            `Note: re-review ran at ${depth} depth (${ask}re-review mode ${mode}${dial}).`,
        );
    } else if (asked !== null) {
        const reasons = Array.isArray(plan.reasons)
            ? plan.reasons.filter((r): r is string => typeof r === "string")
            : [];
        const raw = reasons[reasons.length - 1];
        // Fixed-format decision codes only (ReReviewPlan.reasons): the same
        // agent-writable boundary asMode guards for the two mode fields.
        const why =
            raw !== undefined && REASON_CODE_RE.test(raw) ? raw : undefined;
        notes.push(
            `Note: /review ${asked} was requested, this round ran at full depth${
                why === undefined ? "" : ` (${why})`
            }.`,
        );
    }
    if (plan.tripwireRearmed === true) {
        const share = (plan.divergence as {unreviewedShare?: unknown} | null)
            ?.unreviewedShare;
        notes.push(
            `Note: divergence tripwire re-armed a full review (unreviewed share ${
                typeof share === "number" ? share.toFixed(2) : "unknown"
            }).`,
        );
    }
    return notes;
};
