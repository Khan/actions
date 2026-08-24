---
description: >
  Addresses the PR reviewer's own feedback on demand, one run per arming. Arm it
  with an `/autofix [blocking|nits|docs]` comment, or with an `autofix: blocking`
  / `autofix: nits` / `autofix: docs` label; the two are peers. The run fixes the
  reviewer's open threads in that scope, pushes one commit, replies in each
  thread, and clears the label if one armed it.

on:
  # Two arming surfaces, and they are PEERS — neither is a shorthand for the
  # other. A label is state you click; a command is an event you type and can
  # pass arguments to. Both resolve through one shared resolver (`scope.ts`), so
  # a value can never mean one thing as a label and another as a command.
  pull_request:
    types: [labeled]
  issue_comment:
    types: [created]
  # Acknowledge an `/autofix` comment immediately, the same way the reviewer
  # acknowledges `/review`. Without this the author has no signal between typing
  # the command and the summary comment several minutes later.
  reaction: eyes
  # No status comment: the run posts exactly one summary comment of its own
  # (Step 7), and a gh-aw "started/completed" comment on top of that would
  # double the noise on a PR that is already carrying a full review.
  status-comment: false
  # Autofix writes code to someone's branch, so the actor who armed it must be
  # able to write to the repo themselves. This is deliberately NOT the
  # reviewer's `roles: all` override: the reviewer only reads and comments, and
  # its gate is relaxed so a collaborator's push still triggers a review. On the
  # comment path this role check is the PRIMARY gate — see below.
  roles: [admin, maintainer, write]

# One gate per surface. Double-quoted YAML so the `\n`/`\r`/`\t` escapes below
# become real characters in the expression rather than literal backslashes.
#
# LABEL PATH. Two cheap gates before the agent starts:
#   1. Same-repo branches only. A fork PR gets no secrets, so the push would
#      fail anyway.
#   2. The label that fired this event is an autofix label. Every other label
#      addition on the PR is a run we never pay for.
#
# `skip-ai-review` is deliberately NOT a gate here, and that is a decision, not
# an omission. The label stops the reviewer from running again; it does not
# dismiss a review already posted (the reviewer's own `if:` says so: "adding it
# prevents the *next* run"). The reviewer even suggests the label from inside a
# review body it just posted, so "labelled" and "has current findings" is a
# state the workflow steers users into, not a corner case. Reading the label as
# "no AI may act on this PR" would silently swallow an explicit `autofix:` label
# from someone with write access; that opt-in IS the authorisation, while
# autofix only ever runs when a human arms it. Revisit when autofix runs
# automatically: that is when a push nobody asked for becomes possible, and when
# autofix should get its own opt-out rather than borrowing the reviewer's.
#
# COMMAND PATH — deliberately weaker, and worth understanding before you touch
# it. `issue_comment` carries no `github.event.pull_request`, so the fork guard
# CANNOT be evaluated here at all. It is instead enforced in `plan.ts`, which
# refuses a fork from the staged `context.json`. That is real code, not an
# aspiration: an earlier version of this comment claimed the check "moves into
# the plan" while the plan did not implement it, and Khan/actions#298's review
# caught it. The cost is that an `/autofix` on a fork PR the label path would
# have rejected for free still burns a job before refusing.
#
# The gate that actually matters is unaffected: gh-aw's `roles` check above
# still runs, so a comment from someone without write access never reaches the
# agent.
#
# ONE STRUCTURAL LIMIT. `issue_comment` is a repository-level event, so GitHub
# reads the workflow file from the DEFAULT BRANCH, never from the PR's head.
# `/autofix` therefore cannot fire for an install that only exists on a branch,
# which is why every run of the Khan/webapp#41140 trial was `pull_request` and a
# reviewer's `/autofix` comment there did nothing. The command surface can only
# be exercised once this workflow is on the consuming repo's default branch.
#
# The command match is written out longhand rather than using gh-aw's
# `slash_command` trigger. gh-aw's compiled gate only matches the command
# followed by a space, a bare `\n`, or end-of-body, so a comment saved with a
# trailing CRLF — which the GitHub web UI produces when you press Enter after
# the command — never activates the workflow. That silently killed `/review` in
# Khan/webapp#40943. `scope.ts`'s parser tolerates the same shapes; keep the two
# in step.
if: "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.label.name, 'autofix: ')) || (github.event_name == 'issue_comment' && github.event.issue.pull_request != null && (github.event.comment.body == '/autofix' || startsWith(github.event.comment.body, '/autofix ') || startsWith(github.event.comment.body, '/autofix\n') || startsWith(github.event.comment.body, '/autofix\r') || startsWith(github.event.comment.body, '/autofix\t')))"

