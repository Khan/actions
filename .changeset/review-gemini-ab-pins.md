---
"review": minor
---

review: route model pins by provider, and pin the sub-agents to
gemini-3.8-flash for a cross-provider A/B

The Pi runner's multi-provider claim is now exercised for real. Model pins
resolve through a routing layer (`lib/dispatch-models.ts`): `gemini-*` pins
resolve against Pi's Google (Gemini API) catalog, everything else stays on
the Anthropic catalog, and an unknown pin still throws with the candidates
listed rather than silently substituting. The Google provider authenticates
with `GEMINI_API_KEY`, which the eval workflow passes alongside
`ANTHROPIC_API_KEY`.

`gemini-3.8-flash` shipped 2026-09-02 and the pinned pi-ai 0.83.0 catalog
predates it, so the runner registers the provider with one local catalog
entry (launch intro pricing, $0.75/$3.75 per MTok) that a future pi-ai
bump's own entry supersedes by id.

Google pins always carry an explicit thinking level, pinned at `high` for
the A/B (a measurement decision: run the candidate the way an agentic
deployment would, while the claude arms keep extended thinking off exactly
as they always have, so the arms differ in model and reasoning budget
both). Explicit because pi-ai (through 0.84.4) translates "no thinking
requested" on a gemini-3-flash model into a hardcoded `thinkingLevel:
MINIMAL`, which the 3.7+ API rejects with a 400: the first A/B run's
candidate arm died on exactly that, every dispatch $0 in 2 seconds. The
catalog entry's level map declares `off` and `minimal` unsupported (the
3.8 API takes LOW/MEDIUM/HIGH only).

Every sub-agent `model:` pin in review.md moves to `gemini-3.8-flash` so the
live A/B measures that model against main's claude baseline on the same
harness. This is a measurement state, not a production pin decision: the
engine pin, the prose judge, and the eval's judge/arbiter stay on claude,
and production gemini traffic is deliberately not wired (the awf api-proxy
meters Anthropic only, so a production move needs firewall and proxy work
first).

Also fixed on the way: the `ANTHROPIC_BASE_URL` steer used to re-register
the provider through `createProvider({...provider, baseUrl})`, which throws
in pi-ai 0.83.0 (createProvider wants the provider's input shape, and the
built provider does not re-expose it). The steer now rewrites each catalog
model's own `baseUrl`, the field the API layer actually reads. The eval VM
runs unsteered, which is why no run tripped it.
