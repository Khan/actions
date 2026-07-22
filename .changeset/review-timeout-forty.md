---
"review": minor
---

Raise the agent job's `timeout-minutes` from 20 to 40. The high-tier
`runBudget.maxWallClockMinutes` soft target is 20, which sat exactly on the old
hard ceiling: a high-tier run's "start landing" signal and its kill point were
the same minute, so the graceful-shed logic could never actually save a heavy
run. Four high-tier runs on Khan/actions died at the ceiling in one evening
(2026-07-21), each after emitting its review outputs but before the
cache-memory update, which made the next re-review start cold and run even
longer. The budget table's soft targets are deliberately unchanged: shedding
starts at the same points as before, and the wider ceiling restores real
headroom between "start landing" and "killed". Consumers pick this up at their
next installed-reviewer bump.
