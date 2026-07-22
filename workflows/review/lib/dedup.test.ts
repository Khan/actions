import {describe, it, expect} from "vitest";

import {dedupeClaims, suppressOpenThreadDuplicates} from "./dedup";
import type {Claim} from "./dispatch-contracts";

/**
 * Cross-source duplicate-merge tests (the #245 ledger item). The duplicate
 * fixtures are abridged from trial run 29897276810's real outputs, where the
 * AddDate months-vs-days defect posted four times; the non-duplicate
 * fixtures are that run's distinct defects on the same or adjacent lines.
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

/** The run's four AddDate duplicates, one per source. */
const addDateClaims = (): Claim[] => [
    claim({
        id: "correctness-reviewer-1",
        source: "correctness-reviewer",
        subject:
            "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months (15 years), not 180 days, so the retention window never expires anything.",
        failure_scenario:
            "For any user with memories older than 180 days, the cutoff computes to now minus 180 months (~15 years); created_at < cutoff matches nothing, expiredKeys is always empty, and the PR's entire retention behavior is a silent no-op.",
        discussion:
            "Go's time.Time.AddDate signature is (years, months, days).",
        suggestion: "cutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
    }),
    claim({
        id: "completeness-1",
        source: "completeness",
        subject:
            "Retention window is 180 months (~15 years), not the stated 180 days: MemoryTTLDays is passed to AddDate's months argument.",
        failure_scenario:
            "A memory created 200 days ago, past the stated 180-day window, is never expired because AddDate(0, -MemoryTTLDays, 0) subtracts 180 months (~15 years), not 180 days, so stale context keeps being surfaced and the retention feature effectively does nothing.",
        discussion: "AddDate's signature is AddDate(years, months, days).",
    }),
    claim({
        id: "first-principles-1",
        source: "first-principles",
        label: "thought (non-blocking)",
        subject:
            "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months, not 180 days; the change as written does nothing.",
        failure_scenario:
            "The retention window the PR promises (180 days) is actually ~15 years, so no memory will ever be expired and the stated problem remains fully unsolved while the tests stay green.",
        discussion: "AddDate's signature is (years, months, days).",
    }),
    claim({
        id: "skill-auditor-ool-1",
        source: "skill-auditor (out-of-lane)",
        label: "question (non-blocking)",
        subject:
            "The cutoff uses AddDate(0, -MemoryTTLDays, 0), placing the 180 days value in AddDate's months parameter (signature is AddDate(years, months, days)), so the retention window is ~180 months (~15 years) instead of 180 days.",
        failure_scenario:
            "A memory created 200 days ago is not older than a 15-years-ago cutoff, so it is never expired; the retention feature effectively never removes stale memories within its intended 180-day window.",
    }),
];

describe("dedupeClaims", () => {
    it("merges the run's four AddDate duplicates into the blocking survivor", () => {
        const {claims, merges} = dedupeClaims(addDateClaims());
        expect(claims).toHaveLength(1);
        expect(claims[0].id).toBe("correctness-reviewer-1");
        expect(claims[0].label).toBe("issue (blocking)");
        expect(claims[0].discussion).toContain(
            "Also flagged by completeness, first-principles, skill-auditor (out-of-lane).",
        );
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-1",
                merged: [
                    {
                        id: "completeness-1",
                        source: "completeness",
                        label: "issue (blocking)",
                    },
                    {
                        id: "first-principles-1",
                        source: "first-principles",
                        label: "thought (non-blocking)",
                    },
                    {
                        id: "skill-auditor-ool-1",
                        source: "skill-auditor (out-of-lane)",
                        label: "question (non-blocking)",
                    },
                ],
                path: "services/ai-guide/memory/expiration.go",
                line: 38,
            },
        ]);
    });

    it("keeps distinct defects on adjacent lines apart (index vs unbounded read)", () => {
        const {claims, merges} = dedupeClaims([
            claim({
                id: "correctness-reviewer-2",
                source: "correctness-reviewer",
                line: 42,
                subject:
                    "The new kaid = AND created_at < query requires a composite index (kaid asc, created_at asc) that index.yaml does not declare.",
                failure_scenario:
                    "In production, every ExpireStale query fails with Datastore's no-matching-index error; because Save swallows expiration errors into a warn log, retention silently never runs.",
            }),
            claim({
                id: "correctness-reviewer-3",
                source: "correctness-reviewer",
                line: 44,
                subject:
                    "ExpireStale buffers every expired memory, full entities not just keys, with no Limit before acting, so the read is sized by unbounded user data.",
                failure_scenario:
                    "A user with a large stale backlog makes every Save synchronously materialize all of those entities and keys in memory before deleting; latency and memory grow linearly with the backlog.",
            }),
            claim({
                id: "holistic-2",
                source: "holistic",
                line: 44,
                subject:
                    "Consider processing one bounded batch per save instead of the full backlog.",
                failure_scenario:
                    "Large backlogs make the save path slow on first sweep.",
            }),
        ]);
        // correctness-reviewer-2 and -3 share a source; -3 and holistic-2
        // share a line but not enough text; nothing merges.
        expect(claims).toHaveLength(3);
        expect(merges).toEqual([]);
    });

    it("never merges across the two-line window or across paths", () => {
        const [a, b] = addDateClaims();
        const {claims: farApart} = dedupeClaims([a, {...b, line: 43}]);
        expect(farApart).toHaveLength(2);
        const {claims: otherPath} = dedupeClaims([
            a,
            {...b, path: "services/ai-guide/memory/memory.go"},
        ]);
        expect(otherPath).toHaveLength(2);
    });

    it("adopts a merged duplicate's suggestion and author dispute when the survivor lacks them", () => {
        const [withSuggestion, plain] = addDateClaims();
        const survivorToBe: Claim = {
            ...plain,
            label: "issue (blocking)",
            confidence: 0.9,
        };
        const donor: Claim = {
            ...withSuggestion,
            label: "suggestion (non-blocking)",
            author_dispute: "author says the window is intentional",
        };
        const {claims} = dedupeClaims([donor, survivorToBe]);
        expect(claims).toHaveLength(1);
        expect(claims[0].id).toBe(survivorToBe.id);
        expect(claims[0].suggestion).toBe(donor.suggestion);
        expect(claims[0].author_dispute).toBe(donor.author_dispute);
    });

    it("passes PR-level (non-anchored) claims through untouched", () => {
        const anchored = addDateClaims()[0];
        const prLevel: Claim = {
            ...addDateClaims()[1],
            id: "completeness-pr",
            path: undefined,
            line: undefined,
        } as Claim;
        const {claims, merges} = dedupeClaims([anchored, prLevel]);
        expect(claims).toHaveLength(2);
        expect(merges).toEqual([]);
    });
});

