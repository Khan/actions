---
"generate-terraform-plan": patch
---

Clarify the scheduled-plan PR description: when the diff shows no code changes but the plan shows a Docker image digest change, explain that this is from an upstream base-image or OS-package update and is safe to merge. Replaces the previous (and confusing) instructions to dig through Cloud Build logs.
