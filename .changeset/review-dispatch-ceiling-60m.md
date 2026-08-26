---
"review": patch
---

Raise the dispatcher's Bash ceiling from 30 to 60 minutes (`BASH_MAX_TIMEOUT_MS` 1800000 to 3600000, and the prompt's dispatcher `timeout` with it) and the job's `timeout-minutes` from 50 to 80, keeping the ~20 minutes of headroom between the two. Run 32891345932 (Khan/webapp#41030, 52 files at full depth) was killed at the 30-minute line with the fan-out already done (11 lens outputs on disk by minute 25) and only claim validation left, posting nothing; that's the second dispatcher death at a ceiling (32418662895 died the same way at 20 minutes). 60 minutes stays a pragmatic cap sized to observed runs, not a bound.