permissions:
  contents: read
  pull-requests: read

tools:
  github:
    lockdown: false
    min-integrity: none
    toolsets: [pull_requests, repos]
  edit:
  # NOTE THE `:*` SUFFIX. gh-aw's schema documents `"npx *"` (space-star) as
  # "command with any args", but it compiles that form to the Claude Code
  # permission `Bash(npx)`, which matches ONLY a bare `npx` with no arguments —
  # so `npx -y tsx …` is denied and the plan CLI never runs. `"npx:*"` compiles
  # to `Bash(npx:*)`, which is the form gh-aw's own defaults use
  # (`Bash(git add:*)`). Observed on gh-aw v0.83.4; verify the compiled
  # `--allowed-tools` list still carries the `:*` suffix after any gh-aw bump.
  #
  # Declaring this list at all NARROWS the agent: a workflow with no `bash:` key
  # (the reviewer, for one) compiles to unrestricted `Bash`. That is the
  # trade being made here deliberately, which is why the list must be right.
  bash:
    - "git:*"
    - "npx:*"
    - "node:*"
    - "cat:*"
    - "ls:*"
    - "date:*"
    - "mkdir:*"

safe-outputs:
  allowed-domains:
    - github.com
    - khanacademy.org
    - khanacademy.dev
    - khanacademy.atlassian.net

  # The commit. `KHAN_ACTIONS_BOT_TOKEN` rather than the default GITHUB_TOKEN is
  # load-bearing, not incidental: GitHub does not create workflow runs for
  # events triggered by GITHUB_TOKEN, so a push made with it would emit no
  # `synchronize` and the reviewer would never re-review the fix.
  #
  # That re-review is the INTENDED verification for an autofix commit, and it is
  # best-effort rather than guaranteed: the chain from this push to a posted
  # review has several links and any of them can fail. Khan/webapp#41194 lost
  # one to a gh-aw setup failure that was invisible on the PR. So the reason for
  # the token is the stronger one: GITHUB_TOKEN guarantees zero re-review, the
  # bot token buys a best-effort one. Step 7 states the pending status on the PR
  # so the human re-arm can act as the backstop, and the README's "Verification
  # is best-effort" carries the measured numbers.
  #
  # `if-no-changes: ignore` because "the agent decided nothing needed changing"
  # is a legitimate outcome that Step 7 already reports in prose; failing the
  # job on it would turn a correct no-op into a red X on the PR.
  push-to-pull-request-branch:
    target: "triggering"
    max: 1
    if-no-changes: "ignore"
    github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}

  # One reply per fixed thread (Step 6). Replying rather than resolving is
  # deliberate: `thread-reconciler` already weighs author replies when the next
  # review decides whether a thread is settled, and the re-review accountability
  # section links threads that are still open. Resolving here would bypass both
  # and destroy the record of whether the fix actually worked.
  reply-to-pull-request-review-comment:
    max: 20
    target: "triggering"
    footer: false

  # The run summary (Step 7): what was fixed, what was skipped and why. Exactly
  # one per run, and older ones collapse, so a PR armed several times keeps only
  # the latest visible.
  add-comment:
    target: "triggering"
    max: 1
    discussions: false
    hide-older-comments: true
    footer: false

  # The label is a button, not a mode: it is removed on EVERY outcome, including
  # a refusal. A label left on after the run reads as "still queued" when
  # nothing is, and re-arming is one click.
  remove-labels:
    allowed:
      - "autofix: blocking"
      - "autofix: nits"
      - "autofix: docs"
      - "autofix: loop"
      - "autofix: human"
      - "autofix: author"

  # The plan artifact. `plan.json` is the only record of what the run was asked
  # to do versus what it did, which is what the trial reads to score fix quality
  # against the next review's findings.
  upload-artifact:
    max-uploads: 1
    retention-days: 30
    allowed-paths:
      - "out/**"
      - "/tmp/gh-aw/autofix/out/**"

network:
  allowed:
    - defaults
    - github

