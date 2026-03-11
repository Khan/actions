# generate-terraform-plan

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
