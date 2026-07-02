---
"review": patch
---

Make best-practice/skill flagging severity-based instead of always blocking. The `skill-auditor` now assigns each violation a `severity` of `blocking` or `advisory` — taken from the skill file when it declares one (skill-level default or per-rule annotation), otherwise judged by impact. `blocking` violations keep the `issue (blocking, best-practice)` label and drive REQUEST_CHANGES; `advisory` violations get a new `suggestion (non-blocking, best-practice)` label and ride along with an APPROVE. The verdict (already a mechanical function of posted-comment labels) blocks only on `blocking` ones, and `claim-validator` can correct an over- or under-stated severity.
