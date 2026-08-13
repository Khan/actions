import {describe, it, expect} from "vitest";

import {
    adjudicatedThreadsFromStaged,
    suppressAdjudicatedDuplicates,
    suppressTrackedDuplicates,
} from "./dedup-adjudicated";
import type {Claim} from "./dispatch-contracts";

/**
 * Adjudicated-thread suppression tests, split from dedup.test.ts for its
 * max-lines budget (the dedup-cluster.test.ts precedent); the `claim` factory
 * mirrors that file's. The scenario throughout is webapp#41290's: a human
 * resolved the bot's thread, and a later run re-derived the same defect with
 * fresh wording at a nearby line, which the adjudicated corpus must absorb
 * without ever absorbing a blocking regression re-flag.
 */

const claim = (over: Partial<Claim> & {id: string; source: string}): Claim => ({
    path: "services/ai-guide/memory/expiration.go",
    line: 38,
    label: "issue (blocking)",
    subject: "s",
    discussion: "d",
    failure_scenario: "f",
    confidence: 0.7,
    ...over,
});

describe("adjudicatedThreadsFromStaged", () => {
    const adjudicated = (over: Record<string, unknown> = {}) => ({
        thread_id: "T1",
        path: "a.ts",
        resolved: true,
        resolvedBy: "sxkosone",
        comments: [
            {
                author: "github-actions",
                body: "**suggestion (non-blocking):** opener",
            },
        ],
        ...over,
    });

    it("admits only bot-opened threads a human resolved", () => {
        expect(adjudicatedThreadsFromStaged([adjudicated()])).toEqual([
            {
                thread_id: "T1",
                path: "a.ts",
                body: "**suggestion (non-blocking):** opener",
            },
        ]);
    });

    it("fails closed on every guard: unresolved, bot-resolved, unattributable resolver, human opener, malformed staging", () => {
        // Each rejected shape degrades to a duplicate comment, never to a
        // suppression the staging cannot justify: this corpus grants the
        // strongest suppression in the pipeline (a human's explicit "settled"
        // outlives rephrasings), so membership must be unmanufacturable.
        const rejected: unknown[] = [
            adjudicated({resolved: false}),
            adjudicated({resolved: undefined}),
            adjudicated({resolved: "true"}),
            // The bot resolving its own thread is the reconciler marking a
            // defect FIXED; a fixed defect that reappears is a fresh finding.
            adjudicated({resolvedBy: "github-actions"}),
            adjudicated({resolvedBy: "github-actions[bot]"}),
            adjudicated({resolvedBy: ""}),
            adjudicated({resolvedBy: undefined}),
            adjudicated({
                comments: [{author: "jwbron", body: "human opener"}],
            }),
            adjudicated({comments: []}),
            adjudicated({thread_id: undefined}),
            "not a record",
        ];
        for (const thread of rejected) {
            expect(adjudicatedThreadsFromStaged([thread])).toEqual([]);
        }
        expect(adjudicatedThreadsFromStaged(undefined)).toEqual([]);
        expect(adjudicatedThreadsFromStaged({not: "an array"})).toEqual([]);
    });
});

describe("suppressAdjudicatedDuplicates", () => {
    const adjudicatedThread = (over: Record<string, unknown> = {}) => ({
        thread_id: "T-adj",
        path: "services/ai-guide/memory/expiration.go",
        body: "**suggestion (non-blocking):** No test exercises the deletion path: TestExpiration only asserts that expired keys are identified, so a regression that identifies but never deletes expired memories stays green.",
        ...over,
    });
    const rederivation = (over: Partial<Claim> = {}) =>
        claim({
            id: "correctness-reviewer-2",
            source: "correctness-reviewer",
            line: 42,
            label: "suggestion (non-blocking)",
            subject:
                "Missing deletion test: the expiration path has no test covering the delete.",
            discussion:
                "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
            failure_scenario:
                "A regression that identifies expired memories but skips the deletion is not caught by TestExpiration and ships green.",
            ...over,
        });

    it("suppresses a non-blocking re-derivation of an adjudicated defect, marked as adjudicated", () => {
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [rederivation()],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([]);
        expect(suppressed).toEqual([
            {
                id: "correctness-reviewer-2",
                source: "correctness-reviewer",
                label: "suggestion (non-blocking)",
                path: "services/ai-guide/memory/expiration.go",
                line: 42,
                thread_id: "T-adj",
                threadBlocking: false,
                adjudicated: true,
            },
        ]);
    });

    it("never suppresses a blocking candidate: a regression re-flag must stay visible", () => {
        // The adjudicated thread is closed and floors nothing, so suppressing
        // a blocker on it would let a re-confirmed blocking defect vanish
        // without a trace. This asymmetry is also the regression escape
        // hatch: a fixed-then-regressed defect worth stopping the PR for
        // re-presents at blocking severity and posts.
        const blocking = rederivation({label: "issue (blocking)"});
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [blocking],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([blocking]);
        expect(suppressed).toEqual([]);
    });

    it("keeps unrelated and pathless claims, and everything when the corpus is empty", () => {
        const unrelated = rederivation({
            subject: "Retention window subtracts months, not days.",
            discussion:
                "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months so the window never expires anything.",
            failure_scenario:
                "Memories never expire because the cutoff is 15 years in the past.",
        });
        const pathless = rederivation({path: undefined, line: undefined});
        const empty = suppressAdjudicatedDuplicates([rederivation()], []);
        expect(empty.kept).toHaveLength(1);
        expect(empty.suppressed).toEqual([]);
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [unrelated, pathless],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([unrelated, pathless]);
        expect(suppressed).toEqual([]);
    });

    it("attributes a candidate matching BOTH corpora to the OPEN thread (the verdict floor reads its blocking state)", () => {
        // The composed pass order is the guarantee dispatch.ts relies on: the
        // open corpus runs first, so a defect that is simultaneously tracked
        // by an open thread and settled on an older resolved one suppresses
        // against the OPEN thread, whose blocking state floors the verdict.
        const openStaged = [
            {
                thread_id: "T-open",
                path: "services/ai-guide/memory/expiration.go",
                resolved: false,
                comments: [
                    {
                        author: "github-actions",
                        body: adjudicatedThread().body,
                    },
                ],
            },
        ];
        const adjudicatedStaged = [
            {
                thread_id: "T-adj",
                path: "services/ai-guide/memory/expiration.go",
                resolved: true,
                resolvedBy: "octo",
                comments: [
                    {
                        author: "github-actions",
                        body: adjudicatedThread().body,
                    },
                ],
            },
        ];
        const result = suppressTrackedDuplicates(
            [rederivation()],
            openStaged,
            adjudicatedStaged,
            new Set(),
        );
        expect(result.kept).toEqual([]);
        expect(result.suppressed).toHaveLength(1);
        expect(result.suppressed[0].thread_id).toBe("T-open");
        expect(result.suppressed[0].adjudicated).toBeUndefined();
        expect(result.shapeFailure).toBeUndefined();
    });
});
