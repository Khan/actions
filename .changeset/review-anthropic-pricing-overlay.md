---
"review": patch
---

Meter AI credits at Khan's real Anthropic rate rather than list price. Khan bills list minus 50%, but the firewall api-proxy prices credits from a list-price catalog baked into its image, so `max-ai-credits` stops a run at half the spend it implies and the router's `maxUsd` targets are denominated in a currency twice as expensive as the real one. Adds gh-aw's `models.providers` overlay at 50% of list for every model the reviewer can run. Since a credit now means $0.01 of real spend, the existing caps and targets are correct as written, so `budgets.ts`, `credit-cap.ts` and the counters are untouched.

Inert until gh-aw v0.84.x is stable: `apiProxy.providers` needs firewall v0.27.43, and gh-aw v0.83.4 defaults to v0.27.42 and drops the key silently. Nothing else is required to activate it; recompiling on v0.84.x is enough.
