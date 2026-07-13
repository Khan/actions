---
"review": minor
---

Skill findings show the author the actual rule. Quote-the-rule already requires the exact rule text in a lens skill finding's `evidence_trace`, but evidence traces never reach the PR: the author reads only `model_authored_prose`, so they see a paraphrase of a rule they cannot check. The finding schema gains an optional `rule_quote` field (the exact rule text, verbatim from the skill file; validated non-empty when present, and optional, so `FINDING_SCHEMA_VERSION` stays 2), each lens's lens-owned-skills discipline says to fill it, and `renderComment` plus the orchestrator's normalization step surface it into the posted comment as a `> **Rule:** …` blockquote between the prose and any suggestion block. Only the wrapping is code-owned; the quote is skill-file text copied verbatim.
