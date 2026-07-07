---
"review": minor
---

P2 items: the thread-reconciler recognizes three terminal resolutions (fixed, deferred-to-filed-issue, disagreed-with-reason) before keeping a thread open; the guidance comment carries a plain version marker (release tag + finding-schema version) for attribution and rollback, with semver as the behavior contract (no drift-stamp machinery); `lib/counters.ts` mines run health metrics (validator drop rate, comments per PR, verdict mix, thumbs agreement, cost) from existing per-run artifacts; and APPROVE-with-obligations renders pre-merge obligations as a distinct comment from the finding schema. Dismissal-learning is deferred until the thumbs sweep is scheduled and has accumulated real dismissal signals.
