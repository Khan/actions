---
"review": minor
---

security-auth lens: GitHub Actions workflow-security hunts (pwn-request,
push-ref-race, over-scoped-secret). Eval corpus gains the matching workflow
pwn-request incident repro. Action pinning is left to the deterministic
tooling layer (org pinning policy / actionlint / zizmor) — a mechanical
check does not earn a reasoning-lens hunt.
