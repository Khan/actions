import {describe, it, expect} from "vitest";

import {
    dedupeClaims,
    openThreadsFromStaged,
    stagedThreadShapeFailure,
    suppressOpenThreadDuplicates,
} from "./dedup";
import type {Claim} from "./dispatch-contracts";

/**
 * Cross-source duplicate-merge tests (the #245 ledger item). The duplicate
 * fixtures are abridged from trial run 29897276810's real outputs, where the
 * AddDate months-vs-days defect posted four times; the non-duplicate
 * fixtures are that run's distinct defects on the same or adjacent lines.
 * The distant-line fixtures are trial run 29943085279's real claims, where
 * the missing-deletion-test defect posted four times because the old
 * two-line window blocked every same-path merge.
 *
 * The `run30301235749` fixtures are that run's real pre-validation claims
 * (its `out/claims.json` plus the skill-auditor handoff the run merged
 * away). Five sources flagged one TTL-unit defect on one line there and the
 * first calibration merged none of them, because the default correctness
 * pass supplies no `failure_scenario` and so compared its own one-line
 * subject against itself; it merged the handoff into an unrelated
 * missing-test todo 24 lines away instead.
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

/**
 * Run 30301235749's five copies of the TTL-unit defect, all anchored at
 * expiration.go:38, in dispatch order. `correctness-reviewer-1` is the
 * shape that broke the first calibration: the reviewer returned a title and
 * a discussion but no `failure_scenario`, so `buildClaims` handed the claim
 * its own subject back as one.
 */