describe("suppressOpenThreadDuplicates (trial suggestion g)", () => {
    const openThread = (over: Record<string, unknown> = {}) => ({
        thread_id: "T1",
        path: "services/ai-guide/memory/expiration.go",
        body: [
            "**issue (blocking):** No test exercises the deletion path: TestExpiration only asserts that expired keys are identified, so a regression that identifies but never deletes expired memories stays green.",
            "",
            "> **Rule:** New behavior ships with a test that fails when the behavior breaks.",
            "",
            "```suggestion",
            "func TestExpirationDeletes(t *testing.T) {",
            "```",
        ].join("\n"),
        ...over,
    });

    it("suppresses a same-defect re-flag on the same path at a distant line", () => {
        const reflag = claim({
            id: "correctness-reviewer-2",
            source: "correctness-reviewer",
            line: 42,
            label: "todo (blocking)",
            subject:
                "Missing deletion test: the expiration path has no test covering the delete.",
            discussion:
                "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
            failure_scenario:
                "A regression that identifies expired memories but skips the deletion is not caught by TestExpiration and ships green.",
        });
        const {kept, suppressed} = suppressOpenThreadDuplicates(
            [reflag],
            [openThread()],
        );
        expect(kept).toEqual([]);
        expect(suppressed).toEqual([
            {
                id: "correctness-reviewer-2",
                source: "correctness-reviewer",
                label: "todo (blocking)",
                path: "services/ai-guide/memory/expiration.go",
                line: 42,
                thread_id: "T1",
                threadBlocking: true,
            },
        ]);
    });

    it("records the matched thread's opener as non-blocking when it is", () => {
        const reflag = claim({
            id: "correctness-reviewer-2",
            source: "correctness-reviewer",
            line: 42,
            label: "issue (blocking)",
            subject:
                "Missing deletion test: the expiration path has no test covering the delete.",
            discussion:
                "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
            failure_scenario:
                "A regression that identifies expired memories but skips the deletion is not caught by TestExpiration and ships green.",
        });
        const nonBlockingThread = openThread({
            body: openThread().body.replace(
                "**issue (blocking):**",
                "suggestion (non-blocking):",
            ),
        });
        const {suppressed} = suppressOpenThreadDuplicates(
            [reflag],
            [nonBlockingThread],
        );
        // Still suppressed (same defect), but flagged so submission.ts never
        // floors the verdict on an unvalidated blocking candidate alone.
        expect(suppressed).toHaveLength(1);
        expect(suppressed[0].threadBlocking).toBe(false);
    });

    it("keeps a distinct defect on the same path", () => {
        const distinct = claim({
            id: "correctness-reviewer-3",
            source: "correctness-reviewer",
            subject:
                "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months, not 180 days.",
            discussion:
                "Go's time.Time.AddDate signature is (years, months, days), so the cutoff computes to now minus 15 years and nothing ever expires.",
            failure_scenario:
                "created_at < cutoff matches nothing and expiredKeys is always empty.",
        });
        const {kept, suppressed} = suppressOpenThreadDuplicates(
            [distinct],
            [openThread()],
        );
        expect(kept).toHaveLength(1);
        expect(suppressed).toEqual([]);
    });

    it("never matches across paths or without an anchor, and is identity without threads", () => {
        const reflag = claim({
            id: "c",
            source: "correctness-reviewer",
            subject: "No test exercises the deletion path.",
            discussion:
                "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
            failure_scenario:
                "A regression that identifies expired memories but skips the deletion stays green.",
        });
        expect(
            suppressOpenThreadDuplicates(
                [claim({...reflag, path: undefined, line: undefined})],
                [openThread()],
            ).suppressed,
        ).toEqual([]);
        expect(
            suppressOpenThreadDuplicates(
                [reflag],
                [openThread({path: "other/file.go"})],
            ).suppressed,
        ).toEqual([]);
        expect(suppressOpenThreadDuplicates([reflag], []).kept).toHaveLength(1);
    });
});