# HELD AT OPUS 4.8. This should be `claude-opus-5`, matching the roster
# Khan/actions#294 moves the reviewer to. Three live runs on Khan/webapp#41140
# failed to get there, and the cause is not yet established, so the model stays
# where it demonstrably works rather than where we want it.
#
# WHAT WAS OBSERVED. The api-proxy's AI-credits guard rejects an un-priced model
# with a 400 before the request reaches the model, and `claude-opus-5` is in no
# firewall release's curated pricing table.
#   - 30416237794: no fallback configured. 400, as expected.
#   - 30421726630: `models.default-ai-credits-pricing` configured, firewall
#     v0.27.42 (the compiler default). Staged awf-config.json confirmed to carry
#     `apiProxy.defaultAiCreditsPricing: {input: 5, output: 25}`. Still 400.
#   - 30422315631: same, firewall pinned to v0.27.27. Config confirmed present,
#     image confirmed pulled. Still 400.
#
# WHAT IS ESTABLISHED. The mechanism exists and is documented: awf-config-spec
# 10.7.3 says a configured fallback makes an unresolvable model "proceed
# normally", and `config-mapper.ts` maps the field to
# `AWF_DEFAULT_AI_CREDITS_PRICING` in BOTH v0.27.27 and v0.27.42. So the pin to
# v0.27.27 above was pointless and has been removed; version is not the
# variable. Note also that #294's own `review.lock.yml` contains zero
# occurrences of `claude-opus-5` (only the shared review.md was edited, never
# recompiled), so its "verified" claim is a reading of the spec rather than a
# run, which is consistent with these three failures.
#
# WHAT IS UNTESTED, and the next thing to try. Spec 10.7.1 applies the fallback
# only when the model "cannot be resolved from the curated table or the bundled
# models.dev catalog". These runs supplied BOTH the fallback AND a
# `models.providers.anthropic.models.claude-opus-5.cost` entry (copied from
# #294). If that providers entry makes the model *resolve* to something carrying
# no AI-credits pricing, it would short-circuit the fallback and reject, which
# is exactly the symptom. The untried combination is: keep
# `default-ai-credits-pricing`, DROP the `models.providers` block, leave the
# firewall at the default. One run settles it.
#
# Until then this is a one-line change plus its `models:` block. Do not restore
# them without a run that reaches the model.
engine:
  id: claude
model: claude-opus-4-8

timeout-minutes: 20

# Autofix reads the reviewer's staged artifacts and the reviewer's own label
# taxonomy, so it checks out Khan/actions for both libs at once: one tag, one
# tree, `workflows/autofix/lib` and `workflows/review/lib` guaranteed to be the
# versions that were released together. The ref is rewritten by
# utils/sync-workflow-versions.ts during the release, and
# workflows/autofix/version-sync.test.ts fails CI if it ever drifts from the
# `autofix` package version.
pre-agent-steps:
  - name: Check out shared workflow lib (Khan/actions)
    uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
    with:
      repository: Khan/actions
      ref: autofix-v0.3.0
      path: gh-aw-autofix-lib
      persist-credentials: false

  # Staging is deterministic and runs BEFORE the agent, so it costs zero
  # assistant turns. This follows the reviewer's orchestrator slice 1 (#280):
  # anything that never needed model output belongs in a pre-agent step.
  #
  # The first live run measured why. Staging by prose cost roughly fifteen of
  # that run's 131 turns (seven creating a directory, five hand-assembling JSON
  # through repeated `node -e` scripts, three reading this workflow's own lib
  # source), and turns are what autofix costs: each re-reads the whole context,
  # so 61% of the bill was cache reads. Caching was already near-optimal at a
  # 40:1 read-to-write ratio; there were simply too many turns.
  #
  # A staging failure fails this step before any AI credits are spent.
  #
  # The comment body is passed through `env:` rather than interpolated into
  # `run:`. It is attacker-controlled text, and `env:` keeps it out of the
  # shell's parse.
  - name: Stage the plan's inputs (deterministic)
    working-directory: gh-aw-autofix-lib
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GITHUB_REPOSITORY: ${{ github.repository }}
      AUTOFIX_PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number }}
      AUTOFIX_COMMAND_BODY: ${{ github.event_name == 'issue_comment' && github.event.comment.body || '' }}
    run: npx -y tsx workflows/autofix/lib/stage.ts

# A fix run is a fraction of a review run: no reviewer roster, no lenses, one
# agent editing a bounded set of files. 1000 credits ($10) is the gh-aw default
# and is generous for that shape; the daily ceiling stays on, because unlike
# reviews (which must never be skipped) a deferred autofix costs nothing but a
# re-click.
max-ai-credits: 1000

