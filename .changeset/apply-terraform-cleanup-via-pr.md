---
"apply-terraform-plan": patch
---

Clean up plan files via a pull request instead of pushing directly to the base branch.

After a successful apply, the action previously committed the plan-file cleanup and pushed it straight to `master`. Now that the base branch is a protected branch that requires changes to go through a pull request, that push is rejected (`GH006: Protected branch update failed`) and the apply job fails even though the apply itself succeeded.

The cleanup now stages the plan-file deletion and opens a PR with it (via `peter-evans/create-pull-request`), mirroring how `generate-terraform-plan` lands its plan updates. The PR's base defaults to the branch the workflow ran on, so this also works for repos whose base branch is `main`.
