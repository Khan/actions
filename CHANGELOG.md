# apply-terraform-plan

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
