---
network:
  allowed:
    - "otlp.us5.datadoghq.com"
observability:
  otlp:
    endpoint:
      - url: "https://otlp.us5.datadoghq.com/v1/logs"
        headers:
          Authorization: ${{ GH_AW_OTEL_DATADOG_AUTHORIZATION }}
---

<!--
Shared OpenTelemetry (OTLP -> Datadog) configuration for gh-aw workflows, meant to be
reused across multiple workflows. Import it from another workflow's frontmatter:

  imports:
    - Khan/actions/shared/otel.md@main

Only the frontmatter above is merged into the importing workflow — it adds the Datadog
OTLP egress domain to the network allowlist and the observability endpoint. This file has
no `on:` trigger, so it is a shared component, not a standalone workflow. The Authorization
header reads the GH_AW_OTEL_DATADOG_AUTHORIZATION secret/variable, which the consuming repo
must provide.
-->
