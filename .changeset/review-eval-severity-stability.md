---
"review": patch
---

Eval instrumentation only: report a per-spec **blocking rate** alongside the per-spec catch rate, so severity is observable per defect instead of only per case. Spec matching scores detection — a `mustCatchSpec` is satisfied by anchor agreement plus a mechanism regex, and none of the 41 must-catch specs in the corpus constrains the label (the only two `blockingOnly` flags sit on `mustNotFlagSpecs` traps, where the field means the opposite thing) — so a run can score 100% must-catch recall while labelling every seeded defect a nitpick. `verdictAgreement` cannot substitute, being a whole-case check that any other blocking finding compensates for: on Khan/webapp#41194 `TopKey`'s zero-floor bug was labelled blocking and held the verdict at REQUEST_CHANGES while a claim-validator-*confirmed* nil-map panic posted as `suggestion (non-blocking)`.

Four field-plumbing changes, no new model spend and no new dispatches: `SpecMatch` carries the matching candidate's `blocking` flag (copied from `RunCandidate.blocking`, which is code-computed from `severity`, never model-authored); `SampleRun` parses those into a sparse `caughtSpecBlocking` map; `SpecAggregate` gains a `blocking` rate beside `caught`, rendered as a `<case>:<spec> (blocking)` row in the existing per-spec table; and `sampleRates` gains `blocking rate (caught specs)` so it picks up a noise-floor band. The weekly drift watch already samples 3 repeats x 2 identical arms, so it starts producing six severity samples per defect at its existing $220 budget, unchanged.

**Report-only. Nothing gates on the new metric.** On an identical-arm pool a blocking rate strictly between 0 and 1 is unstable by construction — same prompt, same input, split vote — so those rows print `severity split` and no threshold tuning is intended. An unrecorded label (report artifacts predating this change) is excluded from the denominator rather than counted non-blocking, and the row and the band are omitted entirely rather than printed as a fabricated 0%.

No change to the shipped review workflow: `review.md`, the lock, the finding schema, and `BLOCKING_LABELS` are all untouched.
