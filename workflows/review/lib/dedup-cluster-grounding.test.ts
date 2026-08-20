import {describe, it, expect} from "vitest";

import {dedupeClaims} from "./dedup";
import {salientTokens} from "./dedup-cluster";
import type {Claim} from "./dispatch-contracts";

/**
 * Tier 2's grounding paths, pinned by the run that reshaped them. Split from
 * `dedup-cluster.test.ts` for its max-lines budget, exactly as that file was
 * split from `dedup.test.ts`; the `claim` factory mirrors theirs.
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
 * Run 32390393344 (webapp#41609, review-v1.17.0): the grounding tripwire's
 * one measured false veto, verbatim from that run's `out/claims.json` and
 * `out/claim-clusterer.json`. Two sources filed one finding (the experiment
 * enrolled 3 configs, the change flips ~112) as two comments on
 * `moderation_helpers.go:31`, the clusterer correctly proposed them as one
 * cluster, and the run posted both anyway: its evidence spoke in the hunk's
 * identifiers (`_configIncludesModeration`, `shouldModerateDuringMainCompletion`)
 * while both claims spoke config-side (`pre_flight_moderation_check`,
 * `config_files`), zero shared salient tokens, so the member was rejected
 * "ungrounded". The shared-anchor grounding path exists because of this run;
 * these tests replay it and pin the merge.
 */
const runClaims = (): Claim[] => [
    claim({
        id: "holistic-1",
        source: "holistic",
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        line: 31,
        label: "thought (non-blocking)",
        subject:
            "Behavior now applies to all v2 moderation configs, not just the 3 the experiment measured.",
        discussion:
            "Behavior now applies to all v2 moderation configs, not just the 3 the experiment measured. The experiment enrolled only Exercise, activity-tutor-me, and classroom-learner-exercise (the only files that imported moderation-parallelism.yaml), but this gating change flips parallel moderation on for every v2 config containing a moderation modifier — a much larger set (grep for PreFlightModerationCheck/moderation across config_files shows dozens). The parallel path is config-agnostic so the risk is low, but the 'no regressions' evidence covers a subset; worth a conscious confirmation that the broader rollout is intended and safe.",
        failure_scenario:
            "A v2 config that runs moderation but was never enrolled in the moderationParallelism experiment (e.g. one of the many other config_files that include a moderation modifier) now moderates in parallel; if any such config relied on moderation-first ordering in a way the 3 enrolled configs did not, it regresses without ever having been measured.",
        confidence: 0.5,
    }),
    claim({
        id: "first-principles-1",
        source: "first-principles",
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        line: 31,
        label: "question (non-blocking)",
        subject:
            "The experiment enrolled 3 configs; this graduates the behavior to every v2 config that runs moderation (~112 config files declare pre_flight_moderation_check).",
        discussion:
            "The experiment enrolled 3 configs; this graduates the behavior to every v2 config that runs moderation (~112 config files declare pre_flight_moderation_check). I checked config_files/: only Exercise.json, activity-tutor-me.json, and classroom-learner-exercise.json imported the moderation-parallelism partial, while 112 of 151 v2 configs declare the moderation modifier — all of which now flip to parallel in one step. Parallel mode also means every flagged turn still pays for a main completion whose output is discarded, so the cost profile on high-flag-rate configs outside the experiment is unmeasured; was a staged rollout (e.g. graduating the experimented configs first) considered and rejected?",
        failure_scenario:
            "A config that was never enrolled in the experiment (different traffic shape, flag rate, or completion cost) hits a latency or spend regression that the three-config experiment could not have surfaced.",
        confidence: 0.5,
    }),
    claim({
        id: "first-principles-2",
        source: "first-principles",
        path: "services/ai-guide/moderation/spec/SPEC.md",
        line: 148,
        label: "thought (non-blocking)",
        subject:
            "Graduation removes the last runtime lever for moderation ordering — no kill switch remains, unlike the sibling moderationSystem experiment.",
        discussion:
            "Graduation removes the last runtime lever for moderation ordering — no kill switch remains, unlike the sibling moderationSystem experiment. The SPEC's flag table shows the neighboring CGC work kept a `global-cgc-enabled` kill switch after its experiment, while this change hardcodes parallelism (the moderation-first v2 path is now unreachable code driven only from tests). Deleting the experiment plumbing matches repo convention, so this is only a thought: given the blast radius above, a short-lived kill switch for one or two deploy cycles might have been cheap insurance.",
        failure_scenario:
            "If parallel moderation misbehaves in production, the only remedy is a code revert through the full deploy pipeline rather than a flag flip, lengthening incident response on a child-safety-adjacent path.",
        confidence: 0.5,
    }),
];

