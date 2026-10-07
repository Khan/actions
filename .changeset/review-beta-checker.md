---
"review": minor
---

The consumer-config checker validates a beta install against the stable one whenever `.github/workflows/review-beta.md` exists: gate polarity, the empty-variable guard, the `/review` author expression, distinct workflow names, and the beta lock.
