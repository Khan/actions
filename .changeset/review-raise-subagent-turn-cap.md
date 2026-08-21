---
"review": patch
---

Raise the sub-agent turn cap from 30 to 100. The correctness pass on large diffs (Khan/actions#295, runs 32422547351 and 32491692754) hit the old cap on two consecutive runs, ending each in error_max_turns and a HOLD_FOR_HUMAN at $11.74-$13.45 of wasted sub-agent spend per run. The turn cap is a loop guard; credit spend, per-finding tool calls, and wall clock are metered separately, so agents that finished under the old cap (8-37 reported turns) are unaffected. The eval producer's cap is bumped in lockstep so trials keep reproducing prod behavior.
