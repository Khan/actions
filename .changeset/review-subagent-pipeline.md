---
"review": minor
---

Restructure the reviewer to delegate its analysis to inline sub-agents. A `pattern-triage` pass finds common cross-file patterns and narrows the review to the files that genuinely need it — skipping generated, formatting-only, and pattern-only changes — after which the correctness/risk reviewer and the best-practice-skill auditor run in parallel on opus, alongside a file-to-team owner mapper (on a small model) and a review-thread reconciler. Sub-agents read the diff and the repo's `.github/aw/review/` config from the checked-out repo; the workflow itself makes all GitHub and safe-output calls. Note: the repo-specific `risk-classification.md`, `ci-tooling.md`, and `skills.md` config files are now required imports.
