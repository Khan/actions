---
"review": patch
---

Fixes from the final review folds of three merged PRs. The dispatcher-death prose (Khan/actions#370) sequenced "report the run incomplete" before "continue at Step 9", and reporting incomplete can end the turn, so the cache compensation the death path exists to trigger could be skipped with it; Step 9 now comes first, and the repost claim is scoped to the next full-depth run. The `gh aw update` ban test (Khan/actions#371) folds whitespace before matching so a line-wrapped mention cannot slip past, gains a positive control so a broadened exclusion fails instead of passing vacuously, and checks file existence before reading so the stale-allowlist message actually renders. foldToken's three length thresholds are documented (Khan/actions#365) and the empty-subject-tokens early return is pinned by a test.
