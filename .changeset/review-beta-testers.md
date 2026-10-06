---
"review": minor
---

Adds beta testers: a repo can run a candidate reviewer release for the PR authors listed in the `REVIEW_BETA_AUTHORS` repo variable while every other PR stays on the current release. The shipped `if:` now skips those authors, and does nothing while the variable is unset. A second install at `.github/workflows/review-beta.md` reviews them. The consumer-config checker validates the pair: gate polarity, the empty-variable guard, the `/review` author expression, distinct workflow names, and the beta lock. See "Beta testers" in the README.
