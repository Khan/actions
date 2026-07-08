---
"review": minor
---

Add the smoke benchmark: a 13-case tagged subset of the eval corpus (incident repros, adversarial-injection PRs, known-clean PRs) in the shared dataset format, a no-post runner that replays cases through the real deterministic review path (router, labels, scope filter, verdict, render) with zero GitHub writes, and a vitest gate (`workflows/review/eval/smoke.test.ts`) that asserts each case's computed verdict against its expected block. A dedicated CI entry point is staged at `.github-staging/review-smoke.yml` pending a human `git mv` into `.github/workflows/`.
