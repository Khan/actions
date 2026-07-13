# `review` — shared PR-reviewer agentic workflow

A [GitHub Agentic Workflow](https://github.github.com/gh-aw/) that reviews pull
request changes for correctness, conventions, and risk on every push. It leaves
per-line Conventional Comments, and on approval posts a risk/patterns summary
comment and requests the owning teams as reviewers.

The flow here is **generic**; everything repo-specific (risk file patterns, the
best-practice skill catalog, the CI-tooling exclusions, and the reviewer team
allowlist) is supplied by the consuming repo through imports — see
[Consumer configuration](#consumer-configuration) below.

Changes to the reviewer are gated by an eval system (deterministic replay
suite, live A/B on every PR touching this directory, powered and scheduled
measurement runs). To run or extend it, start at
[`eval/README.md`](eval/README.md).

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
   A reviewer that surfaces a real concern its own mandate does not let it report — a
   correctness problem the skill-auditor cannot quote a rule for, or something outside
   a specialist lens's domain — hands it off as an `out_of_lane_observations[]` entry
   instead of dropping it; the orchestrator routes each one into claim validation as a
   non-blocking candidate (label code-assigned, so a handoff can never block on its own).
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
# re-review full|scoped|flip-gated|fast
services/**/migrations/**  tier=high lens=data-migrations
**/*.graphql               lens=api-federation-compat
pkg/auth/**                tier=high direction-dependent lens=security-auth
services/**/testdata/**    tier=trivial
docs/**                    tier=trivial
enable holistic,test-adequacy
re-review scoped
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
- `re-review` sets the repo's re-review mode (see the next section). Default
  `full`; when several lines set it, the last one wins with a warning. An
  unknown mode degrades to `full`: toward more review, never less.

Glob semantics are a practical subset of gitignore/CODEOWNERS: `**` crosses
directories, `*` and `?` stay within a segment, a trailing `/` matches everything
under a directory, and a pattern without `/` matches the basename anywhere.
Malformed lines produce a parse warning (surfaced as a `Note:` on the PR review)
and are skipped; routing degrades to fewer lenses, never to a crashed review.

`ROUTING` is the machine-readable complement to `risk-classification.md`, which
stays the model-facing prose about file *contents*; team ownership stays in
`.github/REVIEWERS`, unchanged.

### Re-review modes (the runs-per-PR cost lever)

The workflow reviews every push, so a PR's lifetime cost is runs-per-PR times
cost-per-run, and measured lifecycles showed cost *rising* per run as review
threads accumulate, with the final approval run the most expensive while
emitting the least. The `re-review` line in `ROUTING` dials how much of the
roster a *repeat* review runs; the first full review of a ready PR always runs
everything, whatever the mode:

| Mode | Repeat review runs | When to use |
| --- | --- | --- |
| `full` | The whole roster over the whole diff (today's behavior). **Default.** | Until the live A/B has priced a cheaper mode for the repo. |
| `scoped` | The whole roster, staged only the hunks that are new since the last fully-reviewed fingerprint (`scoped.diff`); comments stay scoped to those hunks. | The recommended first step down: measured lifecycles caught fresh seeded defects on re-review pushes, which a reconcile-only path would miss. |
| `flip-gated` | Thread reconciliation plus the correctness pass over the new hunks. A REQUEST_CHANGES→APPROVE flip is vetoed by any validated blocking finding from that pass; the pass gates the flip instead of being discarded. | Cheap re-reviews that still cannot flip to approval over a fresh validated defect. |
| `fast` | Thread reconciliation only. | Maximum savings; fresh code on a re-push is guarded only by the tripwire below. |

Three guards keep the cheaper modes honest (`lib/rereview-mode.ts`, deterministic):

- **Ready-for-review anchor.** A fingerprint taken while the PR was a draft
  never anchors cheap re-reviews of the ready PR: the ready PR gets the one
  full review the cheaper modes lean on.
- **Flip gate.** In `flip-gated` mode the dispatched correctness pass's
  validated blocking findings veto the approval flip.
- **Divergence tripwire.** Every full-depth review stamps a content-hashed
  hunk signature into its review body as a hidden comment (it survives cache
  eviction and branch protection's dismiss-stale-approvals, and it (not the
  review state) is what marks a full review as having happened, so a
  COMMENTED-only or dismissed history never wedges the dial). Each push is
  compared against that last fully-reviewed fingerprint; when the unreviewed
  share reaches the threshold (default 0.4), full-review mode re-arms and the
  divergent push gets the whole roster. This is what defeats
  rewrite-after-approval and sparse-PR-then-payload
  (`eval/lifecycle/`, replayed in `eval/lifecycle.test.ts`).

The dial is a measured change, not a default change: it ships `full`
everywhere, so no consumer's behavior moves until its repo adds a `re-review`
line, and that line should be earned the way `enable` lines are, through the
live A/B (arms identical except the ROUTING mode line, priced on recall and
dollars; each run's executed depth lands in `out/rereview-plan.json`, and the
counters aggregate `costByRereviewDepth`). Lifecycle-class changes like this
one are trialed with the seeded-defect skill
(`.claude/skills/review-trial/SKILL.md`).

Re-review behavior is evaluated at three layers, cheapest first:

- **Depth decisions** (`eval/lifecycle/`, deterministic): push sequences
  replayed through the tripwire and depth logic alone; the adversarial
  rewrite-after-approval and sparse-PR-then-payload cases live here.
- **Open-PR corpus cases** (`live.rereview` in a live-enabled case): a case
  that is a mid-review snapshot, not a first review. It stages the prior
  review's threads (with author replies), a stamped prior review derived from
  `priorDiff`, and the depth plan; the live producer then dispatches the
  reconciler (at every depth) plus the depth-sized finder roster, and
  `eval/rereview-match.ts` scores thread-resolution accuracy against
  per-thread ground truth, the flip-gate input (kept blocking count), and
  duplicate comments on kept threads. The A/B runner prices a mode with
  `--re-review-mode` (candidate arm only; baseline stays `full`), and the
  deterministic replay of the same cases exercises the kept-blocking verdict
  floor and the accountability section. The
  `golden-retention-lifecycle-1/2/3` chain is the template: planted bugs, a
  bad partial fix with added bugs, then the full fix.
- **Live trials** (the review-trial skill): the same lifecycle against the
  real workflow on real PRs, reserved for architecture-class changes.

To price every dial setting in one command, `eval/rereview-sweep.ts` runs the
working tree's reviewer over the rereview cases at each mode
(`--modes full,scoped,flip-gated,fast` by default) and reports recall, thread
resolution, flip-gate correctness, duplicates, and dollars per mode. It
dispatches real model calls, so it never runs automatically: add the
`rereview-sweep` label to a PR (the table lands in a sticky PR comment, the
job summary, and the run artifact), dispatch the `Review Re-review Mode
Sweep` workflow against any branch, or run the CLI locally with
`ANTHROPIC_API_KEY` set.

Every model-spending eval has the same manual trigger surface: a PR label
(`full-eval` lifts the A/B to the whole live corpus and now triggers on the
labeling itself, `rereview-sweep` runs the dial sweep, `live-judge` runs the
judged corpus pass, `skip-live-eval` opts a PR out) plus `workflow_dispatch`
for off-PR runs. The A/B also short-circuits before spending: byte-identical
`review.md` in both arms posts a "no reviewable delta" verdict and runs
nothing (`--force-arms` bypasses this for deliberate wobble controls). The mode
is a run parameter, so no special case format exists; three realities the
sweep reports instead: the tripwire can override the dial (each row shows the
EXECUTED depth), pricing the cheap paths needs at least one under-threshold
case (`golden-retention-fix-push`, a one-hunk fix push whose fix plants a
fresh defect inside the new hunk), and `fast` has definitionally zero
fresh-defect recall (its cost, shown as recall against dollars).

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

### Feedback signal: thumbs sweep and live counters

Two small scheduled workflows in each consumer repo turn on the tuning loop's
production signal. Both are plain GitHub Actions YAML (not gh-aw), both check
out this repo at the pinned `review-v*` tag and run lib scripts with
`npx -y tsx`, and neither touches review semantics:

- **Thumbs sweep** (`lib/run-thumbs-sweep.ts`, every 1-2 hours): collects
  reactions on the reviewer's comments at both grains (inline review comments,
  identified by the code-owned Conventional-Comment label prefixes; the
  risks/patterns summary comment, identified by its hidden marker) and posts
  exactly one "why?" follow-up per newly-downvoted comment, offering the closed
  reason vocabulary (`incorrect` / `unimportant` / `unclear` / `duplicate`).
  Reactions are tallied with the same sets gh-aw's outcome evaluation uses
  (👍/❤️/🎉/🚀 positive, 👎/😕 negative; a 😕 triggers the follow-up like a 👎),
  and resolved inline threads are counted as their own positive column: threads
  also get resolved just to clear noise, so resolution is reported alongside
  the reaction tallies rather than folded into them. Idempotent across restarts
  via the hidden follow-up markers; bounded to PRs updated in the last 14 days
  (`REVIEW_SWEEP_LOOKBACK_DAYS`), skipping PRs closed or merged more than 3
  days ago (`REVIEW_SWEEP_CLOSED_GRACE_DAYS`; feedback lands around merge time,
  after which a landed PR stops changing). Needs only `pull-requests: write`.
  The sweep run needs `npm ci --omit=dev` in the checked-out
  `workflows/review/` first (the sweep's `octokit` dependency is pinned exactly
  in `package.json`, with the transitive tree locked by the committed
  `package-lock.json`); the other lib scripts remain dependency-free. Each run's
  `SweepResult` and API-request count land in the job summary.
- **Live counters** (`lib/counters-report.ts`, weekly): the workflow downloads
  the review runs' per-run artifacts (bounded window), and the script
  aggregates them with `lib/counters.ts` into the job summary — verdict mix,
  comments/run, validator drop rate, cost/run. Needs only `actions: read`.

The reviewer posts as `github-actions[bot]` (gh-aw safe outputs use the
workflow's own token), so that login is both the sweep's `botLogin` filter and
the author of its follow-ups; every count in the sweep excludes that login's
own reactions, so the seeded nudge pair (below) is never live signal.

### Relationship to the gh-aw outcome-collector

Consumer repos also run gh-aw's outcome-collector workflow, which periodically
classifies every agentic safe output as accepted / rejected / ignored /
pending and exports the results to Sentry over OTLP. The two systems answer
different questions and neither replaces the other:

- **Outcome-collector**: passive fleet-wide acceptance telemetry. It never
  writes to GitHub, so it can observe engagement but cannot ask *why* a
  comment was downvoted. Its data lives in Sentry.
- **Thumbs sweep**: active reason elicitation for the reviewer's tuning loop.
  Its "why?" follow-ups produce the closed reason labels that calibrate the
  eval-suite judge and feed dismissal learning. Its data lives in each run's
  job summary and stdout JSON (not exported to OTel today).

Two known interactions:

- **Nudge seeding** is planned as a post-time step in the consumer repos'
  review workflow (a custom safe-output job that reacts 👍/👎 to each posted
  comment seconds after posting), not in the sweep: gh-aw cannot react to its
  own safe outputs natively, and comments posted via `GITHUB_TOKEN` emit no
  workflow events, so post-time is the only immediate option.
- Once seeding is live, the outcome-collector's `add_comment` metric for the
  review workflow is **inflated by design**: its evaluator counts any reaction
  as acceptance with no reactor identity, so every seeded summary comment
  reads as `accepted`. The inflation is bounded to that one metric (inline
  comments and submitted reviews are evaluated by other means), and the sweep's
  identity-filtered tallies are the authoritative reviewer-comment engagement
  numbers. An upstream gh-aw change to identity-aware reaction counting would
  retire this caveat.

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
