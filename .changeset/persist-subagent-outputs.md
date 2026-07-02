---
"review": patch
---

Persist each review sub-agent's structured JSON output to `/tmp/gh-aw/review/out/` and upload that directory as a run-scoped `upload-artifact` (30-day retention), so a human can inspect exactly what each reviewer produced when diagnosing or tuning the reviewer after a run.
