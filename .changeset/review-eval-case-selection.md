---
"review": patch
---

Fail-fast case selection in the live A/B runner. An explicit `--cases` list is now an exact selection: it bypasses `--smoke-only` (which scopes unscoped runs only), preserves the requested order, runs duplicate ids once, and throws before any model spend when an id matches no live case. Previously the smoke scope filtered the corpus before the case filter, so a dispatch naming a non-smoke case silently dropped it: the 2026-07-10 anchor-snap powered run named two cases and the paid report covered one without saying so, and a typo'd case id would shrink a measurement the same way. The workflow needs no change; it already passes both flags and the case list now wins.
