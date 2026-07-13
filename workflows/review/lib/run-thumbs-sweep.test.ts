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
        {
            grain: "inline",
            commentId: 11,
            downvotes: 0,
            posted: false,
            reason: "no-downvote",
        },
        {
            grain: "summary",
            commentId: 22,
            downvotes: 2,
            posted: true,
            reason: "posted",
        },
        {
            grain: "inline",
            commentId: 33,
            downvotes: 1,
            posted: false,
            reason: "already-followed-up",
        },
    ],
    followupsPosted: 1,
};

describe("renderSweepSummary", () => {
    it("renders the tallies and the downvoted-comment table", () => {
        const markdown = renderSweepSummary(result, stats);

        expect(markdown).toContain("## Thumbs feedback sweep");
        expect(markdown).not.toContain("DRY RUN");
        expect(markdown).toContain(
            "Reviewer comments swept: **3** across 4 recently-active PRs",
        );
        expect(markdown).toContain("**5 positive / 2 negative**");
        expect(markdown).toContain("threads resolved: **3**");
        expect(markdown).toContain(
            "Follow-ups posted this sweep: **1** (already followed up: 1)",
        );
        expect(markdown).toContain("API requests used: 31");
        // Only the two downvoted comments appear in the table.
        expect(markdown).toContain("| summary | 22 | 2 | posted |");
        expect(markdown).toContain("| inline | 33 | 1 | already-followed-up |");
        expect(markdown).not.toContain("| inline | 11 |");
    });

    it("marks a dry run in the header", () => {
        const markdown = renderSweepSummary(result, stats, {dryRun: true});
        expect(markdown).toContain(
            "## Thumbs feedback sweep (DRY RUN — nothing was posted)",
        );
    });

    it("omits the table when nothing is downvoted", () => {
        const markdown = renderSweepSummary(
            {actions: [], followupsPosted: 0},
            {...stats, reactions: {positive: 0, negative: 0}},
        );
        expect(markdown).toContain("(already followed up: 0)");
        expect(markdown).not.toContain("| Grain |");
    });
});
