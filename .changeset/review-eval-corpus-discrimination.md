---
"review": patch
---

Eval-only: improve the discrimination power of the review eval corpus. Fixes the floor-case ground truth found by the 2026-07-20 drift triage (lifecycle-3's void prune was a real defect the reviewer was right to block, dedup-eventual-consistency's expected verdict contradicted its own premise, retention-unbounded-prune was retired as unevidenceable in-tree), repairs order-sensitive spec regexes that under-counted deterministic matches, annotates four real defects mined from the drift run's unmatched-posted noise pool, mints two mid-band retention/lifecycle cases, and raises the weekly drift budget default from 85 to 120 USD so the full corpus clears without budget skips. No change to the shipped review workflow.
