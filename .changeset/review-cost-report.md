---
"review": minor
---

review: a per-review cost report, collapsed in the review body

Every review now carries its own price tag: a collapsed `review cost` block
at the end of the review body with one row per sub-agent (model, tool calls,
turns, wall clock, tokens by class), a row for the prose judge, a row for the
orchestrator, and a total, at Khan's rate with the SDK's list figure beside
it. The same table lands in the run's step summary and as
`cost-report.json` in the run's `agent` artifact. Body size: every review
body grows by one collapsed block, roughly 1,000 to 2,000 characters for a
default-roster run (one table row per sub-agent), which the reader sees as a
one-line `review cost: $x.xx at Khan's rate` chip. The block is left out,
with a note in the summary and artifact, when the body would otherwise cross
gh-aw's 65000-character ingest cap.

Before this, a run's cost lived in three places that never met:
`dispatch-result.json`'s per-agent `usd` was the Claude Agent SDK's own meter
at Anthropic list price, gh-aw's `agent_usage.json` was the whole run at
Khan's rate with no per-agent split, and the prose judge (its own SDK
sessions) was in neither. The dispatcher now records per-model tokens off the
SDK result's `modelUsage` for every sub-agent and for the judge's calls on
each agent, and `lib/pricing.ts` is the one place tokens become dollars. The
orchestrator's row is the api-proxy's whole-run usage minus what the
dispatcher accounted for, and the total is reconciled against gh-aw's
`ai_credits`, with a note when they disagree by more than 1%. The report is a
fail-open post-step after the dispatch-conformance gate, since two of its
inputs only exist after the agent step.
