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

1. Before the agent starts, a deterministic pre-agent step (`lib/stage-pr.ts`)
   stages the whole review context on disk: the PR metadata and changed files
   (fetched from the GitHub API), the rebuilt unified diff, the diff facts
   (fingerprint and hunk signature) and newly-changed-code scope, the prior bot
   reviews, the PR's unresolved review threads (split into this bot's own, with
   their full reply chains, and the `{path, line}` of everyone else's, which the
   review defers to), the router's first pass, the changed-line provenance map, a
   whole-change diff with `linguist-generated` files stripped (what every
   whole-change reviewer and specialist lens reads, so a lock-file-heavy PR
   cannot balloon their context), and the re-review depth plan. The
   orchestrator wakes with files to read, not staging to perform. Then
   **`pattern-triage`** finds common cross-file patterns and narrows the diff to the
   files that need a real review — dropping generated, formatting-only, and
   pattern-only changes.
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
anchors on the amplifying line. And the **run budget** is enforced where the
spending happens: the dispatcher caps the roster at
`runBudget.maxReviewerInvocations` (every capped-out reviewer becomes a
code-rendered skipped-dimension note), the investigation-cap CLI bounds
per-finding tool calls, and the per-sub-agent timeout is a hang backstop, so a
run lands with whatever validated findings it has instead of dying at a
ceiling with everything spent and nothing posted.

