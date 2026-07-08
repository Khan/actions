---
"review": minor
---

Add the versioned structured finding schema (`workflows/review/lib/finding-schema.ts`): every sub-agent finding now carries id, lens, anchor (line/range/file/pr-level), severity, confidence, evidence trace, optional suggested patch and pre-merge obligation, validated against an exported `FINDING_SCHEMA_VERSION`. Review submission is standardized on a single robust `submit-pull-request-review` call with a guaranteed non-empty body (the empty-body retry fallback is removed), and PR context (`pr-context.json`) is staged on disk once per run for all sub-agents, extending the existing diff staging.
