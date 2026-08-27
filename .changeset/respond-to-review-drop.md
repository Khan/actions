---
"review": minor
---

Scoped and flip-gated re-reviews drop single pushes to fast depth on their own when the push is the respond-to-review shape: every contiguous run of changed lines the anchor fingerprint has not seen (exact `+` lines plus deletion-bracketing lines, never a hunk header's context-spanning extent) sits within 3 lines of an open review thread's anchor in the same file. Bot and human threads both count for matching (staged `threads.json` plus `human-threads.json`), but the drop requires at least one line-anchored bot thread: the fast roster is reconcile-only, and the reconciler's work list is the bot's threads. Such a round dispatches reconcile-only, records `reasons: ["respond-to-review", "mode-<mode>"]` in `rereview-plan.json`, and carries the anchor fingerprint forward verbatim. The full-roster approval rule and the dismissal clearance govern what it may do to the verdict: it can resolve threads and clear an earned-back block, never approve.

Every guard resolves toward more review: the divergence tripwire outranks the drop (a push moving 0.4+ of the hunks re-arms full even when every changed run sits on a thread line), one run matching no thread keeps the configured roster (so fresh code mixed into a thread-fix push disqualifies it, same hunk or not), a line-less (outdated/file-level) thread anchors nothing, human-only threads never drop, and a staging without the thread files disables the drop entirely.

Expected output-shape effect: on scoped consumers (webapp, frontend, this repo), pushes that only rework flagged lines stop dispatching the full roster and run at reconciler cost (roughly $0.24 vs the $7.90 scoped mean); pushes carrying any new code are unaffected. Nothing changes on full-mode repos.
