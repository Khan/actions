# review

## 1.1.1

### Patch Changes

-   0872577: Add an explicit `name:` to each inline sub-agent's frontmatter (`correctness-reviewer`, `skill-auditor`, `pattern-triage`, `reviewer-mapper`, `thread-reconciler`, `claim-validator`). Recent gh-aw/Claude engine versions require sub-agents to declare a `name` rather than inferring it from the `## agent:` header, so without this the compiled workflow fails to dispatch them.

## 1.1.0

### Minor Changes

-   cc461cf: Restructure the reviewer to delegate its analysis to inline sub-agents. A `pattern-triage` pass finds common cross-file patterns and narrows the review to the files that genuinely need it — skipping generated, formatting-only, and pattern-only changes — after which the correctness/risk reviewer and the best-practice-skill auditor run in parallel on opus, alongside a file-to-team owner mapper (on a small model) and a review-thread reconciler. Before any comments are posted, a `claim-validator` pass re-checks each proposed comment against the actual code — and, for best-practice claims, against the relevant skill's real rule — and drops the false positives or corrects inaccurate ones, so a wrong claim never reaches the PR or forces a change request. Sub-agents read the diff and the repo's `.github/aw/review/` config from the checked-out repo; the workflow itself makes all GitHub and safe-output calls. Note: the repo-specific `risk-classification.md`, `ci-tooling.md`, and `skills.md` config files are now required imports.

## 1.0.0

### Major Changes

-   739cfe4: Initial release (1.0.0) of the shared `review` PR-reviewer agentic workflow (gh-aw) under `workflows/review/`, installable via `gh aw add Khan/actions/workflows/review/review.md`. The generic flow imports repo-specific config (risk tiers, best-practice skills, CI-tooling exclusions, and the reviewer team allowlist) from the consumer's `.github/aw/review/`; OpenTelemetry trace export (OTLP → Sentry) is wired into the workflow frontmatter.
