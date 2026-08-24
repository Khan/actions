import {describe, it, expect} from "vitest";

import {dedupeClaims} from "./dedup";
import type {Claim} from "./dispatch-contracts";

/**
 * Dedup tier 2: the merges the `claim-clusterer` unlocks, and every guard that
 * keeps a model's identity claim from costing a distinct finding. Split from
 * dedup.test.ts for its max-lines budget; the `claim` factory mirrors that
 * file's.
 *
 * The load-bearing fixture is run 30587343777 (webapp#41204), a FIRST review at
 * `depth: full` whose four sources flagged one wrong doc comment and merged
 * none of it. Replaying that run's own claims.json is what showed the
 * similarity tier is not close: three of the four share the exact anchor and
 * still score 0.060-0.068 Jaccard against a 0.14 floor with 0-1 shared bigrams
 * against a floor of 4. The first test here pins that, so a future re-derivation
 * of the floors cannot quietly claim this cluster.
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

/**
 * Run 30587343777's four copies of the wrong-cap comment, verbatim from that
 * run's `out/claims.json` (a FIRST review at `depth: full`, so nothing here is
 * a re-review artifact), in dispatch order. The seeded file's line 8 is
 * `// Keeps at most 10 samples per key.` and line 9 is `const maxSamples = 25`;
 * three of the four anchor on the comment and one on the constant. All four are
 * non-blocking, and the run's autofix later satisfied every one of them with a
 * single rewritten comment.
 *
 * `conventions-1` is the member worth arguing about: its stated rule is that a
 * declaration comment must begin with the symbol name, not that the cap is
 * wrong. It belongs here anyway, because the unit of identity is the defect the
 * author must fix, and one rewritten comment discharges all four asks.
 */
const wrongCapClaims = (): Claim[] => [
    claim({
        id: "correctness-reviewer-3",
        source: "correctness-reviewer",
        path: "dev/af19_trial/window.go",
        line: 8,
        label: "note (non-blocking)",
        subject: "Comment says the per-key cap is 10 but maxSamples is 25.",
        discussion:
            'Comment says the per-key cap is 10 but maxSamples is 25. Introduced by this change. The comment on `maxSamples` reads "Keeps at most 10 samples per key" while the constant is 25 — a factually wrong comment from the moment it lands, which the repo conventions explicitly call out ("keep comments true"). While here: the adjacent `// staleAfter is 15 minutes.` comment, and the inline `// Append the sample to the slice for this key.` / `// Add the sample to the result.` comments, restate the code rather than explain why — the root contract asks for why-comments; consider dropping them.',
        failure_scenario:
            "Comment says the per-key cap is 10 but maxSamples is 25",
        suggestion:
            "// maxSamples caps how many samples one key retains, so a hot key cannot grow\n// without bound.\nconst maxSamples = 25",
    }),
    claim({
        id: "skill-auditor-ool-2",
        source: "skill-auditor (out-of-lane)",
        path: "dev/af19_trial/window.go",
        line: 9,
        label: "question (non-blocking)",
        subject:
            'The comment on line 8 says "Keeps at most 10 samples per key." but `const maxSamples = 25`, so the doc and the enforced cap disagree.',
        discussion:
            'The comment on line 8 says "Keeps at most 10 samples per key." but `const maxSamples = 25`, so the doc and the enforced cap disagree.',
        failure_scenario:
            "A caller or maintainer trusting the comment believes each key retains at most 10 samples and sizes downstream buffers or reasoning around 10, while Record actually retains 25, leading to under-provisioned assumptions about memory/behavior.",
    }),
    claim({
        id: "conventions-1",
        source: "conventions",
        path: "dev/af19_trial/window.go",
        line: 8,
        label: "nitpick (non-blocking)",
        subject: "Declaration doc comment doesn't begin with the symbol name.",
        discussion:
            "Declaration doc comment doesn't begin with the symbol name. Every other declaration comment in this file starts with the declared name — e.g. two lines below, `// staleAfter is 15 minutes.` above `const staleAfter`, and likewise `// Sample is...`, `// Window holds...`, `// NewWindow returns...`. The comment `// Keeps at most 10 samples per key.` above `const maxSamples = 25` is the sole one that omits the `maxSamples` prefix.",
        failure_scenario:
            "A `go doc`/grep-by-symbol reader won't associate this comment with `maxSamples`, and the odd-one-out style reads as an oversight next to its eight siblings.",
        suggestion:
            "// maxSamples caps how many samples are kept per key.\nconst maxSamples = 25",
    }),
    claim({
        id: "documentation-1",
        source: "documentation",
        path: "dev/af19_trial/window.go",
        line: 8,
        label: "suggestion (non-blocking, documentation)",
        subject: "Comment states the wrong cap (10 vs 25).",
        discussion:
            "Comment states the wrong cap (10 vs 25). The comment `// Keeps at most 10 samples per key.` sits directly on `const maxSamples = 25` — the number in the prose contradicts the value.",
        failure_scenario:
            "A reader trusts the comment's cap of 10 when reasoning about memory/behavior, but the real cap is 25.",
        suggestion: "// Keeps at most 25 samples per key.",
    }),
];

