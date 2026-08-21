---
"review": patch
---

Raise the sub-agent turn cap from 30 to 100. The correctness pass on large diffs (Khan/actions#295, runs 32422547351 and 32491692754) hit the old cap on two consecutive runs, ending each in error_max_turns and a HOLD_FOR_HUMAN at $11.74-$13.45 of wasted sub-agent spend per run. The turn cap is a loop guard; credit spend, per-finding tool calls, and wall clock are metered separately, so agents that finished under the old cap (8-37 reported turns) are unaffected. The eval producer's cap is bumped in lockstep so trials keep reproducing prod behavior.

Also raise the dispatcher's Bash ceiling from 20 to 30 minutes (`BASH_MAX_TIMEOUT_MS` 1200000 to 1800000, and the prompt's dispatcher `timeout` with it) and the job's `timeout-minutes` from 40 to 50. The dispatcher awaits four sequential agent stages (triage, finder fan-out in waves of 4, the clusterer, claim validation), each sub-agent capped at 15 minutes and re-dispatched once on a parse failure, so 30 minutes is a pragmatic cap sized to observed runs, not a bound; run 32418662895 (Khan/actions#362) was killed mid-claim-validation at the 20-minute line and posted nothing, and longer-running agents under the new turn cap make that more likely, not less.
