---
"review": patch
---

Eval-only: grow the corpus by seven live cases (nine across the stack, counting the two minted in the preceding corpus PR) across seven previously uncovered defect families (removed-behavior, cross-file chain, mechanical-churn needle, non-idempotent retry, check-then-act race, boundary double-count, and a 29-file cross-subsystem tree), add a mustNotFlagSpec precision probe to the churn case, and document the calibration finding in the operator guide: all nine stack cases calibrated saturated under the Opus roster across ~56 identical-arm samples, so hand-authored synthetics are family tripwires by construction and recall discrimination must be grown from real material (golden human-comment cases and production incident repros). No change to the shipped review workflow.