/**
 * Two distinct defects from the same run sitting inside the cluster's own line
 * range: hard-coded tunables (at :9, the cluster's second anchor) and a comment
 * restating `staleAfter` (at :11). Both are real claims from that
 * `claims.json`, and both must survive the cap merge.
 */
const capNeighbourClaims = (): Claim[] => [
    claim({
        id: "first-principles-1",
        source: "first-principles",
        path: "dev/af19_trial/window.go",
        line: 9,
        label: "suggestion (non-blocking)",
        subject:
            "Hard-coded maxSamples/staleAfter contradict the stated goal of unifying several differing call sites.",
        discussion:
            "Hard-coded maxSamples/staleAfter contradict the stated goal of unifying several differing call sites. The rationale is that several call sites each keep 'their own ad-hoc ring' with the same three operations 'slightly differently' — but the dimensions along which they most plausibly differ (cap size, staleness bound) are frozen as unexported package constants (25 samples, 15 minutes). A shared helper whose only tunables are untunable can't actually replace divergent callers.",
        failure_scenario:
            "The first real call site that needs a different cap or staleness bound cannot adopt the helper without editing package-level constants, so the ad-hoc rings this PR exists to eliminate stay in place.",
    }),
    claim({
        id: "documentation-2",
        source: "documentation",
        path: "dev/af19_trial/window.go",
        line: 11,
        label: "suggestion (non-blocking, documentation)",
        subject: "Comment restates the constant.",
        discussion:
            "Comment restates the constant. `// staleAfter is 15 minutes.` restates `const staleAfter = 15 * time.Minute` verbatim; the code already says exactly this. Delete the comment.",
        failure_scenario:
            "The reader maintains a comment that restates the literal it sits on; if the duration changes and the comment doesn't, it becomes a lie.",
    }),
];

