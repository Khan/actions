/**
 * The three Khan/webapp#41609 comments (review-v1.14.0, posted 2026-08-20
 * 16:28:08, sxkosone's "still as poetic as before" feedback) as rubric
 * fixtures for the prose judge. Bodies are the posted text verbatim, split
 * into the label and the discussion the way the claim schema carries them
 * (renderClaimComment reassembles the identical posted body).
 *
 * These are the judge's calibration set: the SPEC.md comment is the named
 * complaint ("Graduation removes the last runtime lever ... no kill switch
 * remains" — rule 1, metaphor; "cheap insurance" too) and the done-when
 * requires it to FAIL; all three are 100+ words of dense prose on
 * non-blocking labels, so the loose length tier (rule 3 through
 * LABEL_RUBRIC_EXTRA) has jurisdiction over each. Consumed by the unit
 * tests (mechanics, with a stubbed runner) and by eval/judge-prose-live.ts
 * (real-model verdicts; the assertion that matters).
 */

export type ProseFixture = {
    /** The GitHub comment id, for tracing back to the PR. */
    commentId: number;
    path: string;
    label: string;
    discussion: string;
    /** What the live judge must say about it. */
    expected: "fail" | "unpinned";
};

export const FIXTURES_41609: readonly ProseFixture[] = [
    {
        commentId: 3823429669,
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        label: "thought (non-blocking)",
        discussion:
            "Behavior now applies to all v2 moderation configs, not just the 3 the experiment measured. The experiment enrolled only Exercise, activity-tutor-me, and classroom-learner-exercise (the only files that imported moderation-parallelism.yaml), but this gating change flips parallel moderation on for every v2 config containing a moderation modifier — a much larger set (grep for PreFlightModerationCheck/moderation across config_files shows dozens). The parallel path is config-agnostic so the risk is low, but the 'no regressions' evidence covers a subset; worth a conscious confirmation that the broader rollout is intended and safe.",
        expected: "unpinned",
    },
    {
        commentId: 3823429676,
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        label: "question (non-blocking)",
        discussion:
            "The experiment enrolled 3 configs; this graduates the behavior to every v2 config that runs moderation (~112 config files declare pre_flight_moderation_check). I checked config_files/: only Exercise.json, activity-tutor-me.json, and classroom-learner-exercise.json imported the moderation-parallelism partial, while 112 of 151 v2 configs declare the moderation modifier — all of which now flip to parallel in one step. Parallel mode also means every flagged turn still pays for a main completion whose output is discarded, so the cost profile on high-flag-rate configs outside the experiment is unmeasured; was a staged rollout (e.g. graduating the experimented configs first) considered and rejected?",
        expected: "unpinned",
    },
    {
        commentId: 3823429680,
        path: "services/ai-guide/moderation/spec/SPEC.md",
        label: "thought (non-blocking)",
        discussion:
            "Graduation removes the last runtime lever for moderation ordering — no kill switch remains, unlike the sibling moderationSystem experiment. The SPEC's flag table shows the neighboring CGC work kept a `global-cgc-enabled` kill switch after its experiment, while this change hardcodes parallelism (the moderation-first v2 path is now unreachable code driven only from tests). Deleting the experiment plumbing matches repo convention, so this is only a thought: given the blast radius above, a short-lived kill switch for one or two deploy cycles might have been cheap insurance.",
        expected: "fail",
    },
];

/**
 * The clean control: prose that SHOULD pass, because every 41609 fixture is
 * drawn from the complaint and a fixture set with no expected-pass case
 * cannot show over-flagging. This is the second calibration run's rewrite
 * of 3823429676 (456 chars, facts intact, question kept), kept as the
 * canary the live script prints a loud warning about when the judge flags
 * it. Deliberately not a pinned assertion: a style judgment call should
 * not block a merge, it should be visible when it drifts.
 */
export const CLEAN_CONTROLS: readonly ProseFixture[] = [
    {
        commentId: 3823429676,
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        label: "question (non-blocking)",
        discussion:
            "The experiment enrolled 3 configs; this enables parallel moderation in all v2 configs that declare `pre_flight_moderation_check` (~112 of 151 config files). Only Exercise.json, activity-tutor-me.json, and classroom-learner-exercise.json currently import the moderation-parallelism partial. In parallel mode, every flagged turn pays for a main completion whose output is discarded. Was a gradual rollout considered, starting with the 3 experimented configs?",
        expected: "unpinned",
    },
];

/**
 * Rule-2 (repetition) calibration fixtures from production, per the
 * 2026-08-20 reviewer version audit (plans records): its blind-judged
 * sample found 5 repetition fails in 29 W4-W5 bodies, every one the same
 * mode, restating one fact two to four times. The 41609 set above
 * calibrates rule 1 on the named complaint; these calibrate rule 2 on real
 * posted bodies (3768804982's rendered `<details>` ride-along is stripped:
 * the judge governs authored prose, and the collapsed section is
 * code-appended at the plan surface, not authored).
 *
 * Run 8 split the pair: 3754335178 fails cleanly (the cost point stated 3
 * times with nothing new between statements) and stays pinned; 3768804982
 * passed under opus on run 8 and FAILED on run 9 (verbosity), so the case
 * is not an audit-vs-opus disagreement but genuinely borderline: its
 * "restatements" bracket new evidence (topic sentence, the
 * delete_user_data.go investigation, restated conclusion), a
 * summary-then-detail shape one judge lands on differently per run. It
 * stays as an UNPINNED probe: printed every run so the contested boundary
 * is visible, gating nothing, and its production cost is bounded (a
 * bracket-shaped comment occasionally eats one capped bounce). The
 * audit's other three fail ids (3694218854, 3769221714, 3762664308) are
 * the same bracket shape, so no second pin was minted from them.
 */
export const FIXTURES_RULE2: readonly ProseFixture[] = [
    {
        commentId: 3754335178,
        path: "services/ai-guide/moderation/escalation_check/versions.go",
        label: "note (non-blocking)",
        discussion:
            'V2 RC1 preset silently adds ServiceTier: "priority" (and temperature 1.0), unmentioned in the description. The description characterizes the RC as gpt-5.2 low-reasoning + revised prompt; the registry entry additionally sets ServiceTier "priority" (cost/latency impact) and Temperature 1.0. Temperature 1.0 is plausibly required for the reasoning model, but the priority tier is a substantive, cost-bearing behavior not called out in the stated intent — worth surfacing so the rollout\'s cost profile is understood.',
        expected: "fail",
    },
    {
        commentId: 3768804982,
        path: "services/ai-guide/chat/threads/facets.go",
        label: "note (non-blocking)",
        discussion:
            "Decommission leaves orphaned per-user AIGuideMemory data in Datastore with no deletion path. Pre-existing gap, amplified by this change: I checked services/ai-guide/delete_user_data/delete_user_data.go (it enumerates AIGuideThread, ImageMetadata, AIGuideAcceptance, etc. but never AIGuideMemoryKind) and ran `git log -S AIGuideMemoryKind` over the deletion flow — user deletion never covered this kind even before this PR, so the retention itself is pre-existing; this change amplifies it by deleting the model and all query/delete capability, turning the (flag-gated, so presumably small) set of stored user records into permanently unreachable orphaned data. Consider a one-off wipe of the AIGuideMemory kind (e.g. via a backfill or Datastore admin bulk delete) as part of decommissioning, before or shortly after this lands while the entity shape is still known.",
        expected: "unpinned",
    },
];
