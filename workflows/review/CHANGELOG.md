# review

## 1.0.0

### Major Changes

-   739cfe4: Initial release (1.0.0) of the shared `review` PR-reviewer agentic workflow (gh-aw) under `workflows/review/`, installable via `gh aw add Khan/actions/workflows/review/review.md`. The generic flow imports repo-specific config (risk tiers, best-practice skills, CI-tooling exclusions, and the reviewer team allowlist) from the consumer's `.github/aw/review/`; OpenTelemetry trace export (OTLP → Sentry) is wired into the workflow frontmatter.
