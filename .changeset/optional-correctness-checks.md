---
"review": patch
---

Let the correctness reviewer pull in extra repo-specific correctness checks via an optional `{{#runtime-import? .github/aw/review/correctness-checks.md}}`. Host repos that provide the file get its guidance folded into the correctness pass; repos that don't are unaffected (the optional import is silently skipped).
