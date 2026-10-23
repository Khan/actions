---
"generate-terraform-plan": minor
"apply-terraform-plan": minor
---

Move the pinned third-party actions off Node.js 20, which GitHub is deprecating on Actions runners (runs currently warn that these actions are "being forced to run on Node.js 24"):

-   `hashicorp/setup-terraform` v3 → v4.0.1
-   `google-github-actions/auth` v2 → v3.0.0
-   `peter-evans/create-pull-request` v7 → v8.1.1

All three now declare `runs.using: node24`. No inputs or outputs of either composite change. Self-hosted runners need Actions runner v2.327.1 or later to run Node 24 actions; GitHub-hosted runners already qualify.
