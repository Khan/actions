---
"review": patch
---

Meter AI credits at Khan's real Anthropic rate instead of list price. Khan bills list minus 50%, but the firewall api-proxy prices credits from a list-price catalog baked into its image, so `max-ai-credits` cuts a run off at half the spend it implies and the router's `maxUsd` targets are denominated in a currency twice as expensive as the real one. Adds gh-aw's `models.providers` operator overlay at 50% of list for every model the reviewer can run. Because a credit now means $0.01 of real spend, the existing caps and `maxUsd` targets are correct as written, so `budgets.ts`, `credit-cap.ts` and the counters are untouched.

Inert until gh-aw v0.84.x goes stable: `apiProxy.providers` needs AWF v0.27.43, and gh-aw v0.83.4 (still `releases/latest`) defaults to v0.27.42 and drops the key silently, with the rates reaching only the informational `GH_AW_INFO_MODEL_COSTS`. v0.84.0 raises the default, but the v0.84.x line is prerelease. Not forced with a `sandbox.agent.version` pin, which `review.md` allows only to hold a release back, never to move one forward.

Maintenance: entries match per model, and an unlisted model falls through to list price with no error, so an engine-model change needs a matching entry and the rates need re-halving when Anthropic list prices move.
