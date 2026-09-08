import {buildClaims} from "../lib/dispatch-contracts";
import {selectPostingClaims} from "../lib/posting-selection";
import {
    renderClaimComment,
    renderCollapsedLine,
} from "../lib/submission-render";
import type {RunCandidate} from "./runner";

export type PostingOptions = {
    depth: string;
    nonBlockingInlineBudget?: unknown;
    blockingOnly?: boolean;
    blockingMedium?: boolean;
};

/** Use production's allocation rules, retaining collapsed claims for scoring. */
export const livePosting = (
    candidates: RunCandidate[],
    options: PostingOptions,
    hold: boolean,
) => {
    const claims = buildClaims(candidates);
    const anchored = claims.filter(
        (c) => c.path !== undefined && c.line !== undefined,
    );
    const prLevel = claims.filter(
        (c) => c.path === undefined || c.line === undefined,
    );
    const selected = selectPostingClaims(anchored, prLevel, {
        nonBlockingInlineBudget: options.nonBlockingInlineBudget,
        blockingOnly: options.depth !== "full" && options.blockingOnly === true,
        blockingMedium:
            options.depth !== "full" && options.blockingMedium === true,
    });
    const inline = hold ? [] : selected.inlineList;
    const collapsed = hold ? claims : selected.collapsed;
    return {
        inlineIds: inline.map((c) => c.id),
        collapsedIds: collapsed.map((c) => c.id),
        comments: inline.map((c) => ({
            path: c.path!,
            line: c.line!,
            body: renderClaimComment(c),
        })),
        body:
            collapsed.length === 0
                ? ""
                : [
                      "<details>",
                      `<summary>Collapsed observations (${collapsed.length})</summary>`,
                      "",
                      ...collapsed.map(renderCollapsedLine),
                      "",
                      "</details>",
                  ].join("\n"),
    };
};
