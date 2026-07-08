---
"review": minor
---

Add the eleven path-routed specialist reviewer lenses: security-auth (single lens, xhigh effort), ai-safety-moderation, mass-comms-coppa, caching-resource, data-migrations, concurrency-async, api-federation-compat, cross-deploy-serialization, deploy-infra-config, money-payments, and content-i18n. Each lens runs a tri-state incident hunt (found / not-found / not-applicable) and emits schema-validated structured findings. Lenses are opt-in: a consumer repo routes paths to lenses via `lens=` rules in its ROUTING file, and none run by default. The standalone skill-auditor sub-agent is retained unchanged; a dispatched lens owns its own domain's best-practice skills for the run and the skill-auditor skips them, so no rule is audited twice.
