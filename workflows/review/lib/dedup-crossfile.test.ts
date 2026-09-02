import {describe, it, expect} from "vitest";

import {
    mergeCrossFileDuplicates,
    reapplyCrossFileOccurrences,
    suppressThenMergeCrossFile,
} from "./dedup-crossfile";
import {type Claim} from "./dispatch-contracts";

/**
 * Cross-file duplicate merge: one source's same finding on several files.
 * The exact-duplicate fixtures reproduce the measured shape from
 * Khan/webapp#41440 (inline comments 3764122555 and 3764122558: byte-identical
 * documentation suggestions on two sibling eval YAML files).
 */

const EXERCISE =
    "services/ai-guide/eval/tut/DiagramTriggeringT1Exercise.eval.yaml";
const TUTOR_ME =
    "services/ai-guide/eval/tut/DiagramTriggeringT1TutorMe.eval.yaml";

const claim = (overrides: Partial<Claim>): Claim => ({
    id: "documentation-1",
    source: "documentation",
    path: EXERCISE,
    line: 12,
    label: "suggestion (non-blocking, documentation)",
    subject: "Comment names a v1 variant the versions block does not define.",
    discussion:
        "The header comment says the file compares a v1 variant against v2, " +
        "but the versions block defines only v0 and v2, so the comment " +
        "promises a comparison the eval never runs and the next editor has " +
        "to reverse-engineer which label is stale.",
    failure_scenario:
        "A reader trusts the comment, looks for the v1 variant, and edits " +
        "the wrong versions entry.",
    confidence: 0.8,
    ...overrides,
});

const pair = (): Claim[] => [
    claim({id: "documentation-1", path: EXERCISE, line: 12}),
    claim({id: "documentation-2", path: TUTOR_ME, line: 139}),
];

