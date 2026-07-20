# apply-terraform-plan

## 3.0.0

### Major Changes

-   bd8e6c9: Stop committing the Terraform binary plan file to git. A binary plan embeds a full copy of the Terraform state, including sensitive values in cleartext, and the tip-delete cleanup never removed it from git history.

    generate-terraform-plan now uploads the binary plan to a GCS object keyed by a slug of the terraform path plus the plan's commit SHA, and the plan PR commits only the redacted plan text plus a small pointer file (default `tfplan.commit`) recording that SHA and the plan's sha256 digest. apply-terraform-plan reads the pointer, rebuilds the object path from its own inputs, downloads the plan, verifies its digest against the pointer (so the applied bytes are exactly the reviewed plan), applies it, and best-effort deletes the object once the cleanup PR has merged.

    Breaking changes: both actions gain a `plan_bucket` input (required for the plan-PR/apply flow; not needed for PR-comment-only or auto_approve usage) and must be upgraded together. Consumers need a GCS bucket that the plan workflow's service account can write objects to and the apply workflow's service account can read (and ideally delete) objects from, plus a lifecycle rule to expire plans that are never applied (e.g. superseded plan PRs).

    Consumer workflows must also update their trigger paths: apply workflows typically trigger on `push` with a `paths` filter on `tfplan.binary`, which is never committed anymore. Point that filter (and any `!tfplan.binary` excludes in plan workflows) at the pointer file (default `tfplan.commit`) instead, or apply will never run.

    Security model for the bucket: a binary plan contains the same sensitive data as the Terraform state itself, so treat the plan bucket exactly like the state bucket. Create it in the same project, enable uniform bucket-level access and public access prevention, and grant object access only to the CI service accounts (no human-facing grants). Note that project-level IAM (owners/editors, storage admins) inherits access to any bucket in the project; that audience can already read the state bucket, so the plan bucket exposes nothing new to it.

    Note: this only stops new leaks. Any `tfplan.binary` still committed at a repo's tip should be deleted, and histories that ever contained committed binary plans still need scrubbing and rotation of any secrets present in the embedded state.

## 2.2.4

### Patch Changes

-   d0a802d: Clean up plan files via a pull request instead of pushing directly to the base branch.

    After a successful apply, the action previously committed the plan-file cleanup and pushed it straight to `master`. Now that the base branch is a protected branch that requires changes to go through a pull request, that push is rejected (`GH006: Protected branch update failed`) and the apply job fails even though the apply itself succeeded.

    The cleanup now opens a PR with the plan-file deletion (via `peter-evans/create-pull-request`), mirroring how `generate-terraform-plan` lands its plan updates, and then merges that PR immediately with the `GITHUB_TOKEN` (with a short retry while GitHub computes mergeability). The base branch requires PRs but no approvals or required status checks, and a `GITHUB_TOKEN` merge doesn't trigger further push workflows, so cleanup stays immediate and doesn't re-trigger the apply cycle.

    Cleanup now only runs after a successful apply (the apply step uses `continue-on-error`), so a failed apply no longer opens a cleanup PR that would discard a reviewed-but-never-applied plan. The cleanup PR uses a per-stack branch name (derived from `terraform_path`) with `delete-branch: true`, so concurrent apply jobs for different stacks in the same repo don't clobber a shared cleanup branch. Its base defaults to the branch the workflow ran on (overridable via the new `base_branch` input), so this also works for repos whose base branch is `main`.

## 2.2.3

### Patch Changes

-   372548e: Force all actions to be published so publish script can update major tag

## 2.2.2

### Patch Changes

-   408974b: Bumping all packages to lock down references to SHAs instead of tags

## 2.2.1

### Patch Changes

-   bfd85f2: Pin all packages to the latest sha.

## 2.2.0

### Minor Changes

-   31a0b11: Add auto_approve input to support blind applies.

## 2.1.0

### Minor Changes

-   75c1934: Always remove plan files after an apply

## 2.0.0

### Major Changes

-   7f38b56: Initial implementation, copied over from internal-services
