---
"review": minor
---

An author acknowledgment stops reading as "unaddressed": the thread-reconciler now reports kept threads whose reply chain shows the author conceded the finding (will fix, TODO stands in) as `acknowledged`, code verifies the mechanical preconditions for each id against the staged reply chain (keep membership required, the PR author must actually have replied, bot replies never count, no staged author verifies nothing; whether the reply concedes rather than pushes back stays the reconciler's judgment), and the re-review recap counts those threads as "acknowledged (fix pending)" instead of unaddressed. An acknowledged blocking thread still renders visibly and still counts toward `keptBlockingCount`, so the flip gate is unchanged. The verified ids are recorded in `rereview.json`; nothing consumes them yet.