# ─────────────────────────────────────────────────────────────────────────────
# WORKAROUND for a gh-aw bug. Remove once it is fixed upstream.
#
# THE BUG. The safe-outputs job checks out with `actions/checkout` and no
# `fetch-depth`, so it gets a depth-1 shallow clone of `refs/pull/N/merge` — the
# merge commit alone, without its parents. `push_to_pull_request_branch.cjs:935`
# then fetches the PR branch with NO `--depth`:
#
#     git fetch origin <branch>:refs/remotes/origin/<branch>
#
# The branch tip is a parent of the merge commit and therefore absent, and its
# history never reaches the existing shallow boundary, so git walks the branch
# all the way back: a full-history fetch. On a small repo this is invisible
# (the branch's parent usually IS the boundary). On Khan/webapp it is fatal.
#
# MEASURED, reproducing the exact command against Khan/webapp from a faithful
# depth-1 checkout of refs/pull/41130/merge:
#   - as gh-aw runs it:      >14 min, 5.6 GB and still climbing, never finished
#     (this is what cancelled the safe_outputs job on Khan/webapp#41130)
#   - with the filter below:  91 s, ~557 MB, exit 0
#
# THE FIX WE CANNOT APPLY. `--depth=1` on that fetch. git has no `fetch.depth`
# config, so it cannot be injected; there is no gh-aw option for it (none of the
# 20 `push-to-pull-request-branch` keys touch fetch or checkout); `checkout:` in
# frontmatter configures the AGENT job only; and `pre-agent-steps`/`post-steps`
# cannot add steps to the safe-outputs job. gh-aw's own
# `checkout_pr_branch.cjs:229` does pass `--depth`, and this same file passes
# `--depth=1` at :1001 and `--filter=blob:none` at :1065, so the omission at
# :935 is an oversight rather than a design choice.
#
# WHAT THIS DOES. git honours `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` /
# `GIT_CONFIG_VALUE_<n>` as if passed via `-c`. The handler runs the fetch with
# `env: {...process.env, ...gitAuthEnv}` (`:934`) and `gitAuthEnv` is empty
# (`:343`), so these reach it. We cannot bound the DEPTH, but we can make the
# fetch a partial clone that skips blobs, which is where the bulk sits.
#
# SAFE AGAINST gh-aw's OWN USE. `ensureSafeDirectoryTrust`
# (`git_helpers.cjs:64-76`) reads the existing `GIT_CONFIG_COUNT` and APPENDS
# its `safe.directory` entry at the next free index, so indices 0 and 1 here
# compose with it rather than clobbering it.
#
# KNOWN TRADE-OFFS.
#   - Workflow-level `env:` reaches every job, so the agent job's checkout also
#     becomes a partial clone and file reads lazily fetch blobs. For an agent
#     that reads a handful of files that is fine and probably faster; gh-aw
#     itself notes the lazy-fetch cost at `push_to_pull_request_branch.cjs:1062`.
#     gh-aw exposes no per-job env, so this cannot be scoped more tightly.
#   - The fetch still pulls all tags. `remote.origin.tagOpt=--no-tags` would
#     trim more, but it is NOT set here because it has not been measured; add it
#     only with a number behind it.
# ─────────────────────────────────────────────────────────────────────────────
env:
  GIT_CONFIG_COUNT: "2"
  GIT_CONFIG_KEY_0: remote.origin.promisor
  GIT_CONFIG_VALUE_0: "true"
  GIT_CONFIG_KEY_1: remote.origin.partialclonefilter
  GIT_CONFIG_VALUE_1: "blob:none"

source: Khan/actions/workflows/autofix/autofix.md@autofix-v0.3.0
---

# PR Autofixer

You address feedback the PR reviewer left on this pull request. You are not a
reviewer: you do not judge whether a finding is worth fixing, and you do not
look for problems nobody raised. Your scope is exactly the threads the plan
hands you in Step 2.

## Current Context

- **Repository**: ${{ github.repository }}
- **Pull Request**: #${{ github.event.pull_request.number || github.event.issue.number }}

This workflow fires on two events, so the PR number is read from whichever one
carries it. What armed the run is not interpolated here on purpose: gh-aw's
expression allowlist excludes `github.event.label.name` from prompt bodies, and
the plan resolves the arming itself in Step 2, which is the authoritative answer
either way.

## Cost: turns are the expensive thing

This workflow's cost is dominated by the number of assistant turns, not by how
much data any one of them moves. Every turn re-reads the whole accumulated
context. The first live run took 131 turns and 460 AI credits to land a
six-line fix, with only ~93 KB of tool output in the entire run: the payload was
trivial and the turn count was not.

