---
"review": minor
---

security-auth lens: GitHub Actions workflow-security hunts (pwn-request,
over-scoped-secret), with a matching pwn-request incident case in the eval
corpus. Two drafted hunts were cut: unpinned-action (pinning belongs to
deterministic tooling like actionlint/zizmor) and push-ref-race (a
concurrency defect, not a security one, with no corpus case). This repo's
own ROUTING now routes workflow and action files to security-auth.
