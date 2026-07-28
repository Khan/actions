# `autofix` — opt-in reviewer-feedback autofixer

Addresses the [`review`](../review) workflow's own feedback on a PR, on demand,
one run per arming. Add a label or comment `/autofix`, get a commit.

It is deliberately narrow. It fixes findings the reviewer already raised; it
does not review, does not look for problems nobody flagged, and does not resolve
its own threads.

## Using it

Two ways to arm it, and they are peers. Neither is a shorthand for the other.

**Label the PR:**

| Label              | Fixes                                                      |
| ------------------ | ---------------------------------------------------------- |
| `autofix: blocking` | The reviewer's open blocking threads (`issue (blocking)`, `issue (blocking, best-practice)`, `todo (blocking)`) |
| `autofix: nits`     | The reviewer's open non-blocking threads (suggestions, nitpicks, questions, thoughts, notes) |

**Or comment on the PR:**

```
/autofix                 # same as /autofix blocking
/autofix nits
/autofix blocking nits
```

Prose after the command line is ignored by the parser, so you can leave context
for whoever reads the thread later:

```
/autofix blocking

but keep the existing naming, it matches the RFC
```

Both labels may be on at once and both arguments may be given at once; the
scopes union. **The trigger decides, and the two surfaces never union with each
other**: a stale `autofix: nits` label will not widen an explicit
`/autofix blocking`. Whichever one fired the run is the one that is read.

The run then:

1. checks that the reviewer's feedback is current for this head,
2. fixes what it can, in one commit pushed to the PR branch,
3. replies in each thread saying what it did (or why it did not),
4. posts one summary comment,
5. **removes the label** (label-armed runs only).

The label is a button, not a mode. It comes off on every outcome, including
refusals, so its presence always means "queued" and never "already done".
Re-arming is one click.

A command-armed run removes nothing, and that is deliberate: a comment is
already self-clearing, and any autofix label sitting on the PR was not what
armed the run. Clearing it would discard an intent nobody acted on.

The push is made with `KHAN_ACTIONS_BOT_TOKEN`, so it triggers a re-review.
**That re-review is the verification step**: autofix never resolves a thread,
and whether a fix actually settled a finding is decided by the next review, not
by the run that wrote it.

## The axis model

Both surfaces share one currency: the **token**, the value after the namespace.
`autofix: blocking` and `/autofix blocking` carry the same token, resolve
through the same function (`scope.ts` `resolveTokens`), and cannot drift.

The token space is flat while the semantics are not. Three axes exist; a token
names a value on exactly one of them:

| Axis        | Tokens                        | Combination rule       | Implemented |
| ----------- | ----------------------------- | ---------------------- | ----------- |
| **scope**   | `blocking`, `nits`            | union                  | yes         |
| **cadence** | `loop` (absent = once)        | flag                   | no          |
| **source**  | `human`, `author` (absent = the reviewer bot) | union  | no          |

Read this before adding a token to the vocabulary. `nits` and `loop` look like
peers and are not, and the day both are requested the rule that resolves them
has to already exist.

Because unioning happens *within* an axis, the vocabulary stays bounded by the
axes (five tokens across all three) rather than growing as their product. There
is no `blocking-loop` token and there must never be one.

A token on an unimplemented axis is **rejected, not ignored** (`scope.ts`
`UNIMPLEMENTED_TOKENS`). Honouring the blocking half of `blocking + loop` would
present as a loop that mysteriously stopped after one cycle, which is worse than
a clear refusal.

A bare `/autofix` means `blocking`, the scope that terminates at the merge gate;
a bare command must not silently do the open-ended thing. There is deliberately
no bare `autofix` label equivalent, since a label carries no arguments and the
two forms would be indistinguishable at a glance.

### One constraint that outlives v1: nits never loop

