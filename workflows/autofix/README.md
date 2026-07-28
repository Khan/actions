# `autofix` — opt-in reviewer-feedback autofixer

Addresses the [`review`](../review) workflow's own feedback on a PR, on demand,
one run per arming. Add a label, get a commit.

It is deliberately narrow. It fixes findings the reviewer already raised; it
does not review, does not look for problems nobody flagged, and does not resolve
its own threads.

## Using it

Add one of these labels to a PR:

| Label              | Fixes                                                      |
| ------------------ | ---------------------------------------------------------- |
| `autofix: blocking` | The reviewer's open blocking threads (`issue (blocking)`, `issue (blocking, best-practice)`, `todo (blocking)`) |
| `autofix: nits`     | The reviewer's open non-blocking threads (suggestions, nitpicks, questions, thoughts, notes) |

Both may be on at once; the scopes union. The run then:

1. checks that the reviewer's feedback is current for this head,
2. fixes what it can, in one commit pushed to the PR branch,
3. replies in each thread saying what it did (or why it did not),
4. posts one summary comment,
5. **removes the label.**

The label is a button, not a mode. It comes off on every outcome, including
refusals, so its presence always means "queued" and never "already done".
Re-arming is one click.

The push is made with `KHAN_ACTIONS_BOT_TOKEN`, so it triggers a re-review.
**That re-review is the verification step**: autofix never resolves a thread,
and whether a fix actually settled a finding is decided by the next review, not
by the run that wrote it.

## The label axis model

The labels are namespaced `autofix: <value>`, and that namespace is flat while
the semantics are not. Three axes exist; a label names a value on exactly one of
them:

| Axis        | Values                        | Combination rule       | Implemented |
| ----------- | ----------------------------- | ---------------------- | ----------- |
| **scope**   | `blocking`, `nits`            | union                  | yes         |
| **cadence** | `loop` (absent = once)        | flag                   | no          |
| **source**  | `human`, `author` (absent = the reviewer bot) | union  | no          |

Read this before adding a label to the vocabulary. `autofix: nits` and
`autofix: loop` look like peers and are not, and the day both are on a PR the
rule that resolves them has to already exist.

A label on an unimplemented axis is **rejected, not ignored** (`scope.ts`
`UNIMPLEMENTED_LABELS`). Honouring the blocking half of `blocking + loop` would
present as a loop that mysteriously stopped after one cycle, which is worse than
a clear refusal.

### One constraint that outlives v1: nits never loop

`isLoopEligible` is enforced in code rather than left to convention.
Non-blocking findings have no fixed point — the reviewer will always find
something cosmetic in the autofixer's own output — so a nits-scoped loop cannot
converge. Blocking scope terminates naturally at the merge gate, which is why it
is the scope a cadence axis would be built on.

## What it refuses to do

Every refusal fails closed: when the run cannot establish that acting is safe,
it does nothing, removes the label, and says why.

- **No reviewer feedback yet.** Nothing to fix.
- **The review does not match this head.** Currency is checked against the
  reviewer's own hidden fingerprint stamp (`review.md` Step 6), which survives
  force-pushes and rebases because it hashes added-line content rather than
  SHAs. The check is **per file**: if the author pushed one unrelated fix after
  the review, findings in the files that did not change are still fixed, and
  only the affected ones are dropped. An all-or-nothing gate would refuse
  routine PRs constantly.
- **The fingerprint is unreadable** (`hunks=overflow`, on a diff too large to
  stamp). Autofix will not edit code it cannot confirm was reviewed.
- **The thread's label will not parse.** Note this fails *closed in the opposite
  direction* from `rereview.ts`, where an unparseable label is treated as
  blocking so the thread is kept. Here an unclassifiable finding is excluded,
  because the risk being managed is an agent editing code on the strength of a
  finding it could not classify.
- **The thread is outdated** (GitHub reports no anchor line). The code the
  finding was written about is gone.
- **The head moved while the run was working.** The edits are against a base
  that no longer exists, so the push is abandoned.

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

Create the two labels (`autofix: blocking`, `autofix: nits`). Nothing else is
configured per repo in v1; scope is chosen per PR by which label you add.

## Design notes

### Why the label, and not a 🚀 on a comment

Per-comment triggering was considered and dropped for v1. GitHub emits **no
webhook for reactions** — the feature request has been open since 2022 — which
is why the review workflow's own thumbs sweep is a two-hourly cron. A
reaction-triggered autofix would inherit that latency, or need a second poll to
shave a delay it still could not bound. `pull_request: labeled` fires
immediately.

Note also that 🚀 is already live signal: `thumbs-sweep.ts` counts it as a
positive reaction feeding the reviewer's tuning loop, so overloading it would
corrupt that channel. If per-comment triggering lands later, a thread **reply**
is the better mechanism anyway: `pull_request_review_comment: created` fires
instantly, carries `in_reply_to_id`, and lets the human add context.

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
