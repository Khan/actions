---
"generate-terraform-plan": major
"apply-terraform-plan": major
---

Stop committing the Terraform binary plan file to git. A binary plan embeds a full copy of the Terraform state, including sensitive values in cleartext, and the tip-delete cleanup never removed it from git history.

generate-terraform-plan now uploads the binary plan to a GCS object keyed by a slug of the terraform path plus the plan's commit SHA, and the plan PR commits only the redacted plan text plus a small pointer file (default `tfplan.commit`) recording that SHA. apply-terraform-plan reads the pointer, rebuilds the object path from its own inputs, downloads the exact plan that was reviewed, applies it, and best-effort deletes the object during cleanup.

Breaking changes: both actions gain a `plan_bucket` input (required for the plan-PR/apply flow; not needed for PR-comment-only or auto_approve usage) and must be upgraded together. Consumers need a GCS bucket that the plan workflow's service account can write objects to and the apply workflow's service account can read (and ideally delete) objects from, plus a lifecycle rule to expire plans that are never applied (e.g. superseded plan PRs).

Note: this only stops new leaks. Any `tfplan.binary` still committed at a repo's tip should be deleted, and histories that ever contained committed binary plans still need scrubbing and rotation of any secrets present in the embedded state.
