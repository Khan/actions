import type {Claim} from "./dispatch-contracts";
import {isBlockingLabel, NITPICK_LABEL} from "./render-comment";
import {DEFAULT_NON_BLOCKING_INLINE_BUDGET} from "./routing-config";
import {labelToken} from "./submission-render";

/** Must match the review.md create-pull-request-review-comment maximum. */
export const MAX_INLINE_COMMENTS = 20;
const MIN_INLINE_CONFIDENCE = 0.5;

/** Rank and allocate inline slots without discarding collapsed findings. */
export const selectPostingClaims = (
    anchored: Claim[],
    prLevelCollapsed: Claim[],
    options: {
        nonBlockingInlineBudget?: unknown;
        blockingOnly?: boolean;
        blockingMedium?: boolean;
    },
) => {
    const budgetRaw = options.nonBlockingInlineBudget;
    const nonBlockingBudget =
        typeof budgetRaw === "number" &&
        Number.isInteger(budgetRaw) &&
        budgetRaw >= 0
            ? budgetRaw
            : DEFAULT_NON_BLOCKING_INLINE_BUDGET;
    const isNitpick = (claim: Claim): boolean =>
        labelToken(claim.label) === labelToken(NITPICK_LABEL);
    const rankClaims = (a: Claim, b: Claim): number => {
        const blocking =
            Number(isBlockingLabel(b.label)) - Number(isBlockingLabel(a.label));
        if (blocking !== 0) {
            return blocking;
        }
        const medium =
            Number(b.importance === "medium") -
            Number(a.importance === "medium");
        if (medium !== 0) {
            return medium;
        }
        const nitpick = Number(isNitpick(a)) - Number(isNitpick(b));
        return nitpick !== 0 ? nitpick : b.confidence - a.confidence;
    };
    const ranked = [...anchored].sort(rankClaims);
    let budgetLeft = nonBlockingBudget;
    let budgetShed = 0;
    let nitpickShed = 0;
    const inlineWorthy = ranked.filter((claim) => {
        if (isBlockingLabel(claim.label)) {
            return true;
        }
        if (options.blockingOnly || claim.confidence < MIN_INLINE_CONFIDENCE) {
            return false;
        }
        if (options.blockingMedium && claim.importance !== "medium") {
            return false;
        }
        if (isNitpick(claim)) {
            nitpickShed++;
            return false;
        }
        if (budgetLeft > 0) {
            budgetLeft--;
            return true;
        }
        budgetShed++;
        return false;
    });
    const inlineClaims = new Set(inlineWorthy.slice(0, MAX_INLINE_COMMENTS));
    const collapsed = [
        ...ranked.filter((claim) => !inlineClaims.has(claim)),
        ...prLevelCollapsed,
    ].sort(rankClaims);
    const inlineList = [...inlineClaims];
    return {inlineList, collapsed, nonBlockingBudget, budgetShed, nitpickShed};
};
