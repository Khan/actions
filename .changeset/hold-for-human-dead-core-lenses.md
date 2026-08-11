---
"review": minor
---

A run whose core review pass (`correctness-reviewer` or `skill-auditor`)
produced no output no longer auto-approves: the plan CLI now feeds the
dispatcher's real `skippedDimensions` into `computeVerdict`, whose
HOLD_FOR_HUMAN gate was previously unreachable (the dimensions were hardcoded
"assessed"). A hold submits no review event; the plan's body posts as one
standalone PR comment explaining the hold and how to get unstuck, the
conformance gate blocks any other shape (a queued review event, inline
comments, thread resolutions, or a withheld hold comment), and the cache
writer leaves the prior fingerprints standing so the next run reviews in
full (it drops only `risksPatternsKey`, because posting the hold comment
collapses the standing guidance comment). Blocking findings still win: with
a validated blocking claim the verdict stays REQUEST_CHANGES and the dead
lens is disclosed in a note line. The production shape this closes:
Khan/actions#328's re-run, where every core lens died on an API auth error
and the bot still submitted "Approved" over seven "not assessed" notes.