`isLoopEligible` is enforced in code rather than left to convention.
Non-blocking findings have no fixed point — the reviewer will always find
something cosmetic in the autofixer's own output — so a nits-scoped loop cannot
converge. Blocking scope terminates naturally at the merge gate, which is why it
is the scope a cadence axis would be built on.

## What it refuses to do

Every refusal fails closed: when the run cannot establish that acting is safe,
it does nothing, clears any label that armed it, and says why.

- **No reviewer feedback at all.** Nothing to fix. This is the *only* currency
  state that refuses.
- **The review does not match this head.** Currency is checked against the
  reviewer's own hidden fingerprint stamp (`review.md` Step 6), which survives
  force-pushes and rebases because it hashes added-line content rather than
  SHAs. The check is **per file**: if the author pushed one unrelated fix after
  the review, findings in the files that did not change are still fixed, and
  only the affected ones are dropped. An all-or-nothing gate would refuse
  routine PRs constantly.
- **The thread's label will not parse.** Note this fails *closed in the opposite
  direction* from `rereview.ts`, where an unparseable label is treated as
  blocking so the thread is kept. Here an unclassifiable finding is excluded,
  because the risk being managed is an agent editing code on the strength of a
  finding it could not classify.
- **The thread is outdated** (GitHub reports no anchor line). The code the
  finding was written about is gone.
- **The head moved while the run was working.** The edits are against a base
  that no longer exists, so the push is abandoned.

### Degrading when there is no fingerprint

If the reviewer's review carries no diff fingerprint (no stamp at all, or
`hunks=overflow` on a very large diff), the file-level check cannot run. Autofix
**degrades rather than refusing**, and says so in the summary.

An earlier version refused outright, which made autofix unusable against the
reviewer as actually deployed: on Khan/webapp#41130 the reviewer posted a correct
blocking finding under a body of exactly `Changes requested — see inline
comments.` with no stamp, and autofix refused every time while reporting "no
reviewer feedback has been posted on this PR".

The fingerprint is not the only currency signal and not even the primary one.
GitHub marks a review comment outdated when the diff hunk it anchors to changes,
which is the per-thread check above, and it covers the case that actually
matters: the author edited the flagged code. The fingerprint adds coarser
file-level detection whose failure mode is a redundant fix the next re-review
catches. So: use the fingerprint when it is there, fall back to anchors when it
is not, and never let the weaker check be silent.

## What it will not do to your code

Enforced in the prompt, not in code — treat these as the contract the trial is
measuring, not as a guarantee:

- No drive-by refactors. Every hunk traces to a finding it was handed.
- **Never weakens a test to satisfy a finding.** Deleting an assertion,
  loosening a matcher, adding a skip, or widening an expected range is never an
  acceptable outcome; the finding is left unfixed and reported instead.
- No amend, rebase, or force-push.
- Ambiguous findings are left alone and reported, not guessed at.

One further limit is enforced by gh-aw itself rather than by us: its
`push-to-pull-request-branch` handler refuses to commit changes to a
protected-file list that includes every dependency manifest and lockfile
(`package.json`, `pnpm-lock.yaml`, `go.mod`, …), `CODEOWNERS`, and the
repo-root markdown (`README.md`, `CHANGELOG.md`, `CLAUDE.md`, `AGENTS.md`), and
it blocks writes to top-level dot-folders. A finding in one of those files
cannot be autofixed; the run reports it unfixed.

## The commit trailer

Every autofix commit ends with a machine-readable trailer:

```
Autofix-Version: 1
Autofix-Scope: blocking
Autofix-Cycle: 1
Autofix-Threads: PRRT_kwDO…,PRRT_kwDO…
```

v1 runs once per arming and never reads this back. It is written anyway because
the branch is the only cycle store that survives cache eviction, needs no
external state, and is legible to a human reading the PR — the same reasoning
that put the reviewer's authoritative fingerprint in the review body rather than
in cache memory. `Autofix-Threads` is the attempted-finding ledger: diffing it
against what the next review still reports open is how the trial answers whether
a fix actually cleared the finding.

