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
no longer exists. `@anthropic-ai/claude-agent-sdk` leaves the dependency tree
entirely, and `zod` is no longer a direct dependency (it stays in the lockfiles
transitively, via pi-ai / sandbox-runtime / mcp-sdk).

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

Two posture details the SDK runner used to own and the Pi runner now owns
explicitly. Sub-agent turns retry transient provider failures twice: pi-ai
does not read `ANTHROPIC_MAX_RETRIES` (it calls the Anthropic SDK with
`maxRetries: 0` and defaults its own retry helper to 0), so the runner passes
the budget itself; without it one 429/529 on any turn sheds a whole review
lens. And hitting the turn cap now reports `stopReason=max_turns` instead of
looking like a clean free-text finish, so the single contract-parse retry
tells an out-of-turns agent to conclude rather than correcting a JSON shape
that was never the problem.

Every reviewer tool subprocess now also runs inside an OS sandbox
(`@anthropic-ai/sandbox-runtime`, the engine behind Claude Code's own
sandbox: bubblewrap on Linux, Seatbelt on macOS): the checkout is mounted
read-only (the one writable staging path is the investigation-cap journal,
plus a scratch dir), and tool-level network is denied outright. In
production this stacks inside the awf firewall; in the eval, which runs on a
bare runner VM, it is the only boundary the tools have, and the A/B workflow
now installs bubblewrap+socat for it. Sandbox initialization is fail-closed:
if it cannot start (bubblewrap missing, user namespaces blocked in a nested
container), dispatch refuses to run rather than silently degrading;
`REVIEW_SANDBOX=off` is the explicit, logged escape hatch that restores the
pre-sandbox posture.
