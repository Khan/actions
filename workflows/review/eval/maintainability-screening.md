# Maintainability reader-cost screening

A finding must establish that a cleanup is worth the reader's attention, not only that two definitions look alike or a name could be more explicit. The reviewer and claim-validator require a concrete maintenance task, evidence of the extra work, and a proposed fix that reduces that work without losing behavior or a useful boundary.

## Current controls

The reader-cost screening subset contains five seeded positives, one clean reuse case, and three clean reader-cost controls. These nine enable the full consumer opt-in roster, as do the 20 additional cases in the [expanded corpus](maintainability-corpus.md). None is tagged `smoke`.

- `clean-maintainability-small-adapter` adds an identical short filesystem adapter to a second report command. The adapter has no policy, and comparing the two definitions is not enough to establish a maintenance burden. The test verifies that the initializer bodies are identical.
- `clean-maintainability-documented-retry` has a callback named `parse` that can redispatch a model call. Its signature, adjacent contract, and caller expose that behavior. Tests establish that it makes one corrective attempt, stages the replacement reply, and fails after a second malformed response.
- `clean-maintainability-transaction-wrapper` has one production caller for `storeOrder`. The wrapper owns the transaction around order insertion and stock reservation. Tests establish that both operations run in that transaction callback and that reservation failure propagates to the transaction owner.

These are synthetic controls, not historical production snapshots. The first two were motivated by a manual audit whose findings met the evidence bar but had a weak reader-cost case. Recorded positive prose names the maintenance task and the benefit of its proposed fix. Passing deterministic matching and typechecking does not show that a model will accept the positives or stay silent on the controls.

## Historical candidates, not scored positives

Two source-backed changes provide candidate material. Their fixes also address correctness, so neither has been labeled as an incremental maintainability catch.

- [actions#292](https://github.com/Khan/actions/pull/292), commit `cc23d7cc9b27f494feda925f0e1117ee78f85997`, replaced repeated JSON extraction in `live-producer.ts`, `judge-live-model.ts`, and `match-arbiter.ts` with `extract-json.ts`. The commit records recurring parse failures and shows that the callers had different error behavior. A historical case would need to distinguish the coordinated parsing-policy maintenance task from the correctness bug. It must not label the whole caller functions equivalent or discard their error handling.
- [actions#308](https://github.com/Khan/actions/pull/308), commit `83d14c3c6066d07dcd360f89c02df9f25ff844fb`, shared thread fetching and bot identity between workflows. The commit records why staging and suppression must agree about identity and why fetch guards should not be reimplemented. The merged change already shares them. A case must identify an actual earlier change that created the burden, rather than presenting the completed extraction as a defect or inventing a duplicate prehistory.

The sources were inspected as raw git objects. They establish candidate provenance, not a measured reviewer success. Selecting historical positives remains open. A later refactor alone does not prove that the earlier form warranted a maintainability comment.

## Admit a historical case

1. Pin the introducing change and a later fix. Verify the actual pre-fix definitions, callers, and contract. Preserve enough surrounding source to distinguish a useless layer from a meaningful boundary.
2. Record the maintenance task and reader cost separately from any correctness failure. Have that distinction checked before assigning a maintainability must-catch spec. Use existing-owner overlap controls when the useful finding is already a correctness or holistic catch.
3. Stage only the introducing diff, its post-change tree, and contemporaneous PR context. Keep later fix diffs, commit messages, expected findings, and source-selection notes outside `tree/` and outside staged context. Verify the staged files, not only the corpus directory layout.
4. Replay recorded positives, test nearby false-flag mechanisms, and typecheck the fixture tree. A fix that makes the maintenance finding inapplicable should be a paired clean control when it can be represented without introducing unrelated changes.
5. Request approval for a priced live comparison under the [full comparison protocol](production-parity.md). Keep the reviewer disabled until the result supports enabling it. Report actionable unique findings, overlap, false positives, missed useful findings, cost, and displaced coverage rather than raw comment count.
