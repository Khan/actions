---
"apply-terraform-plan": patch
---

Don't fail the job when the plan-file cleanup PR can't be merged automatically.

The action opens a cleanup PR after a successful apply and merges it with the `GITHUB_TOKEN`, retrying five times before `exit 1`. On a repo whose base branch requires an approving review, that merge can never succeed — the token acts as the actions bot, and a bot cannot approve its own PR:

```
GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)
X Pull request is not mergeable: the base branch policy prohibits the merge.
```

The apply itself has already succeeded at that point, so the job went red on a deploy that completed fine, and the real signal (`Apply complete! Resources: 22 added, 0 changed, 0 destroyed.`) was buried under a cleanup failure. The 2.2.4 release that introduced the cleanup PR assumed a base branch that "requires PRs but no approvals"; repos that also require a review have never had a green apply.

The retry loop now falls back to enabling auto-merge (a no-op where auto-merge is disabled) and emits a `::warning::` with the PR URL instead of exiting non-zero. An unmerged cleanup PR only leaves a stale plan pointer on the base branch, which the next run's staleness check already catches. A failing `terraform apply` still fails the job, unchanged.

Because an unmergeable cleanup PR no longer fails the job, reaching the "Delete uploaded plan from GCS" step no longer implies the pointer is gone from the base branch. That step is now gated on the merge step's new `merged` output, preserving the 3.0.0 invariant that the uploaded plan is deleted only once the cleanup PR has actually landed — otherwise the base branch would keep a pointer to a missing object and every re-run would hard-fail at download.
