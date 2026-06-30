# `review` — shared PR-reviewer agentic workflow

A [GitHub Agentic Workflow](https://github.github.com/gh-aw/) that reviews pull
request changes for correctness, conventions, and risk on every push. It leaves
per-line Conventional Comments, and on approval posts a risk/patterns summary
comment and requests the owning teams as reviewers.

The flow here is **generic**; everything repo-specific (risk file patterns, the
best-practice skill catalog, the CI-tooling exclusions, and the reviewer team
allowlist) is supplied by the consuming repo through imports — see
[Consumer configuration](#consumer-configuration) below.

## How it works

On each run the workflow gathers the PR diff, then delegates the analysis to a set of
read-only **sub-agents** (it makes every GitHub and comment call itself):

1. **`pattern-triage`** finds common cross-file patterns and narrows the diff to the
   files that need a real review — dropping generated, formatting-only, and
   pattern-only changes.
2. Then, in parallel, **`correctness-reviewer`** (risk level + correctness) and
   **`skill-auditor`** (best-practice skills) review that narrowed set, while
   **`reviewer-mapper`** maps the substantive changes to their owning teams for reviewer
   routing, plus a reconciler that resolves earlier bot threads the changes have addressed.
3. If those reviewers proposed any comments, **`claim-validator`** re-checks each one
   against the actual code — and, for best-practice claims, against the relevant skill's
   real rule — and drops the false positives or corrects inaccurate ones before anything
   is posted, so a wrong claim never reaches the PR or forces a change request.

The workflow then posts the per-line Conventional Comments that survived validation,
submits an approve / request-changes review, and on approval posts the risk/patterns
summary and requests the owning teams. The config files below feed these sub-agents.

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
| `config.md` | **Required** | Frontmatter only. Defines the `add-reviewer` safe output — your `allowed-team-reviewers` allowlist and the bot token used to request teams. |
| `risk-classification.md` | **Required** | Your High/Medium/Low/Trivial file patterns, imported into the `correctness-reviewer` sub-agent, which assigns each reviewed file a risk level. |
| `ci-tooling.md` | **Required** | The lint/format/type/test issues your CI already catches. Imported into `correctness-reviewer` so it doesn't flag them, and into `claim-validator` so it drops any correctness claim that flags a CI-caught issue. |
| `skills.md` | **Required** | The catalog of best-practice skill files (and when each applies). Imported into `skill-auditor` to evaluate the diff against, and into `claim-validator` so it can verify a flagged skill violation against the skill's actual rule. |

All four are **required**, but validated at different times. `config.md` is a
frontmatter import, embedded and checked at **compile time** — `gh aw compile` fails if
it's missing. The other three are `{{#runtime-import}}` body imports inside the
sub-agent prompts; they resolve when the workflow **runs**, so a missing one surfaces as
a `Runtime import file not found` failure on the next PR — not at compile time. The
optional `{{#runtime-import? … }}` form was dropped either way, so a missing config
fails loudly rather than silently degrading the review.

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
