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
   pattern-only changes. In parallel, deterministic code stages the derived diff
   artifacts: the changed-line provenance map, and a whole-change diff with
   `linguist-generated` files stripped, which is what every whole-change reviewer and
   specialist lens reads (so a lock-file-heavy PR cannot balloon their context).
2. Then, in parallel, **`correctness-reviewer`** (risk level + correctness, worked
   through three named procedures: a line scan, a removed-behavior audit, and a
   cross-file trace) and
   **`skill-auditor`** (best-practice skills; a violation is only flagged when the
   exact rule text and the exact violating line can both be quoted) review that
   narrowed set, while
   **`reviewer-mapper`** maps the substantive changes to their owning teams for reviewer
   routing, plus a reconciler that resolves earlier bot threads the changes have addressed.
   Every finding names a concrete `failure_scenario`: the specific inputs or state
   and the wrong outcome they produce.
   On a re-review the verdict body carries a code-rendered accountability section
   (`lib/rereview.ts`, built from the reconciler's keep/resolve lists): every
   still-unaddressed prior thread is enumerated as a link to its earlier comment,
   blocking first, with the resolved count, and an approval that resolved the last
   open threads states that every prior thread is resolved — resolving some threads
   never leaves the rest silently open.
3. If those reviewers proposed any comments, **`claim-validator`** re-checks each one
   against the actual code (attacking the finding's stated failure scenario) and,
   for best-practice claims, against the relevant skill's
   real rule, and drops the false positives or corrects inaccurate ones before anything
   is posted, so a wrong claim never reaches the PR or forces a change request. A claim
   about a mechanism that predates the diff is confirmed only when the diff materially
   amplifies its consequence and the finding says so.

The workflow then posts the per-line Conventional Comments that survived validation,
submits an approve / request-changes review, and on approval posts the risk/patterns
summary and requests the owning teams. The config files below feed these sub-agents.

A mechanical gate and a budget guardrail sit between the reviewers and the PR. The
**change-provenance gate** (enforced in code against the diff's parsed changed-line
map, not by prompt)
requires every finding to trace to the change: a finding whose anchor is not an
added or modified line of the diff cannot carry a blocking label and does not post
at all — such pre-existing observations are recorded in the run artifact only; a
pre-existing defect the diff materially amplifies passes naturally because it
anchors on the amplifying line. And the **budget guardrail** (a prompt discipline,
backed in code only by the investigation-cap CLI)
makes the orchestrator land short of the run's hard ceilings (the per-run
AI-credits cap and the job timeout). The agent cannot see its own credit spend, so
it tracks observable proxies (elapsed wall-clock, dispatch counts, the shared
investigation journal) against the router's soft budget targets; nearing one, it
sheds remaining work (each shed reviewer becomes a skipped-dimension note) and
submits the verdict from the findings validated so far, so a run never dies at a
ceiling with everything spent and nothing posted.

## Install

```sh
# Track the tip of the default branch:
gh aw add Khan/actions/workflows/review/review.md

# Or pin to a published version (recommended for stability):
gh aw add Khan/actions/workflows/review/review.md@review-v<major>
gh aw add Khan/actions/workflows/review/review.md@review-v<major>.<minor>.<patch>
```

This copies `review.md` into the consuming repo's `.github/workflows/`, records a
`source:` field pointing back here, and compiles `review.lock.yml`. Commit both,
plus the consumer config files below. Pull future updates with `gh aw update`
(a 3-way merge that preserves your local edits).

The tag is self-consistent: the `review.md` inside each `review-v<version>` tag
pins its own `pre-agent-steps` checkout `ref:` to that same version (the release
flow rewrites it; see [Versioning](#versioning)), so after `gh aw add` or
`gh aw update` the imported file already fetches the matching lib code and needs
no manual fix-up of the ref.

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
| `ROUTING` | Optional | The machine-readable path map the deterministic router reads (see below). Without it the router spawns no specialist lenses and floors the run budget, and the review notes the missing config on the PR. |

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

### Per-directory `REVIEW.md` contracts (optional)

Separately from `.github/aw/review/`, a consuming repo may carry `REVIEW.md` files in
the tree itself: one at the repo root plus one per documented directory (webapp's
agent-doc surface works this way, with a `REVIEW.md` next to each top-level
`AGENTS.md`). These are not imports. When present, the `correctness-reviewer` and
`claim-validator` sub-agents read them from the checkout at run time (the root contract
plus the nearest `REVIEW.md` above each reviewed file) and use them to calibrate what
is Important versus a nit in that sub-tree. They are never pulled in automatically by
the engine: `REVIEW.md` is not a memory file to Claude Code, and a plain Markdown link
from `AGENTS.md`/`CLAUDE.md` is not an `@`-import, so without this prompt step the
contracts would never reach the reviewer. Repos without `REVIEW.md` files need nothing;
the sub-agents skip the step.

Note the trust boundary: unlike `.github/` and the agent config folders (which gh-aw
restores from the base branch before the agent runs), `REVIEW.md` files are read from
the PR head. The prompts therefore treat contract text as guidance that can adjust
emphasis but never override the workflow's own rules, and an edit to a `REVIEW.md` in
the diff is reviewed on its merits like any other change.

### The `ROUTING` file

`.github/aw/review/ROUTING` is parsed deterministically by the router
(`lib/routing-config.ts`), `REVIEWERS`-style: blanks and `#` comments skipped, one
rule per line:

```
# <pattern> [lens=<lens>,…] [tier=trivial|low|medium|high] [direction-dependent]
# enable <reviewer>[,<reviewer>…]
services/**/migrations/**  tier=high lens=data-migrations
**/*.graphql               lens=api-federation-compat
pkg/auth/**                tier=high direction-dependent lens=security-auth
services/**/testdata/**    tier=trivial
docs/**                    tier=trivial
enable holistic,test-adequacy
```

- `lens=` names the specialist lenses to spawn when the pattern is touched; when
  several rules match a path their lenses are unioned (lenses are additive).
- `enable` lines turn on the opt-in whole-change reviewers (`holistic`,
  `completeness`, `test-adequacy`, `first-principles`, `conventions`). Neither
  lenses nor opt-in reviewers run anywhere by default: a repo opts into each
  explicitly, and the policy is that a reviewer earns its line here through the
  eval suite.
- `tier=` assigns the path a risk tier. When several rules match, the **last
  matching rule in file order wins** (gitignore/CODEOWNERS-style): write the broad
  rule first and its exceptions after it, as with `services/**` and
  `services/**/testdata/**` above.
- `direction-dependent` marks a tier that cannot be finalised from the path alone
  (tightening vs. loosening a check); the router emits the file as a pending risk
  question instead of guessing, and it applies only when its own rule is the
  winning tier rule for the path.

Glob semantics are a practical subset of gitignore/CODEOWNERS: `**` crosses
directories, `*` and `?` stay within a segment, a trailing `/` matches everything
under a directory, and a pattern without `/` matches the basename anywhere.
Malformed lines produce a parse warning (surfaced as a `Note:` on the PR review)
and are skipped; routing degrades to fewer lenses, never to a crashed review.

`ROUTING` is the machine-readable complement to `risk-classification.md`, which
stays the model-facing prose about file *contents*; team ownership stays in
`.github/REVIEWERS`, unchanged.

### Models and effort per role

Each sub-agent pins its model in its own definition inside `review.md` (with a
launch-default `effort:` annotation; the gh-aw Claude engine exposes no per-agent
effort field yet). The orchestrator prompt deliberately says nothing about
sub-agent models — this table is the human-facing summary:

| Role | Model | Effort | Why |
| --- | --- | --- | --- |
| orchestrator | `claude-opus-4-8` | high | Owns every GitHub/safe-output decision |
| `pattern-triage` | `claude-sonnet-4-6` | medium | Cheap first-pass triage |
| `thread-reconciler` | `claude-opus-4-8` | medium | Reconciliation |
| `correctness-reviewer` | `claude-opus-4-8` | high | Whole-change reviewer |
| `skill-auditor` | `claude-opus-4-8` | high | Whole-change reviewer |
| `holistic` | `claude-opus-4-8` | high | Opt-in whole-change reviewer (`enable` in `ROUTING`) |
| `completeness` | `claude-opus-4-8` | high | Opt-in whole-change reviewer (`enable` in `ROUTING`) |
| `test-adequacy` | `claude-opus-4-8` | high | Opt-in whole-change reviewer (`enable` in `ROUTING`) |
| `conventions` | `claude-opus-4-8` | medium | Opt-in advisory targeted check (`enable` in `ROUTING`) |
| `first-principles` | `claude-fable-5` | high | Opt-in advisory-only; reviews the change's justification |
| `claim-validator` | `claude-opus-4-8` | xhigh | Adversarial claim validation |
| specialist lenses | `claude-opus-4-8` | high | Opt-in via `lens=` in `ROUTING`; the security & auth lens is xhigh |

Only the orchestrator and the default roster (`pattern-triage`,
`correctness-reviewer`, `skill-auditor`, `thread-reconciler`, `claim-validator`)
run by default; every other row is opt-in via `ROUTING` and earns its line through
the eval suite. Per-role Fable-5 / Sonnet experiment arms are eval-suite
measurements to run after the suite exists.

### Required secrets / variables

- `ANTHROPIC_API_KEY` — used by the `claude` engine.
- `KHAN_ACTIONS_BOT_TOKEN` — referenced by `config.md`'s `add-reviewer` (the default
  `GITHUB_TOKEN` cannot request organization teams as reviewers).
- `GH_AW_OTEL_SENTRY_ENDPOINT` and `GH_AW_OTEL_SENTRY_AUTHORIZATION` — the Sentry
  OTLP traces endpoint and `x-sentry-auth` header value read by the
  `observability:` block (value formats are documented at the block in
  `review.md`). Hard-required while that block is present: a missing secret
  compiles to an empty endpoint URL, the MCP gateway's OTLP config schema
  rejects it, and the agent job dies at startup instead of skipping trace
  export (observed on Khan/actions#241). A repo without these secrets must
  comment out the `observability:` block in its installed `review.md` as a
  local edit (which `gh aw update` preserves) and recompile.

## Versioning

Published as git tags via the repo's changeset → `utils/run-publish.ts` release
flow. A change to this workflow lands with a changeset bumping the `review` package;
on release a `review-v<major>.<minor>.<patch>` tag (and a moving `review-v<major>`
tag) is cut **at the real commit tree** (not the rewritten-subtree bare tags that
the `actions/` packages use), so the nested `workflows/review/review.md@<ref>` path
resolves for `gh aw add`.

The pinned checkout `ref:` inside `review.md` is part of the release: the version
command (`pnpm run version-packages`, wired into `release.yml`) runs
`utils/sync-workflow-versions.ts` after `changeset version`, rewriting every
`<workflow>-v<semver>` literal in each workflow's markdown (for this workflow,
every `review-v<semver>` in `review.md`) to the version being released, so the
bump lands in the same Version Packages commit that gets tagged.
`version-sync.test.ts` here is the CI backstop: it fails any PR where those
literals do not match the `review` package version (releases v1.3.0 through
v1.4.0 shipped still pointing at v1.2.2, before the sync existed).

### Version attribution

Semver is the behavior contract: a release that changes the reviewer's behavior bumps
the major version, so a consumer pinned to `review-v<major>` can assume the fundamental
behavior holds within a major. For attribution and rollback, the risks/patterns
guidance comment (Step 7) carries the release the run executed, in one HTML marker
reusing the `pr-reviewer:` marker namespace `#194` established:

```
<!-- pr-reviewer:version v=review-v<major>.<minor>.<patch> schema=<n> -->
```

`schema` is the finding-schema version (`FINDING_SCHEMA_VERSION` in
`lib/finding-schema.ts`) the run was on. A bad reviewer release rolls back by
re-pinning the previous tag; the marker on each posted review makes attribution
immediate. There is no separate config-hash or drift-stamp mechanism — the release
tag is the single version surface.