One more gate sits after the agent itself: the **dispatch-conformance gate**
(`lib/dispatch-gate.ts`, a `post-steps:` step in the agent job). gh-aw queues
every safe output during the agent run and executes the queue from a separate
`safe_outputs` job, so the gate runs at the hand-off: it checks the queued
verdict and findings against the staged `out/` sub-agent outputs (per re-review
depth: the correctness pass wherever the depth dispatches one, the
claim-validator whenever findings post, a disclosure note for every planned
shed, no blocking inline comment under an APPROVE, the reduced-depth flip veto
over kept blocking threads, and every queued thread resolution backed by the
reconciler's decision) and, on violation, strips the posting items from the
queue and fails the job. A run that skipped its own dispatch protocol (observed in production:
zero sub-agents dispatched, verdict submitted, nothing disclosed) becomes a
red run that posts nothing instead of a normal-looking review; the run
artifact keeps the original queue and the gate report for diagnosis. The gate
proves the reviewer outputs were staged; script-driven dispatch makes skipping
dispatch structural rather than detected.

Most of the run is code rather than model turns. The prompt's Step 3 is one
CLI invocation (`lib/dispatch.ts`) that runs triage, the reviewer fan-out
(roster, budget cap, and planned sheds computed from `routing.json`), the
provenance gate, the scope filter, cross-source dedup, open-thread suppression
(a candidate describing a defect an open bot thread already tracks posts no
duplicate; a suppressed blocking candidate still floors the verdict),
adjudicated-thread suppression (a non-blocking candidate re-deriving a defect
a human settled by resolving the bot's thread or downvoting its opener posts
no new thread; a blocking candidate is never suppressed this way, so a
regression re-flag stays visible), and
claim validation, inside the same firewall sandbox (the api-proxy meters and
caps script-spawned sub-agents exactly like Task-spawned ones). Each sub-agent
delivers its result through an in-process `submit_result` MCP tool whose input
is validated against the agent's exact output contract at the tool boundary
(`lib/dispatch-runner.ts`), so a drifted shape is corrected in-session instead
of voiding the dimension; free-text finals remain the fallback. Steps 4-6 are
code too: the submission CLI (`lib/submission.ts`) computes the verdict,
renders the comments and the full review body, and stages
`submission-plan.json`; the orchestrator emits safe outputs that must match the
plan (the gate blocks any deviation), which reduces its model role to typing
MCP calls the plan dictates. Step 9's cache record is code as well
(`lib/cache-record.ts`, invoked once after the emission): the
fingerprint-carrier fields are copied verbatim from staged files and
corroborated against the safe-output queue, never serialized from the model's
memory. The safe-output emission itself is the remaining seam: the queue is a
run-local JSONL append that needs no credentials, but the agent sandbox mounts
`${RUNNER_TEMP}/gh-aw` read-only, so only the safeoutputs MCP container can
write it. Removing the seam wants a writable path into the queue (an upstream
mount change, or a post-agent step on the host); neither is tested yet.

## What your feedback does

The reviewer reads four signals off its own threads. What each one means, so
you can pick the one that says what you mean:

- **Reply to the thread.** Read in full: the reconciler sees every reply
  chain verbatim, and the orchestrator surfaces replies that factually
  dispute a finding to claim validation. But a reply alone does not close
  anything: the reconciler resolves a thread when the CODE changes to address
  it, so arguing a finding down in prose and pushing nothing leaves it open
  (and blocking, if it was blocking).
- **Resolve the thread.** "This is settled." The thread leaves the
  accountability recap, and the defect joins the adjudicated corpus: a later
  run that re-derives the same defect (any wording, any nearby line) posts
  nothing, unless it comes back at BLOCKING severity, which always posts (a
  regression worth stopping the PR for must never be silenced by an old
  resolution). Threads the bot resolved itself (because a push fixed them)
  do not join the corpus; a fixed defect that reappears is a fresh finding.
- **👎 the finding's comment.** Same adjudication as resolving, through the
  reaction channel: a 👎 on a thread's OPENING comment puts its defect in the
  adjudicated corpus whether or not you also resolve. The feedback sweep may
  additionally ask one follow-up ("why?"), which calibrates the eval suite;
  answering it is welcome but the 👎 alone is what suppresses. Reactions on
  replies are conversation, not adjudication. 👎 is the ONLY adjudicating
  reaction: a 😕 triggers the sweep's follow-up question like a 👎 does, but
  it does not suppress (😕 reads as "unclear", not "wrong", and ambiguity is
  worth a question, not a standing suppression). The bot's own seeded nudge
  reactions never count as adjudication either.
- **Hide the comment.** Reads as nothing. The reviewer does not see hidden
  state; resolve or 👎 instead.

Per-PR opt-out and re-runs are consumer-trigger concerns: repos using the
stock push trigger skip any PR carrying the `skip-ai-review` label, and
consumers with comment triggers or shims should honor the same label (see
Khan/webapp's kore shim).

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

### Onboarding a whole repo

`gh aw add` is the mechanical half. The judgment half (writing the five consumer
config files for *that* repo's blast radius, the two local edits to the installed
`review.md`, the admin blockers only a repo admin can clear, and a PR body that
discloses what is generated versus decided) is choreographed by the
[`review-onboarding` skill](../../.claude/skills/review-onboarding/SKILL.md)
in this repo. [`Khan/kore-marketplace#3`](https://github.com/Khan/kore-marketplace/pull/3)
is the template it produces.

Validate any install (new or existing) with the consumer-config checker, run from
a checkout of the tag the consumer pins:

```sh
git -C <consumer> ls-files | npx -y tsx workflows/review/lib/check-consumer-config.ts \
    --repo <consumer> --files-from -

# Why does this path get this tier? (every matching ROUTING rule, last one wins)
npx -y tsx workflows/review/lib/check-consumer-config.ts --repo <consumer> --explain <path>
```

It reads the install through the *production* parsers (`route()`,
`parseRoutingConfig`, `parseGitattributesGenerated`), so it never drifts from
what a review actually does, and it reports the whole class of mistakes that
otherwise surface as a red run on someone's PR: a missing runtime import, a
`${{ }}` expression inside one, `add-reviewer` defined in both `review.md` and
`config.md` (the main workflow wins, discarding the allowlist), a dropped
`imports:` line, an empty team allowlist in a repo that *has* a `.github/REVIEWERS`
ownership map, a missing or unmarked `.lock.yml`, an unmarked
`agentics-maintenance.yml`, a live `observability:` block, the shipped credit
ceiling, `ROUTING` parse warnings, inert lens payloads, reviewer config that does
not route to `high`, and the resolved tier of every tracked file. Errors exit 1;
`--strict` also fails on warnings, and `--json` emits the report for tooling.

Two of those deserve a note, because both are "valid, but invisible" rather than
broken. An empty `allowed-team-reviewers` is only an **error** when
`.github/REVIEWERS` exists: that file is the router's only source of ownership, so
without it Step 8 requests nobody regardless, and the empty allowlist is an accurate
statement that the repo does not do reviewer requests (reported as
`reviewer-requests-inert`). Requiring a team there would only get an inert one
invented to satisfy the check. And `agentics-maintenance.yml` is `gh aw compile`
output that is *not* named `*.lock.yml`, so the marker every consumer was told to add
misses it, and ~600 generated lines get line-reviewed until it has its own.

Follow-up, not yet built: the failure class the checker targets (config failing
late and quietly) recurs on every later edit to ROUTING or `config.md`, not just
at onboarding. `checkConsumerConfig` is pure with an injected filesystem and
already ships `--json` and `--strict`, so a consumer CI job gating PRs that
touch the config paths is the natural next layer; nothing in the checker
blocks it.

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
| `lenses/<lens>.md` | Optional | Per-lens payloads: your repo's surface-specific review rules and extra hunts, imported into the matching reviewer (see [Per-lens payloads](#per-lens-payloads-lenseslensmd)). Absent files import nothing. |
| `correctness-checks.md` | Deprecated | Alias for `lenses/correctness.md`; still imported for compatibility, and removed in the next major release. Carry only one: when both exist, both are imported (duplicating the checks) and the router warns; an alias carried alone gets a deprecation note on each review. |

The first four are **required**, but validated at different times. `config.md` is a
frontmatter import, embedded and checked at **compile time** — `gh aw compile` fails if
it's missing. The other three are `{{#runtime-import}}` body imports inside the
sub-agent prompts; they resolve when the workflow **runs**, so a missing one surfaces as
a `Runtime import file not found` failure on the next PR — not at compile time. The
required configs deliberately avoid the optional `{{#runtime-import? … }}` form, so a
missing one fails loudly rather than silently degrading the review. The lens payloads
(and the deprecated `correctness-checks.md`) use the optional form: a repo that
defines none is valid, and a missing payload file imports nothing.

These imported snippets are plain Markdown — they must not contain
`${{ }}` expressions (gh-aw rejects those inside imports). `add-reviewer` lives
**only** in `config.md`; do not also define it in the installed `review.md`, or the
main workflow would override the import and discard your allowlist.

Repo-specific frontmatter that imports can't merge (e.g. an `if:` condition to skip
deploy/automation branches or forks) goes directly in your installed `review.md` as
a local edit; `gh aw update` preserves it.

### Per-lens payloads (`lenses/<lens>.md`)

A consuming repo may define surface-specific review rules and extra hunts for any
reviewer lens by adding `.github/aw/review/lenses/<lens>.md`. Each file is imported
at runtime into the matching reviewer prompt, in a "Repo-specific rules and hunts"
section the reviewer treats exactly like its built-in rules and tri-state hunts. All
imports are optional: a repo with no `lenses/` directory gets exactly the shared
behavior, and lens names never vary per repo; only their payloads do.

Valid names are the eleven specialist lenses (`security-auth`,
`ai-safety-moderation`, `mass-comms-coppa`, `caching-resource`, `data-migrations`,
`concurrency-async`, `api-federation-compat`, `cross-deploy-serialization`,
`deploy-infra-config`, `money-payments`, `content-i18n`) plus `correctness`, which
feeds the always-on `correctness-reviewer`. `lenses/correctness.md` supersedes the
older `correctness-checks.md` (still imported as a deprecated alias until the next
major release; carry at most one of the two). A payload only reaches a specialist
lens on PRs where the router actually spawns that lens, so a payload without
matching `ROUTING` `lens=` rules is inert. The router warns in the review body's
note lines when a payload would be silently inert: a filename that matches no
imported payload, a specialist payload no `ROUTING` rule routes, the correctness
alias carried alongside its replacement (or, as a deprecation nudge, carried at
all), or a `lenses` path that is not a readable directory.

Payloads are **additive**: they extend the lens's shared rules and hunts but never
relax or override them, and the shared rules win on any conflict (the lens prompts
state this next to the import). A payload cannot whitelist a defect or lower the
evidence bar; it can only add repo-specific things to check.

**Where a rule belongs** (the three-way contribution rule):

- **Shared skeleton** (this repo's `review.md`): rules that hold for every consumer
  on every stack. If a rule needs stack-specific phrasing ("Datastore query",
  "DOM sink"), it does not belong here; keep only its surface-neutral core.
- **Lens payload** (your repo's `lenses/<lens>.md`): rules and hunts specific to
  your repo's surface. Server repos carry server-surface checks (query bounds,
  datastore idioms); client repos carry client-surface checks (DOM XSS sinks, token
  storage, postMessage origins).
- **Skills** (your repo's `skills.md` catalog): house conventions and sanctioned
  fixes, audited by `skill-auditor` rather than baked into a lens.

Payloads are model-facing prose owned by the consuming repo's engineers, like
`risk-classification.md` and the skills catalog before them; the repo's normal code
review is the bar for editing them. Note that a payload changes reviewer behavior
without touching Khan/actions: when in doubt about a large payload change, ask the
workflow maintainers for an eval run over payload-carrying corpus cases.

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
# re-review full|scoped|flip-gated|fast [blocking-only]
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
  `completeness`, `test-adequacy`, `first-principles`, `conventions`,
  `documentation`). Neither lenses nor opt-in reviewers run anywhere by default:
  a repo opts into each explicitly, and the policy is that a reviewer earns its
  line here through the eval suite.
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
  unknown mode degrades to `full`: toward more review, never less. The
  optional `blocking-only` modifier changes the repeat review's posting
  surface (see [Re-review modes](#re-review-modes-the-runs-per-pr-cost-lever));
  an unknown modifier warns and is ignored, and the mode still applies.

The `security-auth` lens's GitHub Actions workflow hunts (`pwn-request`,
`over-scoped-secret`) run only when the lens spawns, so a repo that wants
workflow changes reviewed must route the workflow paths:

```
.github/workflows/**       tier=high lens=security-auth
**/action.yml              tier=high lens=security-auth
**/action.yaml             tier=high lens=security-auth
```

A repo that stages deliberately-vulnerable workflow fixtures (test corpora,
training material) should scope these patterns to its real action directories
instead of `**`: lenses cannot be un-routed by a later rule, so a broad
pattern would route the fixtures to a live lens.

Glob semantics are a practical subset of gitignore/CODEOWNERS: `**` crosses
directories, `*` and `?` stay within a segment, a trailing `/` matches everything
under a directory, and a pattern without `/` matches the basename anywhere.
Malformed lines produce a parse warning (surfaced as a `Note:` on the PR review)
and are skipped; routing degrades to fewer lenses, never to a crashed review.

`ROUTING` is the machine-readable complement to `risk-classification.md`, which
stays the model-facing prose about file *contents*; team ownership stays in
`.github/REVIEWERS`, unchanged.

### The `documentation` reviewer (opt-in)

`enable documentation` turns on a reviewer that checks the **comments and prose docs
the diff adds or changes**, plus the **PR title and description**, against a
documentation policy. It is advisory-only and
opt-in like `conventions`, and it exists because comment quality is an enforcement
problem rather than a prompt problem: every author, human or agent, is told what a
good comment looks like, and nothing checks.

The policy is one paragraph with a list under it, and it lives **inline in the
reviewer's definition** in `review.md` (like the specialist lenses' `Review rules`
sections), not in a consumer config file. Two reasons: the baseline is universal
(a comment earns its line by carrying information the code does not), and a fifth
required `{{#runtime-import}}` would make the review fail at run time in any repo
that had not yet written the file. Repo-specific calibration rides the per-directory
`REVIEW.md` contracts that already exist, which is also the answer to "backend and
frontend want different things here": they can, per directory, without a global
decision.

The policy has two halves. The **content half** is the original test: a comment
earns its line by carrying information the code does not. The **readability half**
applies to prose docs and the PR title/description, and is about translation cost,
not taste: metaphor in place of the mechanism (a sentence the reader cannot decode
into concrete operations without already knowing them), a paragraph that restates
an earlier one, and shorthand the document coins but never defines. A
title/description finding carries no path/line and posts PR-level, folded into the
review body; whether the description *matches the diff* stays with `completeness`.

Two things it deliberately does not do:

- **It never reasons about who wrote the text.** It cannot tell whether a human or a
  model wrote a comment, and the policy is the same either way. A finding that reads
  as an accusation of AI authorship is out of bounds even when the comment is bad.
- **It does not police tone or style.** Vivid prose that names its mechanism passes,
  domain terms of art pass, and quoted text (error messages, cited titles) is never
  flaggable. The readability clauses fire only when the reader has to translate.

**The label is load-bearing.** Its findings render as
`suggestion (non-blocking, documentation)` rather than a plain `suggestion
(non-blocking)`. That variant is the only channel by which a downstream consumer can
tell a documentation thread from any other nit: the autofix workflow selects the
threads it may act on by parsing the Conventional-Comment label off each posted
comment, so a documentation-scoped autofix is exactly "the threads carrying this
label". A consequence for consumers: autofix reads labels minted by whichever
reviewer version the repo has **installed**, so a repo must be on a review release
carrying this label before a documentation-scoped autofix finds anything.

**Volume is part of its policy.** The definition caps this reviewer at one finding per
comment, two per file, and five per review, and ranks the policy's clauses so the tail
is dropped from the bottom (readability findings go first, then restatement cleanups; a
comment the diff falsified never does). Readability carries its own sub-cap: at most one
line-anchored readability finding per review (batched: worst instance anchored, up to
three more quoted in its discussion) and at most one PR-level finding on the
title/description. The cap is there because the failure mode is not precision, it is
attention: on a 70-line fixture the reviewer returned seven findings, several of them the
docstring half of a blocking finding whose code fix resolved the observation anyway, and
one the *fourth* thread on a single comment. Two other rules do the same work from
different directions — the definition refuses the docstring half of a code defect
outright, and `dedup.ts` merges cross-source duplicates before validation. Note which
way that merge resolves: the survivor is the highest-severity copy, so a documentation
finding merged into a blocking one loses the `documentation` label and with it its
eligibility for `autofix: docs`. That is the right outcome (the code fix settles both)
and it means tightening dedup narrows the docs autofix worklist toward standalone
comment defects rather than shrinking review coverage.

**It does not converge with the docs autofix scope, by construction.** A docs-scoped
autofix commit's added lines are comment text, which is this reviewer's subject matter,
so they land in the next re-review's newly-changed-code scope by construction: in
Khan/webapp#41207 a clean 5-of-5 docs fix drew three fresh documentation findings on the
prose the fixer had just written. That is why `autofix: docs` is loop-ineligible
permanently under the current scope model; the volume caps above bound how many
findings such a cycle emits, not whether the fixer's prose lands in the next
cycle's in-scope set. `workflows/autofix/lib/scope.ts` carries the full argument, and any
future cadence axis needs an authorship-aware scope bound before it can include `docs`.

The eval corpus carries a matched pair
(`golden-documentation-stale-and-narrated`, `clean-documentation-earned-comments`):
one change that leaves two real documentation defects, one whose comments all earn
their line and must draw no comment at all. Both are live-enabled, which required
teaching the live producer to dispatch a case's `enable`d reviewers — before that,
no opt-in reviewer had a live arm at all and could not earn its `enable` line the
way the policy above says it must.

Neither case carries the `smoke` tag, so the per-PR A/B skips them; price this
reviewer with a targeted `workflow_dispatch` of *Review Eval A/B*
(`cases=golden-documentation-stale-and-narrated,clean-documentation-earned-comments`,
`repeats=3`, since precision on the clean case is the stochastic half). On the
A/B that introduces any new reviewer the **baseline arm cannot define it**: the
producer records that as an absent dimension rather than failing the run, and the
report flags it under *Arm asymmetry*, because the candidate arm's findings there
are pure gain by construction rather than a measured improvement.

### The `.github/NOTIFIED` file (optional)

If the repo has a Gerald [`.github/NOTIFIED`](https://khanacademy.atlassian.net/wiki/spaces/FRONTEND/pages/598278672/Gerald+Documentation)
file, the reviewer honours its **notify** rules (distinct from `REVIEWERS`
*reviewer* ownership): **on approval** it adds a `### Notified` section to the Review
Guidance comment that `@`-mentions each matched person/team, telling them the rule
label and which changed files matched. `lib/notified.ts` parses it and does the
matching deterministically (review.md Step 7 runs the CLI and pastes its rendered
block); no file means no section, so it costs nothing where it is absent.

**Delivery is approval-time, not on-touch.** The pings ride in the (approval-only)
Guidance for reviewers comment, so — unlike Gerald, which notifies on every push — a
watcher is pinged when the reviewer approves, and a PR held at REQUEST_CHANGES or
merged before the AI verdict lands never pings them. This is intentional: the
notification piggybacks on the one comment the reviewer already posts, and firing
only on a clean approval keeps the ping meaningful and idempotent (below). Where a
repo still runs Gerald itself, Gerald's own on-touch NOTIFIED pings continue
independently — expect both until Gerald's NOTIFIED is retired for that repo.

Only the `[ON PULL REQUEST]` section applies (everything above the
`----Everything above this line…----` marker and the `[ON PUSH WITHOUT PULL
REQUEST]` section are ignored). Each rule is `[label:] <pattern>  @user @Org/team`,
where `<pattern>` is either a **path glob** (matched against changed file paths) or
a **quoted diff regex** `"/body/flags"` (matched against each file's unified diff,
so a rule can fire on *added content*). The base-branch copy is read (like
`REVIEWERS`), so a PR cannot add notify rules that take effect before it merges.
The glob dialect is a **practical subset** of Gerald's micromatch, not a faithful
reimplementation (`**`, `*`, `?`, `{a,b,c}`, `[…]`, `(a|b)`, `?(…) *(…) +(…) @(…)`),
anchored at the repo root. Two known divergences: wildcards here match dotfiles
(micromatch defaults `dot:false`) and `!(…)` negation is unsupported — a rule that
relies on those may match a slightly different set than Gerald. An unsupported glob
construct matches nothing rather than crashing the review; a malformed rule (bad
regex body, unterminated quote) is dropped and adds a `Note:` to the PR review.

Because the notified `@mentions` ride in the Guidance for reviewers comment (an
`add-comment` safe output), gh-aw's mention sanitizer governs whether they
actually ping: repository collaborators are allow-listed by default
(`mentions.allow-team-members`), and to let arbitrary teams/users through, widen
it with a `mentions:` block (`allowed`, `allowed-teams`; `allowed-teams` needs a
token with `read:org`). Without that, a non-collaborator or team mention is
rendered but neutralised (shown, not pinged).

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

**The `blocking-only` modifier** (`re-review scoped blocking-only`) composes
with any mode: the depth's roster and staging are unchanged, but a repeat
review posts only blocking findings inline; validated non-blocking findings
collapse to one line each in a `<details>` block in the review body, and the
depth note names the modifier. It applies exactly when the run executes at a
reduced depth, so the first full review of a ready PR, a divergence-tripwire
re-arm, and every guard that resolves to `full` still post everything (which
is also why `full blocking-only` warns: it can never apply). The verdict is
computed from every validated claim either way, so the modifier can never
flip an outcome; it only moves non-blocking feedback off the inline surface.
Use it when re-review chatter is the complaint but whole-change coverage
(`scoped`) is still wanted: `flip-gated` silences the noise by not running
the whole-change reviewers at all, while `scoped blocking-only` keeps their
blocking recall and their body-collapsed observations.

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

### Refusal fallbacks

A provider can block a request outright under its usage policy. Anthropic
reports that as `stop_reason: "refusal"`, and the agent returns **no final
text** — which is why it reads as a missing result rather than an error, the
silent coverage hole this README already warns about for the specialist lenses.

The warning was aimed at the wrong roles. The lenses were kept on Opus because
Fable's cyber classifiers can refuse benign security analysis, while
`correctness-reviewer` — the default roster's load-bearing recall agent — was
moved *onto* Fable 5 for its recall gain. Eval run 30656579898 caught it
refusing `incident-auth-bypass` and `adversarial-injection-approve` outright,
at 5,207 tokens (so not a context limit). The roster has since moved to Opus 5,
which carries its own elevated cyber safeguards, so the hazard moved with it
rather than being resolved by the pin change.

Refusals are **intermittent**: probe run 30658862532 saw the same Fable pin
clear both cases that run 30656579898 blocked. The ordinary retry still cannot
recover one, because it appends a corrective note about output shape and a
blocked request never produced an output. `lib/refusal-fallback.ts` maps a
refusing pin to a model with a different refusal profile:

| Pinned model | Falls back to | Basis |
| --- | --- | --- |
| `claude-fable-5` | `claude-opus-4-8` | measured (run 30656579898) |
| `claude-opus-5` | `claude-opus-4-8` | pre-emptive; Opus 5 ships elevated cyber safeguards and can also return `stop_reason: "refusal"` |

Rules: **one hop**, never back to a model that already refused, and **no
fallback for an unlisted pin** — an unmapped model's refusal stands and is
reported, so a new model family's refusal profile stays visible instead of
being papered over. The swap is recorded per agent (`fellBackTo`) and lands in
the report and the run artifact: converting a silent skip into a silent model
swap would trade one invisible failure for another.

Because refusals are intermittent, the **rate** is what matters, and the weekly
live counters report it: `lib/counters.ts` reads `fellBackTo` from each run's
`out/dispatch-result.json`, and the job summary gains a "Refusal fallbacks"
section per agent and model, including an explicit zero. A rate concentrated on
one reviewer is a pin to change; a rate spread across many is a corpus or
provider-policy shift.

### Models and effort per role

Each sub-agent pins its model in its own definition inside `review.md` (with a
launch-default `effort:` annotation; the gh-aw Claude engine exposes no per-agent
effort field yet). The orchestrator prompt deliberately says nothing about
sub-agent models — this table is the human-facing summary:

| Role | Model | Effort | Why |
| --- | --- | --- | --- |
| orchestrator | `claude-opus-5` | high | Owns every GitHub/safe-output decision |
| `pattern-triage` | `claude-sonnet-4-6` | medium | Cheap first-pass triage |
| `thread-reconciler` | `claude-opus-5` | medium | Reconciliation |
| `correctness-reviewer` | `claude-opus-5` | high | Whole-change reviewer; bug-finding recall is the load-bearing metric |
| `skill-auditor` | `claude-opus-5` | high | Whole-change reviewer |
| `holistic` | `claude-opus-5` | high | Opt-in whole-change reviewer (`enable` in `ROUTING`) |
| `completeness` | `claude-opus-5` | high | Opt-in whole-change reviewer (`enable` in `ROUTING`) |
| `test-adequacy` | `claude-opus-5` | high | Opt-in whole-change reviewer (`enable` in `ROUTING`) |
| `conventions` | `claude-opus-5` | medium | Opt-in advisory targeted check (`enable` in `ROUTING`) |
| `documentation` | `claude-opus-5` | medium | Opt-in advisory targeted check (`enable` in `ROUTING`) |
| `first-principles` | `claude-opus-5` | high | Opt-in advisory-only; reviews the change's justification |
| `claim-validator` | `claude-opus-5` | xhigh | Adversarial claim validation; stays Opus (the Fable arm did not improve precision) |
| specialist lenses | `claude-opus-5` | high | Opt-in via `lens=` in `ROUTING`; the security & auth lens is xhigh |

Only the orchestrator and the default roster (`pattern-triage`,
`correctness-reviewer`, `skill-auditor`, `thread-reconciler`, `claim-validator`)
run by default; every other row is opt-in via `ROUTING` and earns its line through
the eval suite. Exactly two roles run Fable 5: `first-principles` (from day
one, for perspective diversity) and `correctness-reviewer` (the 2026-07-20
A/B's recall gain concentrated in correctness-adjacent rows, and bug-finding
recall is the load-bearing metric). Everything else stays on Opus 4.8
deliberately: the A/B measured the full-Fable bundle, so the other roles'
contribution is unattributed while their cost is not (both known consumers
enable the whole-change reviewers in `ROUTING`, so they are not free in
practice); the Fable `claim-validator` measurably did not improve the
precision gate (noise 43% -> 49%); and the specialist lenses stay Opus
because Fable's cyber safety classifiers can refuse benign security-focused
analysis, and a refused security lens would be a silent coverage hole. Any
further per-role promotion (or Sonnet step-down) earns its line through its
own eval-suite arm.

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

Optional:

- `REVIEW_BOT_LOGIN` — the account this workflow posts reviews as, default
  `github-actions[bot]`. Set it only in a repo that posts under its own GitHub
  App, in the installed `review.md`'s workflow-level `env:` block (the one
  carrying `REVIEW_MAX_AI_CREDITS`), which reaches both the staging step and
  the dispatcher. It is read by one predicate (`lib/threads.ts`'s
  `isReviewBotAuthor`), which both the thread staging and open-thread
  suppression go through, so the two layers cannot disagree about the identity.
  Getting it wrong is not cosmetic: threads the bot opened would be filed as
  human ones, which puts their lines in `skipLines` and DROPS fresh findings
  there. Either spelling works (`name` or `name[bot]`); the comparison strips
  the suffix.

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
behavior holds within a major. For attribution and rollback, every submitted review
body and the risks/patterns guidance comment (Step 7) end with a footer collapsed
inside a `<details>` block (summary chip `review details`), rendered in code by
`lib/version-footer.ts` from the pinned checkout's `package.json` and the staged
run files (never composed by the model):

```
<details><summary><sub>review details</sub></summary>
<sub>review-v<major>.<minor>.<patch> | schema <n> | depth <depth> | re-review <mode> [blocking-only] | enable <reviewer,...></sub>
</details>
```

`schema` is the finding-schema version (`FINDING_SCHEMA_VERSION` in
`lib/finding-schema.ts`) the run was on; `depth` is the EXECUTED re-review depth;
the `re-review` and `enable` segments echo the repo's ROUTING configuration, so a
posted review attributes both the release and the config it ran under. A segment
the staging cannot state is omitted rather than guessed. A bad reviewer release
rolls back by re-pinning the previous tag; the footer on each posted review makes
attribution immediate.

The footer posts (collapsed, expandable) by necessity, not preference:
attribution originally rode a hidden HTML marker
(`<!-- pr-reviewer:version ... -->`), but gh-aw's safe-output
ingest sanitizer deletes ALL XML/HTML comments (`removeXmlComments` in
`sanitize_content_core.cjs`, the same strip documented for the fingerprint stamp
in `lib/rereview-mode.ts`), so the marker never reached a posted comment; `sub`,
`details`, and `summary` are on the sanitizer's allowed-tag list and survive
ingest. There is no separate config-hash or drift-stamp mechanism; the release
tag plus the footer's config segments are the version surface.

Every inline review comment (and each pr-level finding folded into the review
body) additionally ends with a per-comment attribution footer in the same
collapsed block, naming the reviewer that produced the finding and, when
cross-source dedup merged duplicates into it, each other reviewer that flagged
the same defect (`lib/attribution.ts`; the merge record is the structured
`also_flagged_by` field on the claim, so a validator discussion rewrite cannot
drop it). Collapsed one-liners (the low-confidence `<details>` section and a
hold comment's claim list) carry the short form, a trailing
`<sub>(<source>)</sub>` tag. Text-similarity comparisons against
previously-posted bodies (open-thread suppression, the adjudicated corpus)
strip these footers first, so the shared boilerplate cannot inflate similarity
between unrelated findings.
