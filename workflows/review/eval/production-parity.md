# Measuring an added reviewer

A reviewer earns its place by catching useful defects the existing roster misses, not by producing more comments. Budget recovery, overlapping findings, and displaced coverage need separate accounting.

## What this instrument measures

- Live dispatch calls production's `computeRoster` after routing and credit clamping. The staged `routing.json`, dispatch roster, and scored routing use the same effective budget. Full, scoped, flip-gated, and fast depths use the same roster function as production.
- The baseline reads its literal `DEFAULT_TIER_BUDGETS` from `--base-ref`, without executing code from that ref. The candidate reads its working-tree table. Invalid or dynamic tables fail before dispatch. Other pipeline code is shared candidate infrastructure, not a replay of every implementation detail at the baseline ref.
- `--baseline-disable-reviewers` and `--candidate-disable-reviewers` remove named opt-ins without changing prompts or budgets. A missing agent definition is recorded as absent, not a quiet invocation. All configurations are checked before spending on the first case.
- Per-agent timeouts, turn limits, and concurrency share production constants. These are execution limits, not guarantees about total billed workflow cost. Between-case dollar caps retain their existing behavior.
- Live scoring uses production's inline selection function: blocking first, medium before minor, confidence floor, no inline nitpicks, the shared non-blocking budget, and the absolute 20-comment cap. Label-shape labels and medium importance survive normalization. Collapsed findings remain visible findings for recall, duplicates, and false flags.
- Failed core reviewers affect the hold gate. A hold emits no planned inline comments. Recorded-only smoke replay retains its historical posting semantics unless `posting` is requested.

`perCase.accounting.coverage` records planned, dispatched, shed, absent, and failed reviewers. `complete` covers the modeled stages only. `omittedStages` explicitly records pattern triage, which this harness still doesn't run. The native investigation-cap and validator-correction work are separate changes. This is not a claim of complete workflow parity, and these remaining boundaries must be checked before using a paid result to enable a reviewer.

## Reading value rather than volume

`perCase.accounting.usefulDefects` groups must-catch and audited may-flag matches by defect key. It preserves sources and both inline and collapsed surfaces. `mergedProposalSources` records dedup attribution, not independently validated credit for each absorbed proposal.

The top-level `value` block pairs cases and reports gained, lost, and shared useful defect keys, inline displacement, changed budget sheds, cost delta, and unpaired cases. A finding that moves below the inline bar is displaced inline coverage, not a lost catch. Cost per net useful catch is null when the net gain is zero or negative. Unmatched findings still need human audit before they're called false positives. Must-not-flag matches and clean-case flags remain separate existing metrics.

The report's instrument version includes `posting-v1+threads-v2`, so historical results from the old posting instrument don't pool silently with these results. Identical-prompt comparisons measure only run-to-run variation when the budget tables, disabled reviewers, and review modes also match.

## Required comparison

Use the full consumer opt-in roster, not only adjacent reviewers: `holistic`, `completeness`, `test-adequacy`, `first-principles`, `conventions`, and `documentation`, plus the two defaults and every routed lens.

Run three configurations on fixed case snapshots after explicit spend approval:

1. Old cap, added reviewer off.
2. New cap, added reviewer off. The delta from configuration 1 is cap recovery.
3. New cap, added reviewer on. The delta from configuration 2 is the reviewer's incremental value.

Keep surrounding prompts, reviewer priority, dedup rules, model pins, credits, and inline budget fixed for the off/on pair. Include seeded positives, clean counterexamples, existing-owner overlap controls, lens-heavy cases, and reduced-credit cases. Repeat enough to separate a useful effect from run-to-run variance.

Displacement isn't an automatic veto. Report the useful catches gained, useful catches lost, inline coverage displaced, overlap, false positives, and cost together. Decide whether the trade is worthwhile. A shed or failed reviewer isn't a clean pass, and an unrun case isn't zero recall or zero false positives.

## Zero-cost controls and evidence

`live-parity.test.ts` and `field-parity.test.ts` use scripted output. They make no model calls and don't estimate a reviewer's real recall.

`field-parity-evidence.json` records the September 3-8, 2026 webapp audit: 155 PRs, 146 footer-bearing rounds, and 317 top-level bot inline comments. It includes:

- Nine final low-tier, full-depth rosters. Tests reproduce all nine observed sheds, including the two-lens round that changed from an initial high tier to a final low tier. The tests replay the final routing conditions, not the earlier provisional budget.
- Five same-round duplicate families: ten comments about five defects. Scripted copies at the audited locations exercise same-file and cross-file matching, plus inline/collapsed accounting. These are accounting controls, not downloaded source fixtures or new model evidence.
- The cross-round missing-seed-target control. An explicitly labeled mechanism recognizes the same defect after its anchor moves. Audited `relatedPaths` extend a kept thread to its other occurrences. Different mechanisms and unaudited files remain negative controls.
- Two source-checked useful catches already owned by holistic and skill-auditor. The off/on controls don't count a new source's copy as an incremental catch.

Run these checks with `pnpm exec vitest run workflows/review/eval/live-parity.test.ts workflows/review/eval/field-parity.test.ts`.

Before paying for a new corpus, replay its recorded positive findings through `matchCase`, exercise nearby negative mechanisms, and typecheck each fixture tree. Fix the fixture or its specific mechanism alternatives, not the matcher globally, when only that case is wrong. Keep matcher search out of `evidence_trace`: quoting a symbol isn't a finding about it.
