---
"review": minor
---

A comment-triggered run plans full depth. Consumers that keep a manual `/review` trigger alongside (or instead of) the push trigger declare it as `issue_comment`, and the re-review planner never distinguished the trigger: under a reduced `re-review` mode, an explicit `/review` ask on a previously-reviewed PR planned the same reduced round as any push, which under `fast` means reconcile-only and nothing reviewed. The plan CLI now reads the runner's `GITHUB_EVENT_NAME` and plans `full` with reason `manual-review-request` for comment-triggered runs, before every mode dial. Push-triggered runs are unchanged; consumers without a comment trigger see no difference.
