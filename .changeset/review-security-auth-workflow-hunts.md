---
"review": minor
---

security-auth lens: docstring-contract-parity rule and GitHub Actions
workflow-security hunts (pwn-request, push-ref-race, over-scoped-secret,
unpinned-action). The parity rule fires when a symbol's documented contract
contradicts what the changed code actually assigns to it — the case that
motivated it documented a field as carrying content "without answers" while
the resolver fed it the answers-included fetcher. Eval corpus gains the two
matching incident repros (docstring-contract parity, workflow pwn-request).