const ttlUnitClaims = (): Claim[] => [
    claim({
        id: "correctness-reviewer-1",
        source: "correctness-reviewer",
        subject:
            "AddDate passes the TTL as months, not days — cutoff is 15 years ago, so nothing ever expires.",
        failure_scenario:
            "AddDate passes the TTL as months, not days — cutoff is 15 years ago, so nothing ever expires",
        discussion:
            "AddDate passes the TTL as months, not days — cutoff is 15 years ago, so nothing ever expires. Introduced by this change. Go's signature is Time.AddDate(years, months, days), so AddDate(0, -MemoryTTLDays, 0) with MemoryTTLDays = 180 subtracts 180 months — the cutoff lands ~15 years in the past, and the created_at < cutoff filter matches essentially no entity. The retention window the PR exists to add is a silent no-op: the query succeeds, returns zero rows, ExpireStale returns nil, and nothing is logged.",
        suggestion:
            "\tcutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
    }),
    claim({
        id: "skill-auditor-ool-1",
        source: "skill-auditor (out-of-lane)",
        label: "question (non-blocking)",
        subject:
            "cutoff := ctx.Time().Now().AddDate(0, -MemoryTTLDays, 0) passes the day count (180) into AddDate's months parameter (signature is AddDate(years, months, days)), computing a cutoff ~180 months (~15 years) in the past instead of 180 days.",
        failure_scenario:
            "With MemoryTTLDays=180 the cutoff is ~15 years ago, so no stored memory is ever older than it; the created_at < cutoff filter matches nothing and ExpireStale deletes nothing, meaning the retention window silently never fires and stale memories accumulate indefinitely — exactly the problem the PR claims to fix.",
    }),
    claim({
        id: "completeness-1",
        source: "completeness",
        subject:
            "Retention window is 180 months, not 180 days — AddDate args swapped.",
        failure_scenario:
            "A memory created 200 days ago is never expired: AddDate(0, -180, 0) subtracts 180 months (~15 years), so the cutoff sits ~15 years in the past and only memories older than that are removed — the promised 180-day retention window never takes effect for any realistic data.",
    }),
    claim({
        id: "holistic-1",
        source: "holistic",
        subject:
            "Whole change is incoherent: 180-day retention is implemented as ~180 months, defeating the change's entire purpose.",
        failure_scenario:
            "A memory created 200 days ago (well past the intended 180-day window) is never expired, because AddDate(0, -MemoryTTLDays, 0) subtracts 180 MONTHS (~15 years), so the retention window silently becomes ~15 years and the change's stated purpose does not happen.",
    }),
    claim({
        id: "first-principles-3",
        source: "first-principles",
        label: "note (non-blocking)",
        subject:
            "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months, not 180 days — the implementation contradicts its own description and comment.",
        failure_scenario:
            "The shipped retention window is ~15 years rather than the 180 days the description promises, so effectively nothing ever expires and the PR's stated goal is silently unmet.",
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

    it("merges same-defect copies at distant lines on the same path, never across paths", () => {
        // The two-line window this test used to pin is gone: run
        // 29943085279's missing-deletion-test copies sat 43 lines apart in
        // one file and the window kept all four separate.
        const [a, b] = addDateClaims();
        const {claims: distantLines} = dedupeClaims([a, {...b, line: 43}]);
        expect(distantLines).toHaveLength(1);
        const {claims: otherPath} = dedupeClaims([
            a,
            {...b, path: "services/ai-guide/memory/memory.go"},
        ]);
        expect(otherPath).toHaveLength(2);
    });

    it("never drops a chain-only member: a bridging claim merges, the distinct defect it links stays", () => {
        // A bundles-two-defects finding (missing test AND unbounded read)
        // clears the floor against each half separately while the halves do
        // not clear it against each other; union-find alone would collapse
        // all three and silently drop the unbounded-read finding.
        const missingTest = claim({
            id: "correctness-reviewer-1",
            source: "correctness-reviewer",
            line: 15,
            subject:
                "No test creates a memory older than the retention window and asserts it gets deleted, so the deletion path is never exercised.",
            failure_scenario:
                "A regression that turns expiration into a no-op ships with green tests because no test creates a stale memory and asserts it is deleted from the datastore.",
        });
        const bridge = claim({
            id: "test-adequacy-1",
            source: "test-adequacy",
            line: 40,
            label: "todo (blocking)",
            subject:
                "No test creates a stale memory and asserts it is deleted, and no test bounds the query: the deletion path and the unbounded read both ship untested.",
            failure_scenario:
                "A stale memory is never deleted in any test, and the unbounded query loads every stale memory into one slice with no Limit, so both regressions ship green while the read is sized by user data.",
        });
        const unboundedRead = claim({
            id: "correctness-reviewer-2",
            source: "correctness-reviewer",
            line: 62,
            subject:
                "The expiration query has no Limit and loads every stale memory into one slice, so the read is sized by unbounded user data.",
            failure_scenario:
                "A user with a large stale backlog makes the query load every stale memory into memory at once with no Limit, so the unbounded read grows with user data until the instance OOMs.",
        });
        const {claims, merges} = dedupeClaims([
            missingTest,
            bridge,
            unboundedRead,
        ]);
        expect(claims.map((c) => c.id)).toEqual([
            "correctness-reviewer-1",
            "correctness-reviewer-2",
        ]);
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-1",
                merged: [
                    {
                        id: "test-adequacy-1",
                        source: "test-adequacy",
                        label: "todo (blocking)",
                    },
                ],
                path: "services/ai-guide/memory/expiration.go",
                line: 15,
            },
        ]);
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

    it("merges the run-29943085279 missing-deletion-test todo and question 43 lines apart; survivor is the blocking copy", () => {
        // Real claim texts from that run's claims.json: the correctness todo
        // at expiration_test.go:15 and the skill-auditor out-of-lane question
        // at :58 describe one defect and posted as two comments.
        const todo = claim({
            id: "correctness-reviewer-3",
            source: "correctness-reviewer",
            path: "services/ai-guide/memory/expiration_test.go",
            line: 15,
            label: "todo (blocking)",
            subject:
                "No test creates a memory older than the retention window and asserts it gets deleted; the core added behavior (expiration actually expiring something) is untested, and both existing tests pass even when ExpireStale is a total no-op.",
            failure_scenario:
                "The TTL arithmetic bug (or any future regression that quietly turns expiration into a no-op, e.g. a filter-field typo) ships with green tests, and memories never expire in production with nothing to flag it.",
        });
        const question = claim({
            id: "skill-auditor-ool-2",
            source: "skill-auditor (out-of-lane)",
            path: "services/ai-guide/memory/expiration_test.go",
            line: 58,
            label: "question (non-blocking)",
            subject:
                "Both tests only exercise current memories (TestExpirationKeepsCurrentMemories) or an empty user (TestExpirationEmptyUser); neither creates a memory older than the retention window and asserts it is deleted.",
            failure_scenario:
                "Because no test stores a stale memory and checks it is removed, an incorrect cutoff computation (e.g. the AddDate months-vs-days error) passes CI green, so a retention feature that deletes nothing ships undetected.",
        });
        const {claims, merges} = dedupeClaims([todo, question]);
        expect(claims).toHaveLength(1);
        expect(claims[0].id).toBe("correctness-reviewer-3");
        expect(claims[0].label).toBe("todo (blocking)");
        expect(claims[0].discussion).toContain(
            "Also flagged by skill-auditor (out-of-lane).",
        );
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-3",
                merged: [
                    {
                        id: "skill-auditor-ool-2",
                        source: "skill-auditor (out-of-lane)",
                        label: "question (non-blocking)",
                    },
                ],
                path: "services/ai-guide/memory/expiration_test.go",
                line: 15,
            },
        ]);
    });

    it("keeps the run's test-adequacy todo and first-principles thought apart (same underlying defect, but below the similarity floor)", () => {
        // Real texts from expiration.go:62 and :38: replayed against the
        // calibrated floor they score below it, so this pair stays two
        // comments rather than forcing a looser floor (a false merge
        // silently drops a distinct finding; a missed merge only costs a
        // duplicate).
        const todo = claim({
            id: "test-adequacy-1",
            source: "test-adequacy",
            line: 62,
            label: "todo (blocking)",
            subject:
                "Positive expiration path (stale memory actually deleted) is untested.",
            failure_scenario:
                "No test creates a memory older than the retention window, so the DeleteMulti expiration path never runs; if the cutoff sign, filter field, or comparison were wrong (or expiration silently deleted nothing), stale memories would linger forever and every existing test would still pass since they only assert current memories survive.",
        });
        const thought = claim({
            id: "first-principles-1",
            source: "first-principles",
            line: 38,
            label: "thought (non-blocking)",
            subject:
                "The change's one central behavior (old memories get deleted) is never exercised, and the cutoff bug proves it.",
            failure_scenario:
                "The retention window is effectively 15 years, not 180 days; AddDate(0, -MemoryTTLDays, 0) puts the day count in the months slot, so the feature ships doing nothing, and the tests cannot notice because no test ever creates a stale memory and asserts it is deleted.",
        });
        const {claims, merges} = dedupeClaims([todo, thought]);
        expect(claims).toHaveLength(2);
        expect(merges).toEqual([]);
    });

    it("never merges the AddDate issue with the untested-behavior thought on the very same line", () => {
        // The false-merge guard for dropping the window: run 29943085279's
        // correctness AddDate issue and first-principles thought both anchor
        // at expiration.go:38 but are distinct findings, and both posted.
        const issue = claim({
            id: "correctness-reviewer-1",
            source: "correctness-reviewer",
            subject:
                "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months (15 years), not 180 days; the retention cutoff is ~2011, so no memory is ever expired and the entire feature is a silent no-op.",
            failure_scenario:
                "A user has memories written 181+ days ago. They save a new memory; ExpireStale runs, computes cutoff = now minus 180 months, finds no memory older than that, deletes nothing. Stale context keeps surfacing into Khanmigo conversations forever: exactly the problem the PR set out to fix.",
        });
        const thought = claim({
            id: "first-principles-1",
            source: "first-principles",
            label: "thought (non-blocking)",
            subject:
                "The change's one central behavior (old memories get deleted) is never exercised, and the cutoff bug proves it.",
            failure_scenario:
                "The retention window is effectively 15 years, not 180 days; AddDate(0, -MemoryTTLDays, 0) puts the day count in the months slot, so the feature ships doing nothing, and the tests cannot notice because no test ever creates a stale memory and asserts it is deleted.",
        });
        const {claims, merges} = dedupeClaims([issue, thought]);
        expect(claims).toHaveLength(2);
        expect(merges).toEqual([]);
    });

    it("merges run 30301235749's five same-line TTL-unit copies into the correctness issue", () => {
        const {claims, merges} = dedupeClaims(ttlUnitClaims());
        expect(claims).toHaveLength(1);
        expect(claims[0].id).toBe("correctness-reviewer-1");
        expect(claims[0].discussion).toContain(
            "Also flagged by skill-auditor (out-of-lane), completeness, " +
                "holistic, first-principles.",
        );
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-1",
                merged: [
                    {
                        id: "skill-auditor-ool-1",
                        source: "skill-auditor (out-of-lane)",
                        label: "question (non-blocking)",
                    },
                    {
                        id: "completeness-1",
                        source: "completeness",
                        label: "issue (blocking)",
                    },
                    {
                        id: "holistic-1",
                        source: "holistic",
                        label: "issue (blocking)",
                    },
                    {
                        id: "first-principles-3",
                        source: "first-principles",
                        label: "note (non-blocking)",
                    },
                ],
                path: "services/ai-guide/memory/expiration.go",
                line: 38,
            },
        ]);
    });

    it("compares a reviewer's discussion when its failure scenario only restates its subject", () => {
        // The mechanism behind the fixture above, isolated. A correctness
        // finding with no `failure_scenario` of its own carries eleven
        // content tokens twice; its evidence is all in the discussion, and
        // without reading it no floor loose enough to match the discursive
        // copies stays tight enough to reject run 29943085279's distinct
        // same-line pair below.
        const [terse, handoff] = ttlUnitClaims();
        const evidenceless: Claim = {...terse, discussion: terse.subject};
        expect(dedupeClaims([evidenceless, handoff]).claims).toHaveLength(2);
        expect(dedupeClaims([terse, handoff]).claims).toHaveLength(1);
    });

    it("keeps run 30301235749's TTL handoff and missing-test todo apart across lines", () => {
        // The false merge the first calibration made: the skill-auditor's
        // AddDate handoff at :38 landed in the test-adequacy todo at :62 on
        // five shared bigrams. Both real different-line duplicates share six
        // or more, so the other-line tier now asks for six.
        const handoff = ttlUnitClaims()[1];
        const todo = claim({
            id: "test-adequacy-1",
            source: "test-adequacy",
            line: 62,
            label: "todo (blocking)",
            subject: "Core stale-memory deletion path is completely untested.",
            failure_scenario:
                "No test ever stores a memory older than the retention window, so the deletion path (created_at < cutoff match → expiredKeys → DeleteMulti) is never exercised; a broken cutoff (e.g. AddDate month/day slot, or an inverted/wrong filter) that deletes nothing would pass CI while stale memories silently persist forever — exactly the behavior this change exists to fix.",
        });
        const {claims, merges} = dedupeClaims([handoff, todo]);
        expect(claims).toHaveLength(2);
        expect(merges).toEqual([]);
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

    it("reads every blocking label off the opener, not just the bare `(blocking)` one", () => {
        const reflag = claim({
            id: "correctness-reviewer-2",
            source: "correctness-reviewer",
            line: 42,
            label: "issue (blocking, best-practice)",
            subject:
                "Missing deletion test: the expiration path has no test covering the delete.",
            discussion:
                "No test exercises the deletion path; TestExpiration asserts expired keys are identified but a regression that never deletes expired memories stays green.",
            failure_scenario:
                "A regression that identifies expired memories but skips the deletion is not caught by TestExpiration and ships green.",
        });
        // `issue (blocking, best-practice)` is a BLOCKING_LABELS entry: a
        // suppression that recorded it as advisory would let the run flip to
        // APPROVE over a still-open, re-confirmed blocking objection.
        for (const opener of [
            "**issue (blocking, best-practice):**",
            "issue (blocking, best-practice):",
            "**issue (blocking,best-practice)**:",
            "**todo (blocking):**",
        ]) {
            const {suppressed} = suppressOpenThreadDuplicates(
                [reflag],
                [
                    openThread({
                        body: openThread().body.replace(
                            "**issue (blocking):**",
                            opener,
                        ),
                    }),
                ],
            );
            expect(suppressed).toHaveLength(1);
            expect(suppressed[0].threadBlocking).toBe(true);
        }
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

describe("openThreadsFromStaged", () => {
    const staged = (over: Record<string, unknown> = {}) => ({
        thread_id: "T1",
        path: "a.ts",
        resolved: false,
        comments: [
            {
                author: "github-actions[bot]",
                body: "**issue (blocking):** opener",
            },
        ],
        ...over,
    });

    it("keeps only bot-opened, unresolved threads (staging is prompt-executed and unenforced upstream)", () => {
        const threads = [
            staged(),
            staged({
                thread_id: "T2",
                comments: [{author: "some-human", body: "please also check X"}],
            }),
            staged({thread_id: "T3"}),
            staged({thread_id: "T4", comments: []}),
            staged({thread_id: "T5", comments: undefined}),
            {no_thread_id: true},
            "not a record",
        ];
        const result = openThreadsFromStaged(threads, new Set(["T3"]));
        expect(result).toEqual([
            {
                thread_id: "T1",
                path: "a.ts",
                body: "**issue (blocking):** opener",
            },
        ]);
    });

    it("requires the staged resolution state to say open, under either spelling", () => {
        // Unresolvedness is prompt-enforced exactly like bot-authorship was,
        // so it is checked here too: a mis-staged resolved thread would
        // suppress a genuine regression re-flag. Fails closed: an absent or
        // unparseable flag never suppresses.
        expect(
            openThreadsFromStaged([staged({resolved: true})], new Set()),
        ).toEqual([]);
        expect(
            openThreadsFromStaged([staged({resolved: undefined})], new Set()),
        ).toEqual([]);
        expect(
            openThreadsFromStaged([staged({resolved: "false"})], new Set()),
        ).toEqual([]);
        for (const open of [
            {resolved: undefined, is_resolved: false},
            {resolved: undefined, isResolved: false},
        ]) {
            expect(
                openThreadsFromStaged([staged(open)], new Set()),
            ).toHaveLength(1);
        }
    });

    it("is empty for non-array staging and tolerates a missing opener body", () => {
        expect(openThreadsFromStaged(undefined, new Set())).toEqual([]);
        expect(openThreadsFromStaged({not: "an array"}, new Set())).toEqual([]);
        const noBody = openThreadsFromStaged(
            [staged({comments: [{author: "github-actions[bot]"}]})],
            new Set(),
        );
        expect(noBody).toEqual([{thread_id: "T1", path: "a.ts", body: ""}]);
    });

    // The fixtures above all spell the bot `github-actions[bot]`, which is the
    // REST spelling (`user.login`) that stage-pr.ts reads for prior reviews.
    // `get_review_comments`, the tool that stages THESE threads, renders the
    // same account as bare `github-actions` and carries `path` on the comment
    // rather than the thread. Every fixture agreeing with the code is why
    // suppression passed its unit tests while suppressing nothing across three
    // rounds of a seeded lifecycle (webapp#41197). This case is the real tool
    // shape, verbatim, so the fixtures can no longer drift back toward the code.
    it("accepts the get_review_comments shape: bare `github-actions`, path on the comment", () => {
        const fromTool = {
            thread_id: "PRRT_kwDOAJgNW86VOObT",
            is_resolved: false,
            is_outdated: true,
            comments: [
                {
                    author: "github-actions",
                    body: "**issue (blocking):** Retention cutoff subtracts 180 months, not 180 days.",
                    path: "services/ai-guide/memory/expiration.go",
                },
            ],
        };
        expect(openThreadsFromStaged([fromTool], new Set())).toEqual([
            {
                thread_id: "PRRT_kwDOAJgNW86VOObT",
                path: "services/ai-guide/memory/expiration.go",
                body: "**issue (blocking):** Retention cutoff subtracts 180 months, not 180 days.",
            },
        ]);
    });

    it("suppresses a re-flag against a thread staged in the tool's shape", () => {
        // The end-to-end assertion the unit suite never made: a claim
        // re-describing an open thread's defect must not post again. Without
        // the author and path fixes this returns the claim unsuppressed, which
        // is exactly what production did.
        const claim: Claim = {
            id: "correctness-reviewer-1",
            source: "correctness-reviewer",
            label: "issue (blocking)",
            path: "services/ai-guide/memory/expiration.go",
            line: 38,
            subject: "AddDate passes the day count into the months slot",
            discussion:
                "The retention cutoff subtracts 180 months rather than 180 days, so expiration never fires.",
            failure_scenario:
                "No memory is ever old enough to match the cutoff, so the retention feature is a silent no-op.",
            confidence: 0.9,
        };
        const thread = {
            thread_id: "PRRT_1",
            is_resolved: false,
            comments: [
                {
                    author: "github-actions",
                    body: "**issue (blocking):** Retention cutoff subtracts 180 months, not 180 days — expiration never fires. AddDate's signature is (years, months, days), so the retention window is 15 years and no memory ever matches.",
                    path: "services/ai-guide/memory/expiration.go",
                },
            ],
        };
        const result = suppressOpenThreadDuplicates(
            [claim],
            openThreadsFromStaged([thread], new Set()),
        );
        expect(result.kept).toEqual([]);
        expect(result.suppressed).toHaveLength(1);
        expect(result.suppressed[0]?.thread_id).toBe("PRRT_1");
        // The thread's opener is blocking, so the verdict floor still applies:
        // suppressing the duplicate must not let a verdict flip to APPROVE.
        expect(result.suppressed[0]?.threadBlocking).toBe(true);
    });

    it("reports a staging whose shape defeats the filter entirely", () => {
        // The tripwire itself. Untested, an edit flipping its condition would
        // silently restore the webapp#41197 blindness this exists to catch.
        const unusable = {
            thread_id: "PRRT_1",
            is_resolved: false,
            comments: [{author: "some-human", body: "x", path: "a.ts"}],
        };
        const failure = stagedThreadShapeFailure([unusable], [], new Set());
        expect(failure?.unusableThreads).toBe(1);
        expect(failure?.warning).toContain("none usable");
    });

    it("reports nothing when suppression had usable threads or no threads", () => {
        const usable = {
            thread_id: "PRRT_1",
            is_resolved: false,
            comments: [{author: "github-actions", body: "b", path: "a.ts"}],
        };
        const open = openThreadsFromStaged([usable], new Set());
        expect(open).toHaveLength(1);
        // A usable thread means suppression ran; nothing to report.
        expect(
            stagedThreadShapeFailure([usable], open, new Set()),
        ).toBeUndefined();
        // No staging at all is the ordinary first-review case, not a failure.
        expect(stagedThreadShapeFailure([], [], new Set())).toBeUndefined();
        expect(
            stagedThreadShapeFailure(undefined, [], new Set()),
        ).toBeUndefined();
    });

    it("counts resolved threads per id, not by resolve-list length", () => {
        // The reconciler's `resolve` list is never validated against the
        // staged thread_ids, so a long list must not mask a total shape
        // failure in a short staging by arithmetic alone.
        const unusable = {
            thread_id: "PRRT_staged",
            is_resolved: false,
            comments: [{author: "some-human", body: "x", path: "a.ts"}],
        };
        const unrelatedResolves = new Set(["PRRT_a", "PRRT_b", "PRRT_c"]);
        expect(
            stagedThreadShapeFailure([unusable], [], unrelatedResolves)
                ?.unusableThreads,
        ).toBe(1);
        // A staged thread the reconciler DID resolve is legitimately unusable.
        expect(
            stagedThreadShapeFailure([unusable], [], new Set(["PRRT_staged"])),
        ).toBeUndefined();
    });

    it("still refuses a human-opened thread in the tool's shape", () => {
        // The author fix widens the accepted spellings; it must not widen them
        // to anyone. A human thread killing a candidate would drop a finding
        // outright and skip the verdict floor with it.
        const humanThread = {
            thread_id: "PRRT_2",
            is_resolved: false,
            comments: [
                {author: "jwbron", body: "please also check X", path: "a.ts"},
            ],
        };
        expect(openThreadsFromStaged([humanThread], new Set())).toEqual([]);
    });
});
