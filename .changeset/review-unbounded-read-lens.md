---
"review": minor
---

Close the unbounded-read blind spot found by the 2026-07-20 drift triage: the reviewer missed `retention-unbounded-prune` in all 6 drift samples (a query loading an entire user-sized result set via `pageSize: "all"`), and its own suggested fix for an adjacent bug recommended the same unbounded-read pattern, so no lens was reasoning about memory-bounded reads at all. The correctness lens's line scan now names unbounded reads and accumulation as a defect class (materializing a result set that grows with user data; missing LIMIT, whole-table reads to act on a subset, unpaginated buffering) and states the expected shape (page or batch it, so a deliberately bounded per-invocation read is the fix, not a further defect). The caching-resource specialist gains a matching review rule and an `unbounded-read-materialization` tri-state hunt. Recall-affecting by design; priced by the per-PR A/B and a targeted powered run on golden-retention-lifecycle-1.
