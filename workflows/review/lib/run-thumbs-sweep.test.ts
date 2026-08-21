import {describe, it, expect} from "vitest";

import {renderSweepSummary} from "./run-thumbs-sweep.ts";
import type {SweepResult} from "./thumbs-sweep.ts";
import type {SweepTraversalStats} from "./thumbs-sweep-github.ts";

const stats: SweepTraversalStats = {
    pullsScanned: 4,
    apiRequests: 31,
    reactions: {positive: 5, negative: 2},
    resolvedInlineThreads: 3,
};

const result: SweepResult = {
    actions: [
        {grain: "inline", commentId: 11, downvotes: 0, confused: 0},
        {grain: "summary", commentId: 22, downvotes: 2, confused: 0},
        {grain: "inline", commentId: 33, downvotes: 1, confused: 1},
        {grain: "inline", commentId: 44, downvotes: 0, confused: 1},
    ],
    downvotedComments: 2,
    confusedComments: 2,
};

describe("renderSweepSummary", () => {
    it("renders the tallies and the flagged-comment table, 👎 and 😕 separate", () => {
        const markdown = renderSweepSummary(result, stats);

        expect(markdown).toContain("## Thumbs feedback sweep");
        expect(markdown).toContain(
            "Reviewer comments swept: **4** across 4 recently-active PRs",
        );
        expect(markdown).toContain("**5 positive / 2 negative**");
        expect(markdown).toContain("threads resolved: **3**");
        expect(markdown).toContain(
            "Comments currently downvoted: **2** (👎), unclear: **2** (😕)",
        );
        expect(markdown).toContain("API requests used: 31");
        // Downvoted and confused comments appear; the untouched one does not.
        expect(markdown).toContain("| summary | 22 | 2 | 0 |");
        expect(markdown).toContain("| inline | 33 | 1 | 1 |");
        expect(markdown).toContain("| inline | 44 | 0 | 1 |");
        expect(markdown).not.toContain("| inline | 11 |");
    });

    it("omits the table when nothing is downvoted or unclear", () => {
        const markdown = renderSweepSummary(
            {actions: [], downvotedComments: 0, confusedComments: 0},
            {...stats, reactions: {positive: 0, negative: 0}},
        );
        expect(markdown).toContain(
            "Comments currently downvoted: **0** (👎), unclear: **0** (😕)",
        );
        expect(markdown).not.toContain("| Grain |");
    });
});
