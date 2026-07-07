---
"review": minor
---

Add the eleven path-routed specialist reviewer lenses: security-auth (single lens, xhigh effort), ai-safety-moderation, mass-comms-coppa, caching-resource, data-migrations, concurrency-async, api-federation-compat, cross-deploy-serialization, deploy-infra-config, money-payments, and content-i18n. Each lens runs a tri-state incident hunt (found / not-found / not-applicable) and emits schema-validated structured findings; the standalone skill-auditor sub-agent is folded into the correctness pass, keeping the repo-specific correctness-checks extension point.
