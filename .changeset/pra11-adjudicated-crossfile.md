---
"review": minor
---

The adjudicated-corpus suppression drops its same-path key: a human-settled defect's rephrasing routinely re-anchors on another file (the spec instead of the implementation, the test instead of the function), and the path key is what let the webapp#41290 duplicate families re-post for two weeks after the author had adjudicated them. Measured on that frozen corpus (12 adjudicated threads, 33 labeled candidates, kept privately in the planning tree), dropping the key tripled recall (2/12 to 6/12 true variants suppressed) and added zero false suppressions (both variants make the same single mistake, folding two distinct same-file findings whose wording shares the file's vocabulary). The open-thread corpus stays path-keyed, blocking candidates are still never suppressed here, an adjudicated thread staged without a usable path stays inert rather than becoming a PR-wide matcher, and every other #332 fail-closed guard is unchanged.