describe("run 32390393344's vetoed true merge", () => {
    it("folds casing styles, so one config key spelled two ways is one token", () => {
        expect(salientTokens("`PreFlightModerationCheck`")).toEqual(
            salientTokens("pre_flight_moderation_check"),
        );
        expect(salientTokens("pre_flight_moderation_check")).toEqual(
            new Set(["preflightmoderationcheck"]),
        );
    });

    it("drops an all-underscore token rather than grounding two claims on it", () => {
        // `_` is salient by the underscore rule but canonicalizes to nothing;
        // without canonicalToken's empty-string guard it would enter the set
        // and ground any two claims that each quote a Go blank identifier.
        expect(salientTokens("if _, ok := m[k]; !ok")).toEqual(new Set());
    });

    it("merges the pair on the shared anchor, whatever the evidence's vocabulary", () => {
        const {claims, merges, clusterRejections} = dedupeClaims(runClaims(), [
            {
                evidence:
                    "`return _configIncludesModeration(input.Config)` in `shouldModerateDuringMainCompletion` now applies parallel moderation to all v2 configs, not just the 3 the experiment enrolled",
                ids: ["holistic-1", "first-principles-1"],
            },
        ]);
        expect(claims.map((c) => c.id)).toEqual([
            "holistic-1",
            "first-principles-2",
        ]);
        expect(claims[0].also_flagged_by).toEqual([
            {
                source: "first-principles",
                subject:
                    "The experiment enrolled 3 configs; this graduates the " +
                    "behavior to every v2 config that runs moderation (~112 " +
                    "config files declare pre_flight_moderation_check).",
            },
        ]);
        expect(merges).toEqual([
            {
                survivor: "holistic-1",
                merged: [
                    {
                        id: "first-principles-1",
                        source: "first-principles",
                        label: "question (non-blocking)",
                        via: "clusterer",
                        groundedBy: "anchor",
                    },
                ],
                path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
                line: 31,
                via: "clusterer",
                evidence:
                    "`return _configIncludesModeration(input.Config)` in `shouldModerateDuringMainCompletion` now applies parallel moderation to all v2 configs, not just the 3 the experiment enrolled",
            },
        ]);
        expect(clusterRejections).toEqual([]);
    });
});

/**
 * What the anchor path gives up, pinned so the trade stays recorded rather
 * than rediscovered. Modeled on run 30587343777's counterexample (the fixture
 * in dedup-cluster.test.ts): the cap survivor names `staleAfter` in a
 * while-here aside, and `documentation-2` is the genuinely distinct
 * staleAfter finding that used to be saved from a bad proposal by the
 * vocabulary tripwire alone. At its real anchor (:11, three lines off the
 * survivor) it still is — the "drops a proposed member whose own text never
 * names the shared evidence" test holds that line. Re-anchored to the
 * survivor's own :8, no check runs at all: the model's identity assertion is
 * taken at its word, the advisory finding folds in, and its subject survives
 * only inside also_flagged_by. The bound is the tier's risk grading — only a
 * non-blocking copy can be lost this way, and only one the model itself
 * proposed.
 */
describe("the anchor path's accepted cost", () => {
    it("absorbs a distinct non-blocking finding sitting on the survivor's exact line", () => {
        const {claims, merges, clusterRejections} = dedupeClaims(
            [
                claim({
                    id: "correctness-reviewer-3",
                    source: "correctness-reviewer",
                    path: "dev/af19_trial/window.go",
                    line: 8,
                    label: "note (non-blocking)",
                    subject:
                        "Comment says the per-key cap is 10 but maxSamples is 25.",
                    discussion:
                        'Comment says the per-key cap is 10 but maxSamples is 25. Introduced by this change. The comment on `maxSamples` reads "Keeps at most 10 samples per key" while the constant is 25 — a factually wrong comment from the moment it lands, which the repo conventions explicitly call out ("keep comments true"). While here: the adjacent `// staleAfter is 15 minutes.` comment, and the inline `// Append the sample to the slice for this key.` / `// Add the sample to the result.` comments, restate the code rather than explain why — the root contract asks for why-comments; consider dropping them.',
                    failure_scenario:
                        "Comment says the per-key cap is 10 but maxSamples is 25",
                }),
                claim({
                    id: "documentation-2",
                    source: "documentation",
                    path: "dev/af19_trial/window.go",
                    line: 8,
                    label: "suggestion (non-blocking, documentation)",
                    subject: "Comment restates the constant.",
                    discussion:
                        "Comment restates the constant. `// staleAfter is 15 minutes.` restates `const staleAfter = 15 * time.Minute` verbatim; the code already says exactly this. Delete the comment.",
                    failure_scenario:
                        "The reader maintains a comment that restates the literal it sits on; if the duration changes and the comment doesn't, it becomes a lie.",
                }),
            ],
            [
                {
                    evidence:
                        "the `maxSamples` comment claims a cap of 10, not 25",
                    ids: ["correctness-reviewer-3", "documentation-2"],
                },
            ],
        );
        expect(claims.map((c) => c.id)).toEqual(["correctness-reviewer-3"]);
        expect(claims[0].also_flagged_by).toEqual([
            {
                source: "documentation",
                subject: "Comment restates the constant.",
            },
        ]);
        expect(merges).toEqual([
            {
                survivor: "correctness-reviewer-3",
                merged: [
                    {
                        id: "documentation-2",
                        source: "documentation",
                        label: "suggestion (non-blocking, documentation)",
                        via: "clusterer",
                        groundedBy: "anchor",
                    },
                ],
                path: "dev/af19_trial/window.go",
                line: 8,
                via: "clusterer",
                evidence: "the `maxSamples` comment claims a cap of 10, not 25",
            },
        ]);
        expect(clusterRejections).toEqual([]);
    });
});