describe("mergeCrossFileDuplicates", () => {
    it("merges an exact cross-file duplicate into the first diff-order occurrence", () => {
        const result = mergeCrossFileDuplicates(pair(), [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(1);
        const survivor = result.claims[0];
        expect(survivor.id).toBe("documentation-1");
        expect(survivor.path).toBe(EXERCISE);
        expect(survivor.discussion).toContain(
            `Also applies to \`${TUTOR_ME}\` (line 139).`,
        );
        expect(result.merges).toEqual([
            {
                survivor: "documentation-1",
                source: "documentation",
                label: "suggestion (non-blocking, documentation)",
                path: EXERCISE,
                line: 12,
                merged: [{id: "documentation-2", path: TUTOR_ME, line: 139}],
                via: "cross-file",
            },
        ]);
    });

    it("elects the survivor by diff order, not claim order", () => {
        // The reviewer reported TutorMe first, but Exercise comes first in
        // the diff; the comment must land where a reader meets the pattern.
        const claims = [
            claim({id: "documentation-1", path: TUTOR_ME, line: 139}),
            claim({id: "documentation-2", path: EXERCISE, line: 12}),
        ];
        const result = mergeCrossFileDuplicates(claims, [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].id).toBe("documentation-2");
        expect(result.claims[0].path).toBe(EXERCISE);
    });

    it("falls back to claim order when no diff order is provided", () => {
        const result = mergeCrossFileDuplicates(pair());
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].id).toBe("documentation-1");
    });

    it("merges a near-identical pair that clears the strict floor", () => {
        // Same prose with one clause reworded: still far above the
        // different-line floor (high token overlap, many shared bigrams).
        const reworded = claim({
            id: "documentation-2",
            path: TUTOR_ME,
            line: 139,
            discussion:
                "The header comment says the file compares a v1 variant " +
                "against v2, but the versions block defines only v0 and v2, " +
                "so the comment promises a comparison the eval never runs " +
                "and the stale label misleads the next editor.",
        });
        const result = mergeCrossFileDuplicates(
            [claim({}), reworded],
            [EXERCISE, TUTOR_ME],
        );
        expect(result.claims).toHaveLength(1);
        expect(result.merges).toHaveLength(1);
    });

    it("does not merge below the similarity floor", () => {
        const different = claim({
            id: "documentation-2",
            path: TUTOR_ME,
            line: 139,
            subject: "Stale version labels across the new eval files.",
            discussion:
                "This file's versionKey is v1-prompt while the sibling " +
                "diagram evals use v2; inconsistent naming will confuse " +
                "anyone comparing runs across the suite.",
            failure_scenario:
                "An engineer filters eval dashboards by version key and " +
                "misses half the runs.",
        });
        const result = mergeCrossFileDuplicates(
            [claim({}), different],
            [EXERCISE, TUTOR_ME],
        );
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toHaveLength(0);
    });

    it("never buys the lax exact-anchor floor with coincidentally equal lines", () => {
        // Two moderately similar claims at the SAME line number in different
        // files: below the strict different-line floor, and the equal lines
        // must not downgrade to the exact-anchor tier and merge them.
        // This pair sits BETWEEN the floors: it clears the exact-anchor
        // floor when the lines read as equal, and fails the different-line
        // floor when they are stripped (verified against describesSameDefect
        // directly when the fixture was built).
        const a = claim({
            id: "documentation-1",
            path: EXERCISE,
            line: 42,
            subject: "Stale promptVersion comment in the eval header.",
            discussion:
                "The versions block comment references promptVersion v0 " +
                "gating for markdown tables.",
            failure_scenario: "Editor misreads the versions block comment.",
        });
        const b = claim({
            id: "documentation-2",
            path: TUTOR_ME,
            line: 42,
            subject: "Stale promptVersion comment in the eval header.",
            discussion:
                "The versions block comment references promptVersion gating " +
                "the fragment never defines.",
            failure_scenario:
                "Editor trusts the header and edits the wrong file.",
        });
        const result = mergeCrossFileDuplicates([a, b], [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toHaveLength(0);
    });

    it("never merges across labels, even with identical bodies", () => {
        const claims = [
            claim({id: "documentation-1"}),
            claim({
                id: "documentation-2",
                path: TUTOR_ME,
                line: 139,
                label: "note (non-blocking)",
            }),
        ];
        const result = mergeCrossFileDuplicates(claims, [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toHaveLength(0);
    });

    it("never merges across sources, even with identical bodies", () => {
        const claims = [
            claim({id: "documentation-1"}),
            claim({
                id: "skill-auditor-1",
                source: "skill-auditor",
                path: TUTOR_ME,
                line: 139,
            }),
        ];
        const result = mergeCrossFileDuplicates(claims, [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toHaveLength(0);
    });

    it("leaves same-path pairs to tier 1", () => {
        const claims = [
            claim({id: "documentation-1"}),
            claim({id: "documentation-2", line: 40}),
        ];
        const result = mergeCrossFileDuplicates(claims, [EXERCISE]);
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toHaveLength(0);
    });

    it("skips unanchored claims", () => {
        const claims = [
            claim({id: "documentation-1", line: undefined}),
            claim({id: "documentation-2", path: TUTOR_ME, line: 139}),
        ];
        const result = mergeCrossFileDuplicates(claims, [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(2);
        expect(result.merges).toHaveLength(0);
    });

    it("keeps exactly one blocking claim when a blocking group merges", () => {
        const blocking = (id: string, path: string, line: number): Claim =>
            claim({id, path, line, label: "issue (blocking)"});
        const result = mergeCrossFileDuplicates(
            [
                blocking("correctness-1", EXERCISE, 5),
                blocking("correctness-2", TUTOR_ME, 9),
            ],
            [EXERCISE, TUTOR_ME],
        );
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].label).toBe("issue (blocking)");
        expect(result.merges[0].merged).toHaveLength(1);
    });

    it("merges a three-file group into one comment listing both other occurrences", () => {
        const third =
            "services/ai-guide/eval/tut/DiagramTriggeringT1Video.eval.yaml";
        const claims = [
            claim({id: "documentation-1", path: EXERCISE, line: 12}),
            claim({id: "documentation-2", path: TUTOR_ME, line: 139}),
            claim({id: "documentation-3", path: third, line: 77}),
        ];
        const result = mergeCrossFileDuplicates(claims, [
            EXERCISE,
            TUTOR_ME,
            third,
        ]);
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].discussion).toContain(
            `Also applies to \`${TUTOR_ME}\` (line 139), \`${third}\` (line 77).`,
        );
        expect(result.merges[0].merged.map((copy) => copy.id)).toEqual([
            "documentation-2",
            "documentation-3",
        ]);
    });

    it("does not chain distinct findings through a bridging claim", () => {
        // The label mismatch keeps C out of the group before the star
        // guard runs; the bigram-chain case below is the one that reaches
        // the guard's filtering branch.
        const claims = [
            claim({id: "documentation-1", path: EXERCISE, line: 12}),
            claim({id: "documentation-2", path: TUTOR_ME, line: 139}),
            claim({
                id: "documentation-3",
                path: TUTOR_ME,
                line: 139,
                label: "note (non-blocking)",
            }),
        ];
        const result = mergeCrossFileDuplicates(claims, [EXERCISE, TUTOR_ME]);
        expect(result.claims).toHaveLength(2);
        expect(result.claims.map((kept) => kept.id)).toEqual([
            "documentation-1",
            "documentation-3",
        ]);
    });

    it("keeps a bridged member as its own claim (the star guard as a filter)", () => {
        // A genuine similarity chain: bridge B clears the near-identical
        // floor against A (shared subject) and against C (B's failure
        // scenario is C's subject), while A and C share no content tokens.
        // Union-find chains all three into one group; the star guard must
        // merge only B into A's survivor and leave C standing, not drop or
        // wrongly merge it.
        const shared =
            "Retry loop rereads deletion cursor after every batch completes.";
        const bridgeText =
            "Pagination token resets whenever filters change between successive requests.";
        const third =
            "services/ai-guide/eval/tut/DiagramTriggeringT1Video.eval.yaml";
        const claims = [
            claim({
                id: "documentation-1",
                path: EXERCISE,
                line: 12,
                subject: shared,
                failure_scenario:
                    "Logging sink swallows write errors during shutdown flush window.",
            }),
            claim({
                id: "documentation-2",
                path: TUTOR_ME,
                line: 139,
                subject: shared,
                failure_scenario: bridgeText,
            }),
            claim({
                id: "documentation-3",
                path: third,
                line: 77,
                subject: bridgeText,
                failure_scenario:
                    "Metrics counter increments twice inside recovered panic handler path.",
            }),
        ];
        const result = mergeCrossFileDuplicates(claims, [
            EXERCISE,
            TUTOR_ME,
            third,
        ]);
        expect(result.claims.map((kept) => kept.id)).toEqual([
            "documentation-1",
            "documentation-3",
        ]);
        expect(result.claims[0].discussion).toContain(
            `Also applies to \`${TUTOR_ME}\` (line 139).`,
        );
        expect(result.claims[0].discussion).not.toContain(third);
        expect(result.merges).toHaveLength(1);
        expect(result.merges[0].merged.map((copy) => copy.id)).toEqual([
            "documentation-2",
        ]);
    });
});

describe("suppressThenMergeCrossFile", () => {
    it("degrades to claim order when the staging is malformed", () => {
        // The docstring promises a malformed files.json degrades to claim
        // order, never to a skipped merge. Thread stagings are equally raw
        // (absent here), and absent corpora suppress nothing.
        const result = suppressThenMergeCrossFile(pair(), [], [], new Set(), {
            not: "an array",
        });
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].id).toBe("documentation-1");
        expect(result.crossFileMerges).toHaveLength(1);
    });

    it("degrades to claim order when entries lack string paths", () => {
        const result = suppressThenMergeCrossFile(pair(), [], [], new Set(), [
            {path: 42},
            "not-a-record",
            {},
        ]);
        expect(result.claims).toHaveLength(1);
        expect(result.crossFileMerges).toHaveLength(1);
    });

    const staged = (over: Record<string, unknown>) => [
        {
            thread_id: "T-1",
            path: EXERCISE,
            comments: [
                {
                    author: "github-actions",
                    body: `**suggestion (non-blocking, documentation):** ${
                        claim({}).subject
                    } ${claim({}).discussion}`,
                },
            ],
            ...over,
        },
    ];

    it("open corpus: a tracked file's copy exits through its thread and the sibling posts alone", () => {
        // The ordering rationale in mergeCrossFileDuplicates's doc, pinned:
        // the open matcher is path-keyed, so the thread on EXERCISE takes
        // its own file's copy and the TUTOR_ME occurrence still posts.
        const result = suppressThenMergeCrossFile(
            pair(),
            staged({resolved: false}),
            [],
            new Set(),
            [EXERCISE, TUTOR_ME],
        );
        expect(result.claims.map((kept) => kept.id)).toEqual([
            "documentation-2",
        ]);
        expect(result.suppressed).toHaveLength(1);
        expect(result.suppressed[0].id).toBe("documentation-1");
        expect(result.suppressed[0].adjudicated).toBeUndefined();
        expect(result.crossFileMerges).toEqual([]);
    });

    it("adjudicated corpus: a settled thread takes the near-identical sibling copy too", () => {
        // The deliberate contrast with the open-corpus case above: the
        // adjudicated matcher drops the path key, so both stamped copies of
        // the human-settled non-blocking ask exit through the one thread and
        // nothing reaches the merge. A blocking re-presentation would post
        // (dedup-adjudicated.test.ts pins that exemption).
        const result = suppressThenMergeCrossFile(
            pair(),
            [],
            staged({resolved: true, resolvedBy: "sxkosone"}),
            new Set(),
            [EXERCISE, TUTOR_ME],
        );
        expect(result.claims).toEqual([]);
        expect(result.suppressed).toHaveLength(2);
        expect(
            result.suppressed.map((entry) => ({
                id: entry.id,
                adjudicated: entry.adjudicated,
            })),
        ).toEqual([
            {id: "documentation-1", adjudicated: true},
            {id: "documentation-2", adjudicated: true},
        ]);
        expect(result.crossFileMerges).toEqual([]);
    });

    it("re-applies the occurrence list a corrected discussion erased", () => {
        const merged = mergeCrossFileDuplicates(pair(), [EXERCISE, TUTOR_ME]);
        const corrected = merged.claims.map((kept) => ({
            ...kept,
            discussion: "Validator-corrected prose without the list.",
        }));
        const repaired = reapplyCrossFileOccurrences(corrected, merged.merges);
        expect(repaired[0].discussion).toBe(
            "Validator-corrected prose without the list." +
                `\n\nAlso applies to \`${TUTOR_ME}\` (line 139).`,
        );
        // A survivor whose discussion kept the line is left alone.
        expect(
            reapplyCrossFileOccurrences(merged.claims, merged.merges),
        ).toEqual(merged.claims);
        // A dropped survivor stays dropped.
        expect(reapplyCrossFileOccurrences([], merged.merges)).toEqual([]);
    });
});
