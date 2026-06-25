---
"review": minor
---

Restructure the reviewer to delegate its analysis to inline sub-agents. A `pattern-triage` pass finds common cross-file patterns and narrows the review to the files that genuinely need it — skipping generated, formatting-only, and pattern-only changes — after which correctness, best-practice-skill, and code-ownership reviewers run in parallel on lower-cost models, alongside review-thread reconciliation. Sub-agents read the diff and the repo's `.github/aw/review/` config from the checked-out repo; the workflow itself makes all GitHub and safe-output calls. Note: the repo-specific `risk-classification.md`, `ci-tooling.md`, and `skills.md` config files are now required imports.
