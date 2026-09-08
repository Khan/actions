# Maintainability corpus coverage

The corpus now has 26 maintainability cases: the original six screening cases and 20 independently authored additions. All are synthetic. None contains private repository source, none is a historical PR replay, and none is tagged `smoke`. Maintainability remains disabled outside these eval configurations. No paid model runs were used to construct or calibrate the additions.

The additions cover nine families, not 20 independent PR samples. Nine cases have positive expectations and 11 are clean controls. The two mixed-export cases deliberately reuse the same source under different credit caps. Their five expectations each count twice in case-level recall but represent the same five defects. Across the additions there are 17 positive spec occurrences, 12 distinct defect keys, and 12 explicit false-flag traps. The original six remain a separate calibration set.

## Coverage matrix

The descriptive names below are manifest metadata. Agents receive opaque `maint-snapshot-<hash>` IDs, ordinary PR descriptions, diffs, and post-change trees, not these names or expected findings.

| Family | Cases | Partition | Intended distinction |
| --- | ---: | --- | --- |
| Money conversion search | 5 | Development | Equivalent helper under a different name, direct reuse, incompatible error behavior, incompatible input types, and an observable ledger side effect |
| Quota naming | 2 | Development | A predicate consumes quota in a preview caller, versus an explicit reservation with a read-only preview |
| Delivery boundary | 2 | Development | One implementation and one caller forwarding unchanged, versus two live implementations supplied by callers |
| Existing debt | 1 | Development | Identical old duplicates remain outside the changed behavior |
| Mixed export | 2 | Development | Two maintainability findings compete with independent security, documentation, and completeness findings, at normal and reduced credits |
| Stock lookup | 2 | Development | Repeated lookup and validation, versus shared logic preserving different numeric and display defaults |
| Encoding fixtures | 2 | Development | Copied nested fixture data, versus shared fresh fixtures with both format checks preserved |
| Attachment mode | 2 | Reserved holdout | A positional boolean crosses three files, versus an explicit option consumed at the entry point |
| Retry guard | 2 | Reserved holdout | An unreachable repeated guard, versus a reachable branch with a concrete witness |

All five finding types have positive and matched negative coverage across the expanded set. The original six provide development examples for the two types whose new families are reserved. Every case enables the six existing consumer opt-ins plus maintainability. The default correctness and skill reviewers still participate through production roster computation.

In the comparisons below, cap8/off means a reviewer invocation cap of 8 with maintainability disabled. cap9/off and cap9/on use a cap of 9 with maintainability disabled or enabled, respectively.

The mixed-export pair requests `security-auth` and low risk. With ample credits, cap8/off sheds documentation, cap9/off recovers it, and cap9/on sheds it again while dispatching maintainability. With 100 credits, maintainability is itself shed. These are controlled configurations, not observed production frequencies. The reference findings also exercise four non-blocking claims competing for three inline slots, plus a blocking claim. Collapsed findings remain scored.

## Isolation and reproducibility

`maintainability-corpus-manifest.json` pins each case JSON, each tree file, the changed files' before-images, and the unchanged maintainability prompt section. A tree digest is also included in each case's tags so the existing corpus hash changes when search context changes. `paidRunsAtFreeze` records the construction state, not an ongoing run counter.

Before-images live at `before/<source-path>.txt`. Integrity tests apply each unified diff to those images and compare the result with the staged tree. Only `tree/` is copied into an agent checkout. Case JSON, the manifest, negative witnesses, and before-images are not staged. All 20 added trees typecheck as strict TypeScript. Executable tests verify the counterexamples' type, error, mutation, side-effect, branch, and fixture-isolation distinctions.

The four reserved cases carry both `holdout` and `reserved-holdout`. Routine full and smoke selections exclude them. Explicit `--cases` selection also rejects them unless `--include-reserved-holdout` is supplied. That flag unlocks selection, not spending approval. Holdout families never straddle the development split.

The holdout is prospective and authored by the same corpus builder, not an independent external benchmark. Zero-cost reference matching and behavioral assertions establish its labels. They are not model outputs used for tuning. Once a model result from a reserved case influences the prompt, matcher, or fixture, retire that family from holdout and replace it. Freeze prompt, matcher, source, and run configuration before opening the holdout.

## What the checks establish

The recorded findings and reviewer-source assignments are authored test inputs, not captured reviewer output. They verify matching and accounting only. Positive references require the expected location and mechanism. Unrelated anchors and mechanism text present only in `evidence_trace` do not satisfy them. Explicit negative witnesses test that incorrect claims can be scored as false flags rather than disappearing into unmatched noise.

Run the checks without model calls: `pnpm exec vitest run workflows/review/eval/maintainability-calibration.test.ts workflows/review/eval/maintainability-corpus.test.ts workflows/review/eval/maintainability-corpus-behavior.test.ts`.

## Remaining evidence gaps

- Synthetic performance cannot establish production frequency, independent real-world usefulness, or a production false-positive rate.
- Assigned overlap sources do not establish that another reviewer will actually find the same defect. Only the full-roster comparison can measure that.
- The clean cases cover explicit contracts in bounded projects, not all reasonable abstraction or duplication decisions in a large repository.
- The holdout contains two new families, not independent held-out samples of every finding type. Paired and repeated fixtures must not be counted as independent evidence.
- The separate manual snapshot audit is complementary evidence. It is not a live pipeline result or part of this holdout.
- Production parity still has the omissions documented in [production-parity.md](production-parity.md), including pattern triage.

Before paid evaluation, settle the remaining harness prerequisites, freeze the corpus and configuration, and request approval for a fresh bounded spend estimate. Compare cap8/off, cap9/off, and cap9/on with the full roster. Report unique useful defects gained and lost, overlap, false positives including collapsed claims, inline displacement, failed or shed coverage, and cost. Do not turn a shed or failed reviewer into a zero-recall measurement of its prompt. Neither these zero-cost checks nor the original six-case cost estimate is an enablement gate.
