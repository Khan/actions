---
"review": minor
---

review: make the Pi runner the only sub-agent harness and remove the Claude
Agent SDK runner

Scripted dispatch now runs every sub-agent through the Pi-backed runner
(`lib/dispatch-runner-pi.ts`, built on `@earendil-works/pi-ai` +
`@earendil-works/pi-agent-core`). The Claude Agent SDK runner
(`lib/dispatch-runner.ts`) is deleted, along with the
`REVIEW_DISPATCH_RUNNER` selection seam; a leftover `REVIEW_DISPATCH_RUNNER`
setting now fails the run loudly instead of silently selecting a harness that
no longer exists. `@anthropic-ai/claude-agent-sdk` and `zod` leave the
dependency tree.

The removal is grounded in the re-anchoring harness A/B (run 30666183461):
two full-corpus repeats with identical model pins and byte-identical
review.md showed arm-to-arm quality parity (recall 41/46 vs 40/46 and 40/46
vs 41/46, verdict agreement 32/35 vs 33/35 both repeats, comparable
investigation depth by tool-call count) with the Pi arm at roughly half the
cost (1.78x and 1.94x) and 60% of the wall clock (1.65x both repeats).

No model pin changes. The pins still resolve through Pi's Anthropic catalog
(`resolveModelId`), which throws on an unknown pin rather than silently
substituting. Pi reports usage with a per-component `cost` breakdown, so
`AgentResult.usd` no longer inherits the api-proxy default-pricing path's
cache-write under-count.

The corpus recall figures, noise bands, and drift budget measured on the SDK
loop era do not transfer numerically; the re-anchoring run above is the
reference point for Pi-harness numbers going forward.
