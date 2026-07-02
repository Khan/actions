---
"review": patch
---

Skip submitting a review when it would be a no-op repeat: an APPROVE with no inline comments and no skipped-dimension notes, where the PR's most recent `github-actions[bot]` review was already APPROVED. Step 7 (risk/patterns comment) and Step 8 (reviewer requests) still run as normal — only the redundant `submit-pull-request-review` call is skipped.
