# generate-terraform-plan

## 3.0.0

### Major Changes

-   bd8e6c9: Stop committing the Terraform binary plan file to git. A binary plan embeds a full copy of the Terraform state, including sensitive values in cleartext, and the tip-delete cleanup never removed it from git history.

    generate-terraform-plan now uploads the binary plan to a GCS object keyed by a slug of the terraform path plus the plan's commit SHA, and the plan PR commits only the redacted plan text plus a small pointer file (default `tfplan.commit`) recording that SHA and the plan's sha256 digest. apply-terraform-plan reads the pointer, rebuilds the object path from its own inputs, downloads the plan, verifies its digest against the pointer (so the applied bytes are exactly the reviewed plan), applies it, and best-effort deletes the object once the cleanup PR has merged.

    Breaking changes: both actions gain a `plan_bucket` input (required for the plan-PR/apply flow; not needed for PR-comment-only or auto_approve usage) and must be upgraded together. Consumers need a GCS bucket that the plan workflow's service account can write objects to and the apply workflow's service account can read (and ideally delete) objects from, plus a lifecycle rule to expire plans that are never applied (e.g. superseded plan PRs).

    Consumer workflows must also update their trigger paths: apply workflows typically trigger on `push` with a `paths` filter on `tfplan.binary`, which is never committed anymore. Point that filter (and any `!tfplan.binary` excludes in plan workflows) at the pointer file (default `tfplan.commit`) instead, or apply will never run.

    Security model for the bucket: a binary plan contains the same sensitive data as the Terraform state itself, so treat the plan bucket exactly like the state bucket. Create it in the same project, enable uniform bucket-level access and public access prevention, and grant object access only to the CI service accounts (no human-facing grants). Note that project-level IAM (owners/editors, storage admins) inherits access to any bucket in the project; that audience can already read the state bucket, so the plan bucket exposes nothing new to it.

    Note: this only stops new leaks. Any `tfplan.binary` still committed at a repo's tip should be deleted, and histories that ever contained committed binary plans still need scrubbing and rotation of any secrets present in the embedded state.

## 2.3.0

### Minor Changes

-   0ff5a32: Add optional extra Markdown inputs to the Terraform plan action comment & pr description

## 2.2.5

### Patch Changes

-   e97da0d: Clarify the scheduled-plan PR description: when the diff shows no code changes but the plan shows a Docker image digest change, explain that this is from an upstream base-image or OS-package update and is safe to merge. Replaces the previous (and confusing) instructions to dig through Cloud Build logs.

## 2.2.4

### Patch Changes

-   372548e: Force all actions to be published so publish script can update major tag

## 2.2.3

### Patch Changes

-   408974b: Bumping all packages to lock down references to SHAs instead of tags

## 2.2.2

### Patch Changes

-   bfd85f2: Pin all packages to the latest sha.

## 2.2.1

### Patch Changes

-   4621a63: Updates the PR description for scheduled terraform plan generation to help reviewers determine the cause of the change

## 2.2.0

### Minor Changes

-   a6a1612: Add fallback reviewers to generate-terraform-plan

## 2.1.0

### Minor Changes

-   37257de: ## Terraform Locking Optimization

    The `generate-terraform-plan` action includes a smart locking strategy to prevent lock contention:

    -   **Master/main branch**: Uses normal Terraform locking for safety during plan and apply operations
    -   **Feature branches**: Disables locking (`-lock=false`) to avoid contention with master operations

    This prevents scenarios where multiple PRs running terraform plans would block master branch applies, which would require manual re-runs.

## 2.0.0

### Major Changes

-   7f38b56: Initial implementation, copied over from internal-services
