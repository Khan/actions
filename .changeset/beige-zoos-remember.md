---
"apply-terraform-plan": major
"generate-terraform-plan": major
---

## Terraform Locking Optimization

The `generate-terraform-plan` action includes a smart locking strategy to prevent lock contention:

- **Master/main branch**: Uses normal Terraform locking for safety during plan and apply operations
- **Feature branches**: Disables locking (`-lock=false`) to avoid contention with master operations

This prevents scenarios where multiple PRs running terraform plans would block master branch applies, which would require manual re-runs.