So, concretely:

- **Batch shell work.** One command with `&&` beats three round trips. Create
  every directory you need in a single `mkdir -p` and do not verify it
  afterwards; `mkdir -p` does not fail on an existing directory, and `ls` to
  confirm is a wasted turn.
- **Do not read the lib source.** `gh-aw-autofix-lib` holds released,
  tested code. Reading `plan.ts` or `staleness.ts` to work out what the plan
  will say costs turns and context, and tempts you to re-derive a decision the
  plan has already made. Run the CLI and read its output.
- **Do not explore the `safeoutputs` CLI.** Its invocations are written out at
  each step below. Calling `--help` first is a wasted turn.
- **Do not re-verify your own writes.** If a command exits zero, it worked.
- **Prefer a heredoc to a chain of `node -e` scripts.** If you find yourself
  writing the same inline script twice with small edits, write it to a file once
  and run it.

## Step 1: Read the staged inputs

**There is nothing to stage.** A deterministic pre-agent step
(`workflows/autofix/lib/stage.ts`) has already fetched everything and written it
to `/tmp/gh-aw/autofix/` before you started. Do not fetch any of it again, and
do not rewrite any of these files:

| file | what it holds |
| --- | --- |
| `labels.json` | the PR's current label names |
| `threads.json` | the reviewer's unresolved threads, each with its full reply chain, verbatim |
| `prior-reviews.json` | every review by the reviewer bot, whatever its state |
| `pr.diff` | the PR's unified diff |
| `commits.json` | commit messages on the head, the autofix cycle ledger |
| `head-sha.txt` | the head SHA when the run started; Step 5 compares against it |
| `command.txt` | the `/autofix` comment body, **only** on a command-armed run |

You do not need to read most of these. Step 2's CLI parses them; the only ones
you will open yourself are `plan.json` (which Step 2 produces) and
`head-sha.txt` (Step 5). Reading `pr.diff` or `threads.json` in full is a waste
of context: the plan already extracted what matters into `plan.items`.

If a file is missing, the staging step failed and the run should not have
reached you. Say so in Step 7 and stop; do not reconstruct it by hand.

## Step 2: Build the plan (deterministic code)

Run the plan CLI once, from the shared lib checkout:

```
cd gh-aw-autofix-lib && npx -y tsx workflows/autofix/lib/plan.ts
```

It writes `/tmp/gh-aw/autofix/plan.json` and prints a summary. Copy
`plan.json` to `/tmp/gh-aw/autofix/out/plan.json` now, so the run artifact
records what was planned even if a later step fails.

**The plan is final.** It decided the scope, which threads are in it, which were
skipped and why, and what the commit trailer says. Do not widen it, narrow it,
re-classify a skipped thread, or act on a finding it did not hand you. If you
disagree with the plan, say so in the Step 7 comment; do not act on the
disagreement.

**If the CLI does not run, the run is over.** If `npx` is unavailable, the
command errors, or the tool call is denied, do **not** reconstruct the plan by
reading the library source and reasoning about it. A hand-simulated plan is
exactly the thing this workflow's determinism boundary exists to prevent, and
it produces a confident-looking result nobody can audit. Instead: change
nothing, post a Step 7 comment saying the plan CLI could not be executed and
quoting the error, remove the labels (Step 8), and stop.

The plan resolves the arming itself, from whichever surface triggered the run:
`command.txt` when it exists, the PR's labels otherwise. **The trigger decides,
and the two never union** — a stale `autofix: nits` label must not silently
widen someone's `/autofix blocking`. `plan.surface` records which one won.

`plan.json` has a `status`:

- **`refused`** — the run cannot proceed safely (an autofix label on an axis
  this version does not implement, no reviewer feedback to act on, or a review
  that cannot be matched to the current diff). Skip to Step 7, post the comment
  with the plan's `reason` verbatim, remove the labels, and stop. Change
  nothing.
- **`no-op`** — the labels were understood and there is nothing to fix. Skip to
  Step 7 the same way. This is a success, not a failure; say so plainly.
- **`armed`** — continue to Step 3.

## Step 3: Understand each finding before changing anything

