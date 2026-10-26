---
"generate-terraform-plan": major
"apply-terraform-plan": major
---

Move the pinned third-party actions off Node.js 20, which GitHub is deprecating on Actions runners (runs currently warn that these actions are "being forced to run on Node.js 24"):

-   `hashicorp/setup-terraform` v3 → v4
-   `google-github-actions/auth` v2 → v3
-   `peter-evans/create-pull-request` v7 → v8

All three now declare `runs.using: node24`. No inputs or outputs of either composite change.

Breaking change: Node 24 actions need Actions runner v2.327.1 or later. GitHub-hosted runners already qualify; self-hosted and GHES runners older than that can't run this version. The `-v3` tags stay on the Node 20 build for consumers who need to stay there while they upgrade their runners.
