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
        {grain: "inline", commentId: 11, downvotes: 0},
        {grain: "summary", commentId: 22, downvotes: 2},
        {grain: "inline", commentId: 33, downvotes: 1},
    ],
    downvotedComments: 2,
};

describe("renderSweepSummary", () => {
    it("renders the tallies and the downvoted-comment table", () => {
        const markdown = renderSweepSummary(result, stats);

        expect(markdown).toContain("## Thumbs feedback sweep");
        expect(markdown).toContain(
            "Reviewer comments swept: **3** across 4 recently-active PRs",
        );
        expect(markdown).toContain("**5 positive / 2 negative**");
        expect(markdown).toContain("threads resolved: **3**");
        expect(markdown).toContain("Comments currently downvoted: **2**");
        expect(markdown).toContain("API requests used: 31");
        // Only the two downvoted comments appear in the table.
        expect(markdown).toContain("| summary | 22 | 2 |");
        expect(markdown).toContain("| inline | 33 | 1 |");
        expect(markdown).not.toContain("| inline | 11 |");
    });

    it("omits the table when nothing is downvoted", () => {
        const markdown = renderSweepSummary(
            {actions: [], downvotedComments: 0},
            {...stats, reactions: {positive: 0, negative: 0}},
        );
        expect(markdown).toContain("Comments currently downvoted: **0**");
        expect(markdown).not.toContain("| Grain |");
    });
});
