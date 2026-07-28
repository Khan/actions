---
description: >
  Addresses the PR reviewer's own feedback on demand. Opt in per PR with an
  `autofix: blocking` or `autofix: nits` label; the run fixes the reviewer's
  open threads in that scope, pushes one commit, replies in each thread, and
  removes the label. One run per arming.

on:
  pull_request:
    types: [labeled]
  # No status comment: the run posts exactly one summary comment of its own
  # (Step 7), and a gh-aw "started/completed" comment on top of that would
  # double the noise on a PR that is already carrying a full review.
  status-comment: false
  # Autofix writes code to someone's branch, so the actor who armed it must be
  # able to write to the repo themselves. This is deliberately NOT the
  # reviewer's `roles: all` override: the reviewer only reads and comments, and
  # its gate is relaxed so a collaborator's push still triggers a review.
  roles: [admin, maintainer, write]

# Three gates, all cheap and all before the agent starts:
#   1. Same-repo branches only. A fork PR gets no secrets, so the push would
#      fail anyway, and this repo is public.
#   2. The label that fired this event is an autofix label. Every other label
#      addition on the PR is a no-op run we never pay for.
#   3. Never on a PR the reviewer was told to skip: with no review there is
#      nothing to fix, and the plan would refuse in Step 2 regardless.
if: >-
  github.event.pull_request.head.repo.full_name == github.repository &&
  startsWith(github.event.label.name, 'autofix: ') &&
  !contains(github.event.pull_request.labels.*.name, 'skip-ai-review')

permissions:
  contents: read
  pull-requests: read

tools:
  github:
    lockdown: false
    min-integrity: none
    toolsets: [pull_requests, repos]
  edit:
  bash:
    - "git *"
    - "npx *"
    - "node *"
    - "cat *"
    - "ls *"
    - "date *"
    - "mkdir *"

safe-outputs:
  allowed-domains:
    - github.com
    - khanacademy.org
    - khanacademy.dev
    - khanacademy.atlassian.net

  # The commit. `KHAN_ACTIONS_BOT_TOKEN` rather than the default GITHUB_TOKEN is
  # load-bearing, not incidental: GitHub does not create workflow runs for
  # events triggered by GITHUB_TOKEN, so a push made with it would emit no
  # `synchronize` and the reviewer would never re-review the fix. The re-review
  # IS the verification step for an autofix commit, so an unverified push is
  # worse than no push at all.
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

# Pinned to a specific model version rather than a floating tier alias, so the
# autofixer does not silently change behaviour when a new Opus ships. Matches
# the reviewer's orchestrator pin.
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
      ref: autofix-v0.0.0
      path: gh-aw-autofix-lib
      persist-credentials: false

# A fix run is a fraction of a review run: no reviewer roster, no lenses, one
# agent editing a bounded set of files. 1000 credits ($10) is the gh-aw default
# and is generous for that shape; the daily ceiling stays on, because unlike
# reviews (which must never be skipped) a deferred autofix costs nothing but a
# re-click.
max-ai-credits: 1000

source: Khan/actions/workflows/autofix/autofix.md@autofix-v0.0.0
---

# PR Autofixer

You address feedback the PR reviewer left on this pull request. You are not a
reviewer: you do not judge whether a finding is worth fixing, and you do not
look for problems nobody raised. Your scope is exactly the threads the plan
hands you in Step 2.

## Current Context

- **Repository**: ${{ github.repository }}
- **Pull Request**: #${{ github.event.pull_request.number }}

The label that armed this run is not interpolated here on purpose: gh-aw's
expression allowlist excludes `github.event.label.name` from prompt bodies, and
the plan reads the PR's live labels in Step 2 anyway, which is the authoritative
answer regardless of which single label fired the event.

## Step 1: Stage the inputs

Create `/tmp/gh-aw/autofix/` and `/tmp/gh-aw/autofix/out/`, then stage five
files into the former. Stage them exactly as described: the plan CLI in Step 2
parses them, and every decision this run makes is derived from them.

1. `labels.json` — the PR's current labels as a JSON array of name strings
   (`pull_requests` `get`).