For every item in `plan.items`, read the file at `path` around `line` from the
Actions workspace (the PR head is checked out; read from disk, not through the
API). The item's `body` is the reviewer's statement of the problem, verbatim.
For a body-sourced item (id starting `review-body:`, parsed off the latest
review body's collapsed observations) the `body` is a one-line subject rather
than a full finding, so the read-the-code step carries more of the weight:
if the line does not make the problem evident, leave the item alone and say
so in Step 7.

Work out what the reviewer meant. If a finding is ambiguous, or you cannot
determine what a correct fix would be, **leave it alone** and record it as
not-fixed for Step 7. A wrong fix on a blocking finding is worse than no fix:
the author now has to review a change they did not write, on a problem they had
not yet looked at.

## Step 4: Make the fixes

Edit the files directly in the workspace. Rules, all hard:

- **Fix the finding, nothing else.** No drive-by refactors, no reformatting, no
  fixing things you noticed on the way. Every hunk you write must be traceable
  to an item in `plan.items`.
- **Never weaken a test to satisfy a finding.** If the honest fix makes a test
  fail, fix the source. If you believe the test itself encodes the bug, leave
  the finding unfixed and explain why in Step 7. Deleting an assertion, loosening
  a matcher, adding a skip, or widening an expected range to make something pass
  is never an acceptable outcome of this workflow.
- **A documentation item changes text, never code.** An item labelled
  `suggestion (non-blocking, documentation)` is a finding about a comment or a
  prose doc, and the whole reason its scope exists is that its edits cannot
  alter behaviour. Such a finding often carries no suggestion block precisely
  because the fix is a deletion, which cannot be expressed as one. But if the
  honest fix would touch an executable line — renaming the symbol the comment
  misdescribes, changing the constant the comment contradicts — that is a code
  change wearing a documentation label: leave the item unfixed and say why in
  Step 7. Fix the sentence, or fix nothing.
- **On a documentation item, rewrite before you delete.** Deleting a comment the
  finding calls redundant is a legitimate fix and not an overreach, but it is
  the *second* choice. If the code the comment sits on has a non-obvious reason
  to be the way it is — a magic value, a timeout, a retry count, an ordering
  requirement, a workaround — and that reason is recoverable from the diff, the
  surrounding code, or the reviewer's own thread, replace the restatement with
  the reason. Deleting is right when the comment is pure restatement of
  something that needs no explanation. What makes the difference is whether the
  reason is *recoverable*, not whether it would be nice to have: **never invent
  a rationale.** A plausible-sounding reason you cannot source is worse than no
  comment, because the next reader will trust it and the reviewer cannot tell
  the difference.
- **A readability item is fixed with the reviewer's own words.** A documentation
  finding may flag prose readability (a metaphor that hides the mechanism, a
  paragraph restating an earlier one, shorthand the document never defines)
  rather than comment content, and it carries the plain rewrite, quoted in its
  body or as a suggestion block. Apply that rewrite verbatim: it survived claim
  validation, which checked that it preserves the original sentence's meaning,
  and a paraphrase you improvise did not. If the file has drifted and the quoted
  rewrite no longer fits the text, leave the item unfixed and say so in Step 7
  rather than composing your own.
- **On a says-the-same-thing-twice item, delete; never mint a third phrasing.**
  The rewrite-before-delete bias above is calibrated for a restated comment
  sitting on unexplained code. A duplicated paragraph is the opposite case: the
  content already exists in the copy that stays, so the fix is deleting the copy
  the finding names, and rewording the duplicate into different words is the
  failure mode the finding exists to stop, not a fix for it.
- **Say when a deletion left a hole.** If you delete a comment off a constant,
  magic value, or workaround without being able to state why the value is what
  it is, the thread is fixed and the code is still unexplained. Report both in
  Step 7, naming the symbol, so the author knows there is a sentence only they
  can write (`staleAfter`'s restating comment is gone; nothing records why the
  window is that long). Reporting it as plainly fixed hides the one thing a
  human still needs to do.
- **Do not touch files no item points at.** Two exceptions. First, a change
  mechanically forced by a fix (a caller that must be updated for a changed
  signature). Second, the instances a batched documentation item quotes: the
  documentation reviewer caps readability at one thread per review and
  enumerates up to three further instances, verbatim, in that thread's body, so
  each **quoted** instance is part of the finding wherever it lives; fix those
  too. An instance the body merely alludes to without quoting is not part of
  the finding. The verbatim-rewrite rule above still governs each quoted
  instance: the reviewer is only required to quote it, not to rewrite it, so
  fix a quoted instance when its fix needs no words of yours (a duplicated
  paragraph: delete the quoted copy) or when the thread body carries a rewrite
  for that instance; a quoted metaphor or coinage with no rewrite of its own is
  left unfixed and reported in Step 7, exactly like a drifted quote. Note any
  file either exception led you into in Step 7.
- **Do not amend, rebase, or force-push.** You produce working-tree changes;
  the push is a safe output.
- If a fix would require a design decision the reviewer did not make for you,
  leave it unfixed and say so.

**Verify what you can, and be honest about what you cannot.** Nothing between
your edit and the push checks that the code still compiles or that its tests
still pass; the re-review and the repo's CI both run only after the commit is on
the author's branch. If this repository has a cheap check you can run from the
allowlisted commands, run it. If you cannot verify (no allowlisted runner, or
the check needs a toolchain that is not installed), that is expected, not a
failure; say so in the Step 7 summary rather than implying the fix was
validated. An unverified fix presented as a verified one is the thing to
avoid.

## Step 5: Push one commit

Compare the live head SHA against `/tmp/gh-aw/autofix/head-sha.txt`, which
staging captured from the job's checkout (`git rev-parse HEAD`) rather than from
the API, because the checkout is what your edits are actually against.
**If it changed, do not push.** The author pushed while you were working, and
your edits are against a base that no longer exists. Skip to Step 7, report that
the run was abandoned for that reason, and remove the labels; the author can
re-label once their push settles.

Otherwise commit your working-tree changes locally, then emit a single
`push-to-pull-request-branch`. The engine builds its patch and bundle from that
commit, so both steps are needed:

```
git -C "$GITHUB_WORKSPACE" add -- <the files you changed>
git -C "$GITHUB_WORKSPACE" commit -F /tmp/gh-aw/autofix/commitmsg.txt
printf '{"message":%s}' "$(...)" | safeoutputs push_to_pull_request_branch .
```

Write the message to `commitmsg.txt` first rather than passing it inline; it is
multi-paragraph and shell-quoting it is a reliable way to lose the trailer.

**The commit message must stand on its own.** Someone reading `git log` a year
from now, with no PR open and no reviewer thread to click through to, should be
able to tell what changed and why. Write it as you would any commit; the fact
that a bot wrote it is not the interesting part.

```
autofix: <what actually changed, in the imperative>

<why it changed: the problem the reviewer identified, stated as a fact about
the code rather than a reference to the review. Wrapped at 72 columns.>

<one line per fixed finding: `<path>:<line>: <what changed there>`, only when
there is more than one finding; with a single finding the paragraph above has
already said it.>

<the plan's `trailer` field, verbatim>
```

Rules for the subject line, which is the part that ages worst:

- **Never** use a generic subject. `autofix: address reviewer feedback` is
  banned: it is identical on every run, so a branch with several autofix
  commits becomes a wall of indistinguishable `git log --oneline` entries.
- Name the change, not the process. `autofix: clamp Page start into range`,
  not `autofix: fix blocking finding` or `autofix: apply review comments`.
- Under 60 characters, imperative mood, no trailing period.

Do not reference thread ids, run urls, or the reviewer by name in the prose;
that is what the trailer is for.

The trailer block must be the last paragraph and must be copied exactly as
`plan.json` renders it. It is what a later run reads to know this one happened.
It is machine metadata: never describe it, expand it, or move it into the body.

## Step 6: Reply in each thread

For every item you fixed, emit one `reply-to-pull-request-review-comment` on
that item's thread, stating what you changed in one or two sentences. Be
specific: "Renamed to `parsedConfig` and updated the three call sites" beats
"Fixed".

**Exception: body-sourced items.** An item whose id starts `review-body:` came
from the latest review body's collapsed observations, not from a thread; there
is nothing to reply on. Skip it here and report what you did (fixed, left
unfixed and why) in the Step 7 summary instead, one line per body-sourced
item: `` `path:line`: <what changed, or why not> ``.

Do **not** resolve any thread. The next review decides whether the fix settled
the finding; that is the whole verification story for this workflow, it is
best-effort (see Step 7), and resolving here would erase it.

For an item you deliberately left unfixed (Step 3 or Step 4), reply saying so
and why, in one sentence. A finding that was handed to you and silently skipped
is the one outcome an author cannot debug.

## Step 7: Post the run summary

**Post exactly one `add-comment`, on every path through this workflow.** A
refusal, a no-op, a finding left unfixed, an abandoned push, a run that fixed
everything cleanly: all of them get one comment, and never more than one.

An earlier version of this step stayed quiet when a run was unremarkable, on the
reasoning that a clean run already tells its own story in three other places:
the thread reply on each fixed finding, the commit in the PR timeline, and the
engine's own "Commit pushed" comment, so a fourth notification repeating them is
noise. That reasoning was right about noise and wrong about what still needed
saying. All three of those places record that something *changed*; none of them
records that nothing has *checked* it. Item 8 below is the only place a reader
learns that, so the comment carrying it cannot be optional.

The quiet branch was therefore retracted deliberately, not lost. It was also
unreachable in practice: it required `plan.degradedNote` to be empty, and the
reviewer's hidden fingerprint stamp is stripped from every posted review (the
README's "Degrading when there is no fingerprint" documents it), so that note is
essentially always set. Do not reintroduce the branch without first answering
where the pending-verification statement goes instead.

Do **not** try to add a hidden HTML-comment marker of your own. gh-aw's
safe-output ingest strips every XML/HTML comment before posting
(`removeXmlComments` in `sanitize_content_core.cjs`, a depth-tracking scan with
no allowlist), so such a marker is silently deleted. An earlier version of this
step asked for `<!-- pr-autofixer:summary -->`; the posted comments never
carried it. Collapsing older comments still works, because the engine adds its
own `gh-aw-workflow-call-id` marker after sanitisation.

Write the body directly, in this order, including only the parts that apply:

1. One sentence of plain past-tense prose saying what happened. Take the
   substance from the plan's `reason` but write it as a sentence to a person:
   `Fixed 1 blocking finding.`, not `fixing 1 blocking finding(s).` Get the
   tense and the plural right; the work is already done by the time anyone
   reads this.
2. If anything was fixed: a list, one line per finding, `path:line` plus what
   changed. Link each to its thread `url` when the item has one. When a
   documentation fix **deleted** a comment without being able to record why the
   code is the way it is (Step 4), say so on that line and name the symbol: the
   thread is fixed and the value is still unexplained, and this is the only
   place a human learns there is a sentence only they can write.
3. If anything was left unfixed: a list, one line each, with the reason. This
   is the most important section in the comment; never omit or soften it.
4. If `plan.skipped` contains entries whose reason is **not** `out-of-scope`:
   one line each with the reason (`outdated-anchor`, `unparseable-label`,
   `stale-path`, `thread-covered`). Put any `out-of-scope` entries in a collapsed
   `<details><summary>N thread(s) outside this run's scope</summary>` block, or
   omit them entirely when the comment already has more urgent content: they
   are the expected consequence of the scope the author picked.
5. If `plan.stalePaths` is non-empty, one line: `Files changed since the last
   review, so findings in them were not acted on: <paths>.`
6. If you could not run any check against your own edit, one line saying so, in
   plain terms: `Not verified locally: no test or build command is available to
   this workflow.` Never imply a fix was validated when it was not.
7. If `plan.degradedNote` is non-empty, that note **verbatim** on its own line.
   Never omit it and never soften it: a weaker check that goes unmentioned is
   indistinguishable from the full one.
8. When anything was pushed, last two lines, exactly:

   `Not verified: nothing has checked this commit. Autofix does not resolve its
   own threads; whether these fixes settled the findings is decided by the
   reviewer's next review of this branch, not by this run.`

   `That re-review can fail, or never trigger at all; a /review comment asks for
   one at any time.`

Items 6 and 8 are different claims and both can appear in the same comment: item
6 is about what this run could check *before* pushing, item 8 about what checks
the commit *after*. Do not merge them or drop one as a duplicate.

Both of item 8's lines have to still be true a week later, once the re-review
has landed and approved. The first is tensed to the moment of writing, which is
what makes it safe. The second states a standing fact and a standing capability,
not a conditional instruction, because a one-shot run can never come back and
retract one: `If no review appears, comment /review` would leave every verified
PR permanently carrying an instruction to go and trigger a review. The same
objection rules out putting verification state in the commit trailer, where
nothing could ever update it either.

Write nothing else. No preamble, no summary of the PR, no opinion on the code.
Do not use em dashes; a semicolon, colon, or full stop reads better and matches
the rest of this repo's bot output.

## Step 8: Remove the labels

Emit `remove-labels` for every label in the plan's `labelsToRemove`. Do this on
every path through this workflow, including refusals and no-ops. The label is a
button: once the run is over it must be off, so that its presence always means
"queued" and never "already done".

On a command-armed run `labelsToRemove` is empty, and that is correct, not an
oversight: a comment is self-clearing, and any autofix label sitting on the PR
was not what armed this run. Removing it would clear an intent nobody acted on.
Emit nothing in that case.

## Step 9: Upload the artifact

Upload `/tmp/gh-aw/autofix/out/` with `upload-artifact` in one call.
