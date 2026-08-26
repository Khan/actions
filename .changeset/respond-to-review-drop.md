---
"review": minor
---

Scoped and flip-gated re-reviews drop single pushes to fast depth on their own when the push is the respond-to-review shape: every hunk the anchor fingerprint has not seen sits within 3 lines of an open review thread's anchor in the same file (bot and human threads both count, staged `threads.json` plus `human-threads.json`). Such a round dispatches reconcile-only, records `reasons: ["respond-to-review", "mode-<mode>"]` in `rereview-plan.json`, and carries the anchor fingerprint forward verbatim. The full-roster approval rule and the dismissal clearance govern what it may do to the verdict: it can resolve threads and clear an earned-back block, never approve.

Every guard resolves toward more review: the divergence tripwire outranks the drop (a push moving 0.4+ of the hunks re-arms full even when every hunk sits on a thread line), one hunk matching no thread keeps the configured roster, a line-less (outdated/file-level) thread anchors nothing, and a staging without the thread files disables the drop entirely.

Expected output-shape effect: on scoped consumers (webapp, frontend, this repo), pushes that only rework flagged lines stop dispatching the full roster and run at reconciler cost (roughly $0.24 vs the $7.90 scoped mean); pushes carrying any new code are unaffected. Nothing changes on full-mode repos.