2. `threads.json` — the unresolved `github-actions[bot]` review threads
   (`pull_request_read` `get_review_comments`). For each write `thread_id`,
   `path`, `line` (the RIGHT-side line; `null` when GitHub reports the thread
   outdated), `url` (the `html_url` of the thread's **first** comment), and
   `comments`: every comment in the thread in order, each `{author, body}`.
   Stage each `body` **verbatim as the tool returned it**, markdown included —
   the label parser reads the leading `**label:**` off the opener, and
   reformatting it is what makes a thread unclassifiable.
3. `prior-reviews.json` — every review authored by `github-actions[bot]`,
   **whatever its state**, each `{"body": "...", "submittedAt": "<ISO>"}`. Do
   not filter or truncate the bodies: the currency check reads the hidden
   fingerprint stamp out of them, and a dismissed or comment-only review still
   carries one.
4. `pr.diff` — the PR's full diff (`pull_requests` `get_files`, concatenating
   the per-file patches).
5. `commits.json` — the commit messages on the PR head, as a JSON array of
   strings (`pull_requests` `get_commits`). This is the autofix cycle ledger;
   it is read from the branch rather than from cache memory because the branch
   cannot be evicted.

Also record the current head SHA (`pull_requests` `get`, `head.sha`). Step 5
compares against it.

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
- **Do not touch files no item points at.** The one exception is a change that
  is mechanically forced by a fix (a caller that must be updated for a changed
  signature); note any such file in Step 7.
- **Do not amend, rebase, or force-push.** You produce working-tree changes;
  the push is a safe output.
- If a fix would require a design decision the reviewer did not make for you,
  leave it unfixed and say so.

## Step 5: Push one commit

First re-read the PR's head SHA and compare it to the one recorded in Step 1.
**If it changed, do not push.** The author pushed while you were working, and
your edits are against a base that no longer exists. Skip to Step 7, report that
the run was abandoned for that reason, and remove the labels; the author can
re-label once their push settles.

Otherwise emit a single `push-to-pull-request-branch` with all your changes.
The commit message is:

```
autofix: address reviewer feedback

<one line per fixed finding: `<path>:<line> — <what changed>`>

<the plan's `trailer` field, verbatim>
```

The trailer block must be the last paragraph and must be copied exactly as
`plan.json` renders it. It is what a later run reads to know this one happened.

## Step 6: Reply in each thread

For every item you fixed, emit one `reply-to-pull-request-review-comment` on
that item's thread, stating what you changed in one or two sentences. Be
specific: "Renamed to `parsedConfig` and updated the three call sites" beats
"Fixed".

Do **not** resolve any thread. The next review decides whether the fix settled
the finding; that is the whole verification story for this workflow, and
resolving here would erase it.

For an item you deliberately left unfixed (Step 3 or Step 4), reply saying so
and why, in one sentence. A finding that was handed to you and silently skipped
is the one outcome an author cannot debug.

## Step 7: Post the run summary

Emit exactly one `add-comment`, beginning with this marker line:

```
<!-- pr-autofixer:summary -->
```

Then, in this order:

1. One sentence: the plan's `reason`, verbatim.
2. If anything was fixed: a list, one line per finding, `path:line` plus what
   changed. Link each to its thread `url` when the item has one.
3. If anything was left unfixed: a list, one line each, with the reason.
4. If `plan.skipped` is non-empty: one line per skipped thread with its
   `reason` (`out-of-scope`, `outdated-anchor`, `unparseable-label`,
   `stale-path`), so the author can see what autofix did not consider.
5. If `plan.stalePaths` is non-empty, one line: `Files changed since the last
   review, so findings in them were not acted on: <paths>.`
6. Last line, exactly: `The reviewer will re-review this push; autofix does not
   resolve its own threads.` Omit this line when nothing was pushed.

Write nothing else. No preamble, no summary of the PR, no opinion on the code.

## Step 8: Remove the labels

Emit `remove-labels` for every label in the plan's `labelsToRemove`. Do this on
every path through this workflow, including refusals and no-ops. The label is a
button: once the run is over it must be off, so that its presence always means
"queued" and never "already done".

## Step 9: Upload the artifact

Upload `/tmp/gh-aw/autofix/out/` with `upload-artifact` in one call.