describe("dedupeClaims with model-proposed clusters", () => {
    it("leaves run 30587343777's four wrong-cap copies unmerged on the similarity tier alone", () => {
        // The production symptom, pinned: a FIRST review at full depth, four
        // sources on one wrong doc comment, and `merges` recorded none of them.
        // THREE of the four share the exact anchor and still score 0.060-0.068
        // Jaccard on the 0.14 same-line floor with 0-1 shared bigrams on a
        // floor of 4, so no re-derivation of tier 1 reaches this cluster: the
        // floor that admits 0.06 admits everything.
        const {claims, merges} = dedupeClaims(wrongCapClaims());
        expect(claims).toHaveLength(4);
        expect(merges).toEqual([]);
    });

    it("merges run 30587343777's four wrong-cap copies on the clusterer's grounded proposal", () => {
        const {claims, merges, clusterRejections} = dedupeClaims(
            wrongCapClaims(),
            [
                {
                    evidence:
                        "the doc comment on `maxSamples` says 10 while the constant is 25",
                    ids: [
                        "correctness-reviewer-3",
                        "skill-auditor-ool-2",
                        "conventions-1",
                        "documentation-1",
                    ],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual(["correctness-reviewer-3"]);
        // Anchors differ inside the cluster (:8 and :9), which tier 2 does not
        // care about and the record does report. Each absorbed copy also brings
        // its own subject, because tier 2 merged claims whose words the
        // survivor's prose does NOT restate: `conventions` asked for the
        // symbol-name prefix, not for the wrong number, and one rewritten
        // comment discharges both asks only if the author is told about both.
        expect(claims[0].also_flagged_by).toEqual([
            {
                source: "skill-auditor (out-of-lane)",
                line: 9,
                subject:
                    "The comment on line 8 " +
                    'says "Keeps at most 10 samples per key." but `const maxSamples ' +
                    "= 25`, so the doc and the enforced cap disagree.",
            },
            {
                source: "conventions",
                subject:
                    "Declaration doc comment doesn't begin with the " +
                    "symbol name.",
            },
            {
                source: "documentation",
                subject: "Comment states the wrong cap (10 vs 25).",
            },
        ]);
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-3",
                merged: [
                    {
                        id: "skill-auditor-ool-2",
                        source: "skill-auditor (out-of-lane)",
                        label: "question (non-blocking)",
                        line: 9,
                        via: "clusterer",
                        groundedBy: "evidence",
                    },
                    {
                        id: "conventions-1",
                        source: "conventions",
                        label: "nitpick (non-blocking)",
                        via: "clusterer",
                        groundedBy: "anchor",
                    },
                    {
                        id: "documentation-1",
                        source: "documentation",
                        label: "suggestion (non-blocking, documentation)",
                        via: "clusterer",
                        groundedBy: "anchor",
                    },
                ],
                path: "dev/af19_trial/window.go",
                line: 8,
                via: "clusterer",
                evidence:
                    "the doc comment on `maxSamples` says 10 while the constant is 25",
            },
        ]);
        expect(clusterRejections).toEqual([]);
    });

    it("keeps the run's neighbours on the same lines out of the cluster", () => {
        // The precision half of the same run: `first-principles-1` sits at :9
        // (the cluster's own second anchor) and `documentation-2` three lines
        // down, and both are distinct defects — hard-coded tunables and a
        // comment restating `staleAfter`. A proposal naming only the cap copies
        // must leave them alone, and their own text must not be pulled in by
        // the group they neighbour.
        const claims = [...wrongCapClaims(), ...capNeighbourClaims()];
        const {claims: kept} = dedupeClaims(claims, [
            {
                evidence: "the `maxSamples` comment claims a cap of 10, not 25",
                ids: [
                    "correctness-reviewer-3",
                    "skill-auditor-ool-2",
                    "conventions-1",
                    "documentation-1",
                ],
            },
        ]);
        expect(kept.map((c) => c.id)).toEqual([
            "correctness-reviewer-3",
            "first-principles-1",
            "documentation-2",
        ]);
    });

    it("drops a proposed member whose own text never names the shared evidence", () => {
        // The grounding tripwire: `documentation-2` is about `staleAfter`, so a
        // cluster grounded in the maxSamples cap cannot absorb it however
        // confidently the model listed it.
        const {claims, merges, clusterRejections} = dedupeClaims(
            [...wrongCapClaims(), ...capNeighbourClaims()],
            [
                {
                    evidence:
                        "the `maxSamples` comment claims a cap of 10, not 25",
                    ids: [
                        "correctness-reviewer-3",
                        "documentation-1",
                        "documentation-2",
                    ],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual([
            "correctness-reviewer-3",
            "skill-auditor-ool-2",
            "conventions-1",
            "first-principles-1",
            "documentation-2",
        ]);
        expect(merges[0].merged.map((m) => m.id)).toEqual(["documentation-1"]);
        expect(clusterRejections).toEqual([
            {id: "documentation-2", reason: "ungrounded"},
        ]);
    });

    it("holds a member off the survivor's line to the evidence, and inert evidence fails it", () => {
        // An identity claim this module cannot check on either path is inert,
        // not authoritative: "they are all about comments" grounds nothing, so
        // the :9 member falls back to tier 1 and stays its own comment. The
        // two members ON the survivor's line 8 no longer need the evidence at
        // all; the exactly shared anchor is the grounding (and the run's own
        // autofix discharged all four asks with one rewritten comment, so the
        // merge is the true outcome, not a concession).
        const {claims, merges, clusterRejections} = dedupeClaims(
            wrongCapClaims(),
            [
                {
                    evidence: "these are all about the same comment",
                    ids: [
                        "correctness-reviewer-3",
                        "skill-auditor-ool-2",
                        "conventions-1",
                        "documentation-1",
                    ],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual([
            "correctness-reviewer-3",
            "skill-auditor-ool-2",
        ]);
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-3",
                merged: [
                    {
                        id: "conventions-1",
                        source: "conventions",
                        label: "nitpick (non-blocking)",
                        via: "clusterer",
                        groundedBy: "anchor",
                    },
                    {
                        id: "documentation-1",
                        source: "documentation",
                        label: "suggestion (non-blocking, documentation)",
                        via: "clusterer",
                        groundedBy: "anchor",
                    },
                ],
                path: "dev/af19_trial/window.go",
                line: 8,
                via: "clusterer",
                evidence: "these are all about the same comment",
            },
        ]);
        expect(clusterRejections).toEqual([
            {id: "skill-auditor-ool-2", reason: "ungrounded"},
        ]);
    });

    it("never absorbs a blocking claim on the clusterer's word", () => {
        // The risk grading: a false tier-2 merge may cost an advisory comment,
        // never a blocking finding. Two blocking copies of one defect are
        // exactly the pair tier 1 was calibrated on, so tier 2 declines them
        // however grounded the proposal is, and both still post.
        const [note, question] = wrongCapClaims();
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                {...note, label: "issue (blocking)"},
                {
                    ...question,
                    id: "holistic-9",
                    source: "holistic",
                    label: "issue (blocking)",
                },
            ],
            [
                {
                    evidence: "the `maxSamples` cap comment says 10, not 25",
                    ids: ["correctness-reviewer-3", "holistic-9"],
                },
            ],
        );
        expect(claims).toHaveLength(2);
        expect(merges).toEqual([]);
        // Rejected before the union, so the proposal collapses to one member
        // and that member is recorded too: nothing about this proposal reaches
        // the merge core, which is what keeps it from reshaping a tier-1 group.
        expect(clusterRejections).toEqual([
            {id: "holistic-9", reason: "blocking-member"},
            {id: "correctness-reviewer-3", reason: "cluster-collapsed"},
        ]);
    });

    it("absorbs an advisory copy into a blocking survivor, keeping the severity", () => {
        // The other side of the same rule: severity is preserved by the
        // survivor choice, so the blocking copy is what posts.
        const [note, question] = wrongCapClaims();
        const {claims, merges} = dedupeClaims(
            [
                note,
                {
                    ...question,
                    id: "holistic-9",
                    source: "holistic",
                    label: "issue (blocking)",
                },
            ],
            [
                {
                    evidence: "the `maxSamples` cap comment says 10, not 25",
                    ids: ["correctness-reviewer-3", "holistic-9"],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual(["holistic-9"]);
        expect(claims[0].label).toBe("issue (blocking)");
        expect(merges[0].merged.map((m) => m.id)).toEqual([
            "correctness-reviewer-3",
        ]);
    });

    it("enforces tier 1's path and source rules on a proposed cluster", () => {
        const [note, question, conventions] = wrongCapClaims();
        const {claims, clusterRejections} = dedupeClaims(
            [
                note,
                {...question, path: "dev/af19_trial/other.go"},
                {...conventions, source: note.source, id: "correctness-4"},
            ],
            [
                {
                    evidence: "the `maxSamples` cap comment says 10, not 25",
                    ids: [
                        "correctness-reviewer-3",
                        "skill-auditor-ool-2",
                        "correctness-4",
                    ],
                },
            ],
        );
        expect(claims).toHaveLength(3);
        expect(clusterRejections).toEqual([
            {id: "skill-auditor-ool-2", reason: "other-path"},
            {id: "correctness-4", reason: "same-source"},
            {id: "correctness-reviewer-3", reason: "cluster-collapsed"},
        ]);
    });

    it("holds a cluster member to those rules when its text clears the floor too", () => {
        // The test above proves the rules only for members tier 1's floor
        // cannot reach, which is every fixture the clusterer is built for. The
        // dangerous member is the opposite one: a member whose prose DOES clear
        // the floor would, if it ever reached the union, take the similarity
        // branch and merge without meeting the path or source rule, recorded as
        // `via: "similarity"` — a reviewer's distinct finding dropped, with the
        // artifact naming the wrong tier. These copies are verbatim identical,
        // so the floor is decidedly not what keeps them apart.
        const [note] = wrongCapClaims();
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                note,
                {
                    ...note,
                    id: "documentation-9",
                    source: "documentation",
                    path: "dev/af19_trial/other.go",
                },
                {...note, id: "correctness-reviewer-9"},
            ],
            [
                {
                    evidence: "the `maxSamples` cap comment says 10, not 25",
                    ids: [
                        "correctness-reviewer-3",
                        "documentation-9",
                        "correctness-reviewer-9",
                    ],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual([
            "correctness-reviewer-3",
            "documentation-9",
            "correctness-reviewer-9",
        ]);
        expect(merges).toEqual([]);
        expect(clusterRejections).toEqual([
            {id: "documentation-9", reason: "other-path"},
            {id: "correctness-reviewer-9", reason: "same-source"},
            {id: "correctness-reviewer-3", reason: "cluster-collapsed"},
        ]);
    });

    it("records a proposed member that cannot anchor a comment", () => {
        // `path`/`line` are optional on a Claim (a finding whose anchor the
        // provenance gate could not place keeps its prose and loses its
        // anchor), and the survivor's anchor is what the merged comment posts
        // on, so an anchorless member is dropped from the cluster and recorded
        // rather than silently swallowed by the group it was named in.
        const [note, question, conventions] = wrongCapClaims();
        const {line: _, ...anchorless} = {
            ...conventions,
            id: "holistic-2",
            source: "holistic",
        };
        const {claims, merges, clusterRejections} = dedupeClaims(
            [note, question, anchorless],
            [
                {
                    evidence:
                        "the doc comment on `maxSamples` says 10 while the constant is 25",
                    ids: [
                        "correctness-reviewer-3",
                        "holistic-2",
                        "skill-auditor-ool-2",
                    ],
                },
            ],
        );
        // The rest of the cluster still merges, and the anchorless claim posts
        // as its own comment (on whatever anchor rendering gives it).
        expect(claims.map((c) => c.id)).toEqual([
            "correctness-reviewer-3",
            "holistic-2",
        ]);
        expect(merges[0].merged.map((m) => m.id)).toEqual([
            "skill-auditor-ool-2",
        ]);
        expect(clusterRejections).toEqual([
            {id: "holistic-2", reason: "no-anchor"},
        ]);
    });

    it("never lets an unverifiable proposal cost a merge tier 1 would have made", () => {
        // The floor under tier 2: it may add merges, never subtract them.
        // Membership used to be unioned before any member was checked, so a
        // proposal naming a cross-path claim pulled it into the group, where
        // its higher severity won the survivor election — and the genuine
        // tier-1 pair beneath it then collapsed to nothing, recorded in
        // neither `merges` nor `clusterRejections`. Three comments posted where
        // two would have, from a tier whose whole purpose is fewer.
        const [note] = wrongCapClaims();
        const pair = (over: Partial<Claim> & {id: string; source: string}) =>
            claim({...note, line: 8, ...over});
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                // Cross-path, and blocking so it out-ranks both of the others.
                pair({
                    id: "holistic-1",
                    source: "holistic",
                    path: "dev/af19_trial/other.go",
                    label: "issue (blocking)",
                }),
                pair({id: "documentation-1", source: "documentation"}),
                pair({id: "conventions-1", source: "conventions"}),
            ],
            [
                {
                    evidence: "`maxSamples`",
                    ids: ["holistic-1", "documentation-1"],
                },
            ],
        );
        // The tier-1 pair survives as a pair; only the cross-path claim posts
        // separately, exactly as it would have with no clusterer at all.
        expect(claims.map((c) => c.id)).toEqual([
            "holistic-1",
            "documentation-1",
        ]);
        expect(merges).toEqual([
            {
                survivor: "documentation-1",
                merged: [
                    {
                        id: "conventions-1",
                        source: "conventions",
                        label: "note (non-blocking)",
                    },
                ],
                path: "dev/af19_trial/window.go",
                line: 8,
                via: "similarity",
            },
        ]);
        expect(clusterRejections).toEqual([
            {id: "documentation-1", reason: "other-path"},
            {id: "holistic-1", reason: "cluster-collapsed"},
        ]);
    });

    it("never lets an UNGROUNDED proposal cost a merge tier 1 would have made", () => {
        // The same floor, reached by a member the structural screen cannot
        // catch: same path, distinct source, non-blocking — legal in every
        // respect except that the evidence grounds nothing. Screening structure
        // before the union was not enough, because grounding is only knowable
        // against the survivor and the survivor is only known after the union;
        // the guarantee comes from tier 1 being settled FIRST instead.
        const [note] = wrongCapClaims();
        const copy = (over: Partial<Claim> & {id: string; source: string}) =>
            claim({...note, line: 8, ...over});
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                // Out-ranks both on confidence, worded too thinly for the
                // text floor, and anchored one line off the copies so the
                // shared-anchor grounding path stays out of this fixture: it
                // is a cluster member and nothing else.
                claim({
                    ...note,
                    id: "holistic-1",
                    source: "holistic",
                    line: 9,
                    confidence: 0.9,
                    subject: "the per-key cap disagrees with `maxSamples`",
                    discussion: "the per-key cap disagrees with `maxSamples`",
                    failure_scenario: "the cap disagrees with `maxSamples`",
                }),
                copy({id: "documentation-1", source: "documentation"}),
                copy({id: "conventions-1", source: "conventions"}),
            ],
            [
                // Names no code element, so it can ground nothing.
                {
                    evidence: "these are all about comments",
                    ids: ["holistic-1", "documentation-1"],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual([
            "holistic-1",
            "documentation-1",
        ]);
        expect(merges).toEqual([
            {
                survivor: "documentation-1",
                merged: [
                    {
                        id: "conventions-1",
                        source: "conventions",
                        label: "note (non-blocking)",
                    },
                ],
                path: "dev/af19_trial/window.go",
                line: 8,
                via: "similarity",
            },
        ]);
        expect(clusterRejections).toEqual([
            {id: "documentation-1", reason: "ungrounded"},
        ]);
    });

    it("carries a tier-1 group whole when tier 2 absorbs its survivor", () => {
        // The subtraction shape no per-member screen can reach: every member
        // here is legal and grounded. Tier 1 folds three copies into one
        // comment; the clusterer then names ONE of them beside a
        // higher-ranked claim of its own. Unioning first would elect that
        // claim, absorb the single member named, and orphan the other two into
        // separate comments — three where tier 1 alone posted one. Reading the
        // named member at the comment it now posts under is what makes tier 2
        // additive: the head comes over with everything folded into it.
        const [note] = wrongCapClaims();
        const copy = (over: Partial<Claim> & {id: string; source: string}) =>
            claim({...note, line: 8, ...over});
        const {claims, merges} = dedupeClaims(
            [
                copy({id: "documentation-1", source: "documentation"}),
                copy({id: "conventions-1", source: "conventions"}),
                copy({id: "completeness-1", source: "completeness"}),
                claim({
                    ...note,
                    id: "holistic-1",
                    source: "holistic",
                    line: 8,
                    confidence: 0.9,
                    subject: "the per-key cap disagrees with `maxSamples`",
                    discussion: "the per-key cap disagrees with `maxSamples`",
                    failure_scenario: "the cap disagrees with `maxSamples`",
                }),
            ],
            [
                {
                    evidence: "`maxSamples`",
                    ids: ["holistic-1", "conventions-1"],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual(["holistic-1"]);
        expect(merges).toHaveLength(1);
        expect(merges[0].via).toBe("both");
        // The tier-1 survivor is the copy tier 2 absorbed; the two it had
        // already folded in come along, still credited to the text floor.
        expect(merges[0].merged).toEqual([
            {
                id: "documentation-1",
                source: "documentation",
                label: "note (non-blocking)",
                via: "clusterer",
                groundedBy: "anchor",
            },
            {
                id: "conventions-1",
                source: "conventions",
                label: "note (non-blocking)",
            },
            {
                id: "completeness-1",
                source: "completeness",
                label: "note (non-blocking)",
            },
        ]);
    });

    it("refuses a cluster whose SURVIVOR does not name the shared evidence", () => {
        // The grounding check runs against both ends, and the survivor end has
        // no other fixture: everywhere else the survivor is a cluster member
        // and names the evidence by construction. The gap it closes is tier 1
        // electing a survivor the clusterer never proposed — here a blocking
        // claim bridged in on the text floor, describing the retention window
        // rather than the cap. Ungrounded against THAT survivor, the identity
        // the model asserted says nothing about the comment the merge would
        // post under, so the cluster-only member stays its own comment.
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                claim({
                    id: "holistic-1",
                    source: "holistic",
                    path: "dev/af19_trial/window.go",
                    line: 8,
                    label: "issue (blocking)",
                    subject:
                        "The declaration comment above the constant states a retention bound the code does not enforce.",
                    failure_scenario:
                        "A maintainer sizes downstream buffers from the stated retention bound and under-provisions.",
                }),
                claim({
                    id: "correctness-reviewer-3",
                    source: "correctness-reviewer",
                    path: "dev/af19_trial/window.go",
                    line: 8,
                    label: "note (non-blocking)",
                    subject:
                        "The declaration comment above `maxSamples` states a retention bound the code does not enforce.",
                    failure_scenario:
                        "A maintainer sizes downstream buffers from the stated retention bound and under-provisions.",
                }),
                claim({
                    id: "documentation-1",
                    source: "documentation",
                    path: "dev/af19_trial/window.go",
                    line: 10,
                    label: "suggestion (non-blocking, documentation)",
                    subject: "Wrong cap in prose: 10 vs 25.",
                    failure_scenario:
                        "`maxSamples` is 25 and the doc says 10, so a reader trusts a number that was never true.",
                }),
            ],
            [
                {
                    evidence: "the `maxSamples` cap",
                    ids: ["correctness-reviewer-3", "documentation-1"],
                },
            ],
        );
        // Tier 1's merge stands; tier 2 contributes nothing to it.
        expect(merges).toHaveLength(1);
        expect(merges[0].survivor).toBe("holistic-1");
        expect(merges[0].via).toBe("similarity");
        expect(merges[0].merged.map((m) => m.id)).toEqual([
            "correctness-reviewer-3",
        ]);
        expect(claims.map((c) => c.id)).toEqual([
            "holistic-1",
            "documentation-1",
        ]);
        expect(clusterRejections).toEqual([
            {id: "documentation-1", reason: "ungrounded"},
        ]);
    });

    it("re-checks a screened member against the survivor tier 1 elects", () => {
        // The pre-screen anchors on the proposal's own members; tier 1 can then
        // bridge in a claim that out-ranks the anchor and becomes the survivor,
        // which is why the per-member rules run a second time against the
        // ACTUAL survivor. Here the cluster member and the elected survivor
        // share a source — legal against the anchor, not against the survivor —
        // and collapsing them would drop one of that reviewer's two findings.
        const [note] = wrongCapClaims();
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                // Bridged to `correctness-reviewer-3` by tier 1 (verbatim
                // copy, different source), and blocking, so it survives.
                claim({
                    ...note,
                    id: "documentation-2",
                    source: "documentation",
                    label: "issue (blocking)",
                }),
                claim({...note, id: "correctness-reviewer-3"}),
                // The clusterer's member: fine against the correctness anchor,
                // same source as the survivor tier 1 actually elects.
                claim({
                    ...note,
                    id: "documentation-1",
                    source: "documentation",
                    subject: "the per-key cap disagrees with `maxSamples`",
                    discussion: "the per-key cap disagrees with `maxSamples`",
                    failure_scenario: "the cap disagrees with `maxSamples`",
                }),
            ],
            [
                {
                    evidence: "`maxSamples`",
                    ids: ["correctness-reviewer-3", "documentation-1"],
                },
            ],
        );
        expect(merges).toHaveLength(1);
        expect(merges[0].survivor).toBe("documentation-2");
        expect(merges[0].merged.map((m) => m.id)).toEqual([
            "correctness-reviewer-3",
        ]);
        expect(claims.map((c) => c.id)).toEqual([
            "documentation-2",
            "documentation-1",
        ]);
        expect(clusterRejections).toEqual([
            {id: "documentation-1", reason: "same-source"},
        ]);
    });

    it("records ids the clusterer invented, and holds each claim to one cluster", () => {
        // The webapp#41197 lesson applied to tier 2: an empty merge list must
        // never be the only evidence. A clusterer naming claims that do not
        // exist is a staging or prompt failure, and the run records it.
        const {claims, merges, clusterRejections} = dedupeClaims(
            wrongCapClaims(),
            [
                {
                    evidence: "the `maxSamples` cap comment says 10, not 25",
                    ids: ["correctness-reviewer-3", "documentation-1"],
                },
                {
                    evidence: "the `maxSamples` cap comment again",
                    ids: [
                        "documentation-1",
                        "conventions-1",
                        "ghost-reviewer-7",
                    ],
                },
            ],
        );
        expect(merges).toHaveLength(1);
        expect(merges[0].merged.map((m) => m.id)).toEqual(["documentation-1"]);
        expect(claims.map((c) => c.id)).toEqual([
            "correctness-reviewer-3",
            "skill-auditor-ool-2",
            "conventions-1",
        ]);
        expect(clusterRejections).toEqual([
            {id: "documentation-1", reason: "already-clustered"},
            {id: "ghost-reviewer-7", reason: "unknown-id"},
            {id: "conventions-1", reason: "cluster-collapsed"},
        ]);
    });

    it("merges a same-defect pair the similarity tier cannot reach across anchors", () => {
        // The shape that is unmergeable by construction on tier 1: run
        // 29943085279's missing-deletion-test defect at two anchors, worded
        // with almost no shared prose. Tier 1 keeps them apart (it needs six
        // shared bigrams across lines); the grounded cluster merges them and
        // the survivor keeps the blocking label and its own anchor.
        const todo = claim({
            id: "test-adequacy-1",
            source: "test-adequacy",
            path: "services/ai-guide/memory/expiration_test.go",
            line: 15,
            label: "todo (blocking)",
            subject: "Nothing asserts DeleteMulti removes a stale memory.",
            failure_scenario:
                "A regression leaves ExpireStale identifying keys and never calling DeleteMulti, and CI stays green.",
        });
        const note = claim({
            id: "first-principles-4",
            source: "first-principles",
            path: "services/ai-guide/memory/expiration_test.go",
            line: 58,
            label: "note (non-blocking)",
            subject: "The suite never reaches the delete.",
            failure_scenario:
                "Both cases stop at DeleteMulti's caller, so the behavior the change exists for is unexercised.",
        });
        expect(dedupeClaims([todo, note]).merges).toEqual([]);
        const {claims, merges} = dedupeClaims(
            [todo, note],
            [
                {
                    evidence:
                        "no test asserts DeleteMulti deletes a stale memory in ExpireStale",
                    ids: ["test-adequacy-1", "first-principles-4"],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual(["test-adequacy-1"]);
        expect(claims[0].label).toBe("todo (blocking)");
        expect(claims[0].also_flagged_by).toEqual([
            {
                source: "first-principles",
                line: 58,
                subject: "The suite never reaches the delete.",
            },
        ]);
        expect(merges[0].via).toBe("clusterer");
        expect(merges[0].line).toBe(15);
    });

    it("marks a group both tiers contributed to", () => {
        // Tier 1 reaches the run-29943085279 todo/question pair; the third copy
        // is worded too thinly for any floor and arrives on the proposal. One
        // group, one comment, and the record says both tiers found it.
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
        const thin = claim({
            id: "first-principles-4",
            source: "first-principles",
            path: "services/ai-guide/memory/expiration_test.go",
            line: 58,
            label: "note (non-blocking)",
            subject: "The suite never reaches the delete.",
            failure_scenario:
                "Both cases stop at DeleteMulti's caller, so the behavior the change exists for is unexercised.",
        });
        expect(dedupeClaims([todo, thin]).merges).toEqual([]);
        const {claims, merges} = dedupeClaims(
            [todo, question, thin],
            [
                {
                    evidence:
                        "no test asserts ExpireStale reaches DeleteMulti for a stale memory",
                    ids: ["correctness-reviewer-3", "first-principles-4"],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual(["correctness-reviewer-3"]);
        expect(merges).toHaveLength(1);
        expect(merges[0].via).toBe("both");
        // Per COPY, not per group: only `first-principles-4` needed the
        // clusterer, and a reader counting tier 2's contribution from the
        // group's own `both` would credit it with the pair tier 1 already
        // had. The A/B's `clusterMerged` column reads this field.
        expect(merges[0].merged).toEqual([
            {
                id: "skill-auditor-ool-2",
                source: "skill-auditor (out-of-lane)",
                label: "question (non-blocking)",
                line: 58,
            },
            {
                id: "first-principles-4",
                source: "first-principles",
                label: "note (non-blocking)",
                line: 58,
                via: "clusterer",
                groundedBy: "evidence",
            },
        ]);
        // The record quotes only the copy tier 2 brought: the survivor's own
        // prose does not restate it, while the tier-1 copy's clearing of the
        // floor is the evidence that it does.
        expect(claims[0].also_flagged_by).toEqual([
            {source: "skill-auditor (out-of-lane)", line: 58},
            {
                source: "first-principles",
                line: 58,
                subject: "The suite never reaches the delete.",
            },
        ]);
    });
});
