---
"review": minor
---

Restructure the reviewer roster around a uniform findings contract: every reviewer returns the same labeled-findings shape and the orchestrator treats all findings identically through one path. The new whole-change reviewers (holistic, completeness, test-adequacy, first-principles, conventions) ship as opt-in capability via `enable` lines in the consumer's ROUTING file; none run by default, and a reviewer earns its config line through the eval suite. The default roster is unchanged. Launch-default model and effort assignments per role (Opus 4.8 workhorse, xhigh for the security lens and claim validation), and the kept gates (pattern-triage, claim-validator, deterministic dedup, verdict bookends, thread-reconciler) wired to the roster.
