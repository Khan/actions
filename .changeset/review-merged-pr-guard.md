---
"review": minor
---

Never post a review to a merged or closed PR.

A review run takes ~12-17 minutes while PRs often merge minutes after their final push, so an in-flight run could complete after the merge and post a stale verdict (observed in production: CHANGES_REQUESTED with 11 blocking inline comments landing 16 minutes after the PR merged). Nothing in the pipeline checked PR state: gh-aw's safe-output handlers post regardless of it, and the compiled per-PR concurrency group only cancels a run when a newer run of the same workflow starts.

Two layers close the race:

- The workflow now subscribes to `pull_request: closed` (which also fires on merge) solely so the event enters the existing per-PR concurrency group and cancels an in-flight review within seconds. The job-level `if:` excludes `closed` runs from doing any work, so they skip every job and cost nothing.
- A guard step injected via `safe-outputs.steps` runs in the safe-outputs job immediately before the posting handlers. If the PR is not open at that moment, it records why in the job summary and cancels the run, so nothing posts; this also covers manual reruns of stale runs after a merge. The guard fails open on API errors and checks only PR state, never recency: a run whose PR is still open posts normally even if a newer push exists.

Consumers pick this up by updating the pin and recompiling (`gh aw update` and committing the regenerated `review.md` + `review.lock.yml`). Requires gh-aw >= v0.81.6 at compile time for `safe-outputs.steps`; no config.md changes and no new secrets (`KHAN_ACTIONS_BOT_TOKEN` is already required).