## Install

```sh
gh aw add Khan/actions/workflows/autofix
gh aw compile
```

Requires the `review` workflow to be installed and running in the same repo:
autofix reads its threads, its label taxonomy, and its fingerprint stamp.

### Required secrets

- `ANTHROPIC_API_KEY` — the `claude` engine.
- `KHAN_ACTIONS_BOT_TOKEN` — the push. **Not optional and not substitutable
  with `GITHUB_TOKEN`**: GitHub creates no workflow runs for events triggered by
  `GITHUB_TOKEN`, so a push made with it emits no `synchronize`, the reviewer
  never re-reviews, and the fix ships unverified.

### Repository setup

Create the two labels (`autofix: blocking`, `autofix: nits`) if you want the
label surface; the `/autofix` command needs no setup. Nothing else is
configured per repo: scope is chosen per PR by label or argument.

## Design notes

### Why the command is written out longhand

The `/autofix` gate is spelled out in the workflow's `if:` rather than using
gh-aw's `slash_command` trigger. gh-aw's compiled gate only matches the command
followed by a space, a bare `\n`, or end-of-body, so a comment saved with a
trailing CRLF — which the GitHub web UI produces when you press Enter after the
command — never activates the workflow. That silently killed `/review` in
Khan/webapp#40943. The parser in `scope.ts` tolerates the same shapes; the two
must stay in step, and there is a test pinning the CRLF case specifically.

### The command path's gates are weaker

Worth knowing before relying on it. `issue_comment` carries no
`github.event.pull_request`, so the fork guard and the `skip-ai-review` check
cannot be evaluated in the `if:` at all — they move into the plan, after the
agent job has started. An `/autofix` on a PR the label path would have rejected
for free still costs a job.

The gate that actually matters is unaffected: gh-aw's `roles` check still runs,
compiling to an `author_association` test against `OWNER`/`MEMBER`/
`COLLABORATOR`, so a comment from someone without write access never reaches the
agent. That is the gate standing between a drive-by comment and a code push.

### Why the label, and not a 🚀 on a comment

Per-comment triggering was considered and dropped for v1. GitHub emits **no
webhook for reactions** — the feature request has been open since 2022 — which
is why the review workflow's own thumbs sweep is a two-hourly cron. A
reaction-triggered autofix would inherit that latency, or need a second poll to
shave a delay it still could not bound. `pull_request: labeled` and
`issue_comment: created` both fire immediately.

Note also that 🚀 is already live signal: `thumbs-sweep.ts` counts it as a
positive reaction feeding the reviewer's tuning loop, so overloading it would
corrupt that channel.

The command surface makes per-comment autofix nearly free when it lands: an
`/autofix` posted as a **reply inside a review thread** fires
`pull_request_review_comment: created` and carries `in_reply_to_id`, naming the
exact finding with no matching heuristics. The parser already handles the
command; only the trigger and the thread-scoping would be new.

### Why not suggestion blocks

The reviewer already emits ```suggestion blocks for single-line mechanical
fixes, which GitHub lets an author batch-commit with one click at zero CI and
zero credit cost. Autofix earns its keep on what a suggestion block cannot
express: multi-line, cross-file, needs-a-test changes.

### Division of labour

Code decides; the model edits. `lib/plan.ts` is the determinism boundary: it
resolves the scope, checks currency, builds the work list, and renders the
trailer, all before the agent is asked to change anything. The plan is final —
the prompt's contract is to execute it or stop, never to widen it, narrow it, or
re-classify a skipped thread. Nothing in `lib/` composes a sentence about the
code under review.

## Versioning

`autofix.md` pins `Khan/actions` at `autofix-v<version>` in both its
`pre-agent-steps` checkout and its `source:`, so prompt and code always come
from one release. `utils/sync-workflow-versions.ts` rewrites those literals
during the release; `version-sync.test.ts` fails CI if they ever drift from the
package version.
