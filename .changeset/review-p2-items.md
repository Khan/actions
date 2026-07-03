---
"review": minor
---

P2 items: the thread-reconciler recognizes three terminal resolutions (fixed, deferred-to-filed-issue, disagreed-with-reason) before keeping a thread open (R13); the README documents the version stamp as the single consumer-facing drift surface (R14); `lib/counters.ts` mines run health metrics (validator drop rate, comments per PR, verdict mix, thumbs agreement, cost) from existing per-run artifacts (R15); `lib/dismissal-learning.ts` turns dismissal signals into human-approved do-not-flag proposals, never auto-adopted (R16); and APPROVE-with-obligations renders pre-merge obligations as a distinct comment from the finding schema (R17).
