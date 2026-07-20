---
"generate-terraform-plan": major
"apply-terraform-plan": major
---

Stop committing the Terraform binary plan file to git. A binary plan embeds a full copy of the Terraform state, including sensitive values in cleartext, and the tip-delete cleanup never removed it from git history.

generate-terraform-plan now uploads the binary plan to a GCS object keyed by a slug of the terraform path plus the plan's commit SHA, and the plan PR commits only the redacted plan text plus a small pointer file (default `tfplan.commit`) recording that SHA and the plan's sha256 digest. apply-terraform-plan reads the pointer, rebuilds the object path from its own inputs, downloads the plan, verifies its digest against the pointer (so the applied bytes are exactly the reviewed plan), applies it, and best-effort deletes the object once the cleanup PR has merged.

Breaking changes: both actions gain a `plan_bucket` input (required for the plan-PR/apply flow; not needed for PR-comment-only or auto_approve usage) and must be upgraded together. Consumers need a GCS bucket that the plan workflow's service account can write objects to and the apply workflow's service account can read (and ideally delete) objects from, plus a lifecycle rule to expire plans that are never applied (e.g. superseded plan PRs).

Consumer workflows must also update their trigger paths: apply workflows typically trigger on `push` with a `paths` filter on `tfplan.binary`, which is never committed anymore. Point that filter (and any `!tfplan.binary` excludes in plan workflows) at the pointer file (default `tfplan.commit`) instead, or apply will never run.

Security model for the bucket: a binary plan contains the same sensitive data as the Terraform state itself, so treat the plan bucket exactly like the state bucket. Create it in the same project, enable uniform bucket-level access and public access prevention, and grant object access only to the CI service accounts (no human-facing grants). Note that project-level IAM (owners/editors, storage admins) inherits access to any bucket in the project; that audience can already read the state bucket, so the plan bucket exposes nothing new to it.

Note: this only stops new leaks. Any `tfplan.binary` still committed at a repo's tip should be deleted, and histories that ever contained committed binary plans still need scrubbing and rotation of any secrets present in the embedded state.
