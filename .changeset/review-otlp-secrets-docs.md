---
"review": patch
---

Document the `GH_AW_OTEL_SENTRY_ENDPOINT` / `GH_AW_OTEL_SENTRY_AUTHORIZATION` secrets as a hard install prerequisite (README required-secrets section plus the comment on the `observability:` block). A consuming repo without them does not degrade gracefully: the compiled lock feeds the empty endpoint into the MCP gateway's OTLP config, whose schema rejects it, and the agent job dies at startup (observed on Khan/actions#241). Repos without Sentry must comment out the `observability:` block in their installed review.md and recompile.
