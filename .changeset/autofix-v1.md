---
"autofix": minor
---

Add the `autofix` workflow: opt-in, one-shot fixing of the PR reviewer's own feedback.

Label a PR `autofix: blocking` or `autofix: nits` (they union) and the run fixes the reviewer's open threads in that scope, pushes one commit, replies in each thread, posts a summary, and removes the label. One run per arming; the label is a button, not a mode, so it comes off on every outcome including refusals.

The deterministic half lives in `workflows/autofix/lib/` and decides everything before the agent edits anything: `scope.ts` resolves the label vocabulary (and rejects rather than ignores labels on the not-yet-implemented cadence and source axes), `worklist.ts` filters the reviewer's staged threads through the reviewer's own Conventional-Comment taxonomy, `staleness.ts` gates on review currency, and `plan.ts` composes them into a final plan the prompt may execute or refuse but never widen.

Currency is checked per file against the reviewer's hidden fingerprint stamp, so a PR whose author pushed one unrelated fix after the review still gets its other findings fixed instead of being refused wholesale. Unparseable labels, outdated anchors, unreadable fingerprints, and a head that moves mid-run all fail closed.

The push uses `KHAN_ACTIONS_BOT_TOKEN` rather than `GITHUB_TOKEN`, because GitHub creates no workflow runs for `GITHUB_TOKEN`-triggered events and the re-review of the autofix commit is the only verification the fix gets. Autofix never resolves its own threads for the same reason.

Every autofix commit carries an `Autofix-Version` / `Autofix-Scope` / `Autofix-Cycle` / `Autofix-Threads` trailer. v1 never reads it back; it is written so a later continual cadence has a cycle counter that survives cache eviction, and so the trial can score fixes by diffing attempted threads against what the next review still reports open.
