---
"review": patch
---

Pin the review workflow to specific model versions instead of floating tier aliases, so the reviewer's behavior doesn't change when a new model ships. The orchestrator and the `opus` sub-agents pin to `claude-opus-4-8`; `pattern-triage` (was the Sonnet-tier `large` alias) pins to `claude-sonnet-4-6`; `reviewer-mapper` (was the Haiku-tier `small` alias) pins to `claude-haiku-4-5`.
