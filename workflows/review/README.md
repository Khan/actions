# `review` — shared PR-reviewer agentic workflow

A [GitHub Agentic Workflow](https://github.github.com/gh-aw/) that reviews pull
request changes for correctness, conventions, and risk on every push. It leaves
per-line Conventional Comments, and on approval posts a risk/patterns summary
comment and requests the owning teams as reviewers.

The flow here is **generic**; everything repo-specific (risk file patterns, the
best-practice skill catalog, the CI-tooling exclusions, and the reviewer team
allowlist) is supplied by the consuming repo through imports — see
[Consumer configuration](#consumer-configuration) below.

## Install

```sh
# Track the tip of the default branch:
gh aw add Khan/actions/workflows/review/review.md

# Or pin to a published version (recommended for stability):
gh aw add Khan/actions/workflows/review/review.md@review-v0
gh aw add Khan/actions/workflows/review/review.md@review-v0.1.0
```

This copies `review.md` into the consuming repo's `.github/workflows/`, records a
`source:` field pointing back here, and compiles `review.lock.yml`. Commit both,
plus the consumer config files below. Pull future updates with `gh aw update`
(a 3-way merge that preserves your local edits).

## Consumer configuration

The workflow imports the following files **from the consuming repo** (they resolve
locally at compile/run time, not from this repo). Create them under
`.github/aw/review/`:

| File | Required? | What it provides |
| --- | --- | --- |
| `config.md` | **Required** | Frontmatter only. Defines the `add-reviewer` safe output — your `allowed-team-reviewers` allowlist and the bot token used to request teams. Compilation fails without it (by design — a reviewer with no allowlist would silently request no one). |
| `risk-classification.md` | Optional | Body snippet injected into Step 3: your High/Medium/Low/Trivial file patterns. Without it the reviewer falls back to judgment on the four-tier model. |
| `skills.md` | Optional | Body snippet injected into Step 5: the catalog of best-practice skill files (and when each applies) to evaluate the diff against. Without it Step 5 is a no-op. |
| `ci-tooling.md` | Optional | Body snippet injected into Step 4: the lint/format/type/test issues your CI already catches, so the reviewer doesn't flag them. |

These imported snippets are plain Markdown — they must not contain
`${{ }}` expressions (gh-aw rejects those inside imports). `add-reviewer` lives
**only** in `config.md`; do not also define it in the installed `review.md`, or the
main workflow would override the import and discard your allowlist.

Repo-specific frontmatter that imports can't merge (e.g. an `if:` condition to skip
deploy/automation branches or forks) goes directly in your installed `review.md` as
a local edit; `gh aw update` preserves it.

### Required secrets / variables

- `ANTHROPIC_API_KEY` — used by the `claude` engine.
- `KHAN_ACTIONS_BOT_TOKEN` — referenced by `config.md`'s `add-reviewer` (the default
  `GITHUB_TOKEN` cannot request organization teams as reviewers).

## Versioning

Published as git tags via the repo's changeset → `utils/run-publish.ts` release
flow. A change to this workflow lands with a changeset bumping the `review` package;
on release a `review-v<major>.<minor>.<patch>` tag (and a moving `review-v<major>`
tag) is cut **at the real commit tree** (not the rewritten-subtree bare tags that
the `actions/` packages use), so the nested `workflows/review/review.md@<ref>` path
resolves for `gh aw add`.
