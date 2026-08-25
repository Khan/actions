import {describe, it, expect} from "vitest";

import {
    adjudicatedThreadsFromStaged,
    suppressAdjudicatedDuplicates,
    suppressTrackedDuplicates,
} from "./dedup-adjudicated";
import {suppressOpenThreadDuplicates} from "./dedup-threads";
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

    it("admits a bot thread whose opener a reviewer downvoted, whatever its resolution state", () => {
        // The 👎 channel: the same judgment as resolving, delivered through
        // the reaction the retired thumbs sweep used to advertise. Resolution
        // state does not
        // gate it; a still-open downvoted thread is also in the open corpus,
        // and the composed pass attributes a double match to the open thread.
        for (const state of [
            {resolved: false, resolvedBy: ""},
            {resolved: true, resolvedBy: "github-actions"},
            {resolved: undefined, resolvedBy: undefined},
        ]) {
            expect(
                adjudicatedThreadsFromStaged([
                    adjudicated({...state, openerDownvotes: 1}),
                ]),
            ).toEqual([
                {
                    thread_id: "T1",
                    path: "a.ts",
                    body: "**suggestion (non-blocking):** opener",
                },
            ]);
        }
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
            // A downvote count must be an explicit positive number: absent,
            // zero, or malformed reads as no downvote, and a downvote alone
            // never launders a thread that fails the bot-opener guard.
            adjudicated({resolved: false, openerDownvotes: 0}),
            adjudicated({resolved: false, openerDownvotes: "1"}),
            adjudicated({
                resolved: false,
                openerDownvotes: 1,
                comments: [{author: "jwbron", body: "human opener"}],
            }),
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

describe("cross-file adjudicated suppression (the path key dropped)", () => {
    const adjudicatedThread = () => ({
        thread_id: "T-adj",
        path: "services/ai-guide/memory/expiration.go",
        body: "**suggestion (non-blocking):** No test exercises the deletion path: TestExpiration only asserts that expired keys are identified, so a regression that identifies but never deletes expired memories stays green.",
    });
    const crossFile = (over: Partial<Claim> = {}) =>
        claim({
            id: "correctness-reviewer-9",
            source: "correctness-reviewer",
            path: "services/ai-guide/memory/expiration_test.go",
            line: 7,
            label: "suggestion (non-blocking)",
            subject:
                "TestExpiration never exercises the deletion path for expired keys.",
            discussion:
                "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
            failure_scenario:
                "A regression that identifies expired memories but skips the deletion ships green.",
            ...over,
        });

    it("suppresses a re-derivation re-anchored on another file", () => {
        // The webapp#41290 failure mode: the same settled defect re-posted
        // at the spec, the implementation, and the test across runs, and the
        // path key exempted every re-anchoring from the corpus. Measured on
        // that frozen corpus (see suppressAdjudicatedDuplicates's doc),
        // dropping the key tripled recall (2/12 to 6/12) and added zero
        // false suppressions.
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [crossFile()],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([]);
        expect(suppressed).toHaveLength(1);
        expect(suppressed[0].thread_id).toBe("T-adj");
        expect(suppressed[0].adjudicated).toBe(true);
        expect(suppressed[0].path).toBe(
            "services/ai-guide/memory/expiration_test.go",
        );
    });

    it("still never suppresses a blocking candidate, cross-file included", () => {
        const blocking = crossFile({label: "issue (blocking)"});
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [blocking],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([blocking]);
        expect(suppressed).toEqual([]);
    });

    it("pays OTHER_LINE_FLOOR cross-file, not the pr-level tier", () => {
        // This fixture scores 7 shared bigrams against T-adj (jaccard 0.481,
        // overlap 0.722, via the real tokenizer): inside the band where
        // OTHER_LINE_FLOOR (>=6) and PR_LEVEL_FLOOR (>=8) disagree, so it
        // pins the documented floor choice rather than clearing both. The
        // weakest true cross-file match on the frozen 41290 corpus sits at
        // exactly 7; a floor of 8 would lose it for no measured precision
        // (see bestOpenThreadMatch's calibration note).
        const marginal = crossFile({
            subject: "The deletion path for expired keys is untested.",
            discussion:
                "TestExpiration stops at identification; nothing checks the memories are actually removed afterwards.",
            failure_scenario:
                "A regression that identifies expired memories but never deletes them stays green.",
        });
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [marginal],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([]);
        expect(suppressed).toHaveLength(1);
    });

    it("keeps a cross-file hard negative: shared vocabulary alone does not clear the jaccard guard", () => {
        // The precision half of dropping the path key. This candidate is a
        // DIFFERENT defect (the sweep holds the lock across the deletion
        // pass, not a missing test) that reuses the thread's vocabulary
        // heavily enough to clear the other two floors: 6 shared bigrams
        // (exactly OTHER_LINE_FLOOR's 6) and overlap 0.444 against the 0.35
        // floor, with jaccard 0.157 against 0.2, via the real tokenizer.
        // Only jaccard rejects it, which is the guard the frozen 41290
        // corpus measured at 0.168 on its strongest cross-file negative
        // (see bestOpenThreadMatch's calibration note); a false suppression
        // here drops a finding with no trace, so this pins the floor's
        // precision side the way the marginal fixture above pins recall.
        const negative = crossFile({
            subject:
                "The expiration sweep holds the write lock for the whole deletion pass.",
            discussion:
                "Expire acquires the global mutex once and walks every shard under it; the deletion path never deletes expired memories individually, so the expired keys identified by the scan are removed while readers block on the same mutex.",
            failure_scenario:
                "A large batch of expired entries stalls every concurrent reader of the memory store until the sweep's pass finishes.",
        });
        const {kept, suppressed} = suppressAdjudicatedDuplicates(
            [negative],
            [adjudicatedThread()],
        );
        expect(kept).toEqual([negative]);
        expect(suppressed).toEqual([]);
    });

    it("picks the best-scoring adjudicated thread across files, independent of staging order", () => {
        // Both corpus members clear the floor against the candidate (the
        // discursive SPEC.md thread scores jaccard 0.467, the true
        // counterpart 0.85), so ranking, not the floor, decides attribution.
        const weaker = {
            thread_id: "T-spec",
            path: "services/ai-guide/memory/spec/SPEC.md",
            body: "**note (non-blocking):** The spec promises that expired memories are deleted, and TestExpiration exercises only the identification half: expired keys are asserted as identified, deletion is never checked, so a regression that identifies but never deletes expired memories stays green and the spec's deletion promise goes untested.",
        };
        const both = [weaker, adjudicatedThread()];
        const {suppressed} = suppressAdjudicatedDuplicates([crossFile()], both);
        expect(suppressed[0].thread_id).toBe("T-adj");
        expect(
            suppressAdjudicatedDuplicates([crossFile()], [...both].reverse())
                .suppressed[0],
        ).toEqual(suppressed[0]);
    });

    it("an adjudicated thread staged without a usable path suppresses nothing", () => {
        // Under the path key an anchorless corpus member could never match a
        // pathed claim (openThreadsFromStaged calls that degradation
        // fail-closed); dropping the claim-side key must not flip it into a
        // PR-wide wildcard, so the thread side keeps its gate.
        for (const path of [undefined, ""]) {
            const anchorless = {...adjudicatedThread(), path};
            const {kept, suppressed} = suppressAdjudicatedDuplicates(
                [crossFile()],
                [anchorless],
            );
            expect(kept).toHaveLength(1);
            expect(suppressed).toEqual([]);
        }
    });

    it("leaves the OPEN corpus path-keyed: the same cross-file pair does not suppress there", () => {
        // The asymmetry is the point: on the open corpus a false cross-file
        // match hides an UNDECIDED finding, so its matcher keeps the path
        // key; only human-settled threads earn the wide match.
        const {kept, suppressed} = suppressOpenThreadDuplicates(
            [crossFile()],
            [adjudicatedThread()],
        );
        expect(kept).toHaveLength(1);
        expect(suppressed).toEqual([]);
    });
});
