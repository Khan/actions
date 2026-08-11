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
| `autofix: docs`     | Only the `documentation` reviewer's threads (`suggestion (non-blocking, documentation)`) — a subset of `nits`, see below |

**Or comment on the PR:**

```
/autofix                 # same as /autofix blocking
/autofix nits
/autofix docs
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
4. posts one summary comment, but only when it has something non-obvious to
   say (see below); a clean run stays quiet,
5. **removes the label** (label-armed runs only).

The label is a button, not a mode. It comes off on every outcome, including
refusals, so its presence always means "queued" and never "already done".
Re-arming is one click.

A command-armed run removes nothing, and that is deliberate: a comment is
already self-clearing, and any autofix label sitting on the PR was not what
armed the run. Clearing it would discard an intent nobody acted on.

The push is made with `KHAN_ACTIONS_BOT_TOKEN`, so it can trigger a re-review.
That re-review is the **intended** verification: autofix never resolves a
thread, and whether a fix actually settled a finding is decided by the next
review, not by the run that wrote it.

### Verification is best-effort

Nothing between the fix and the merge gate is guaranteed to check an autofix
commit, and the summary comment says so on every push.

The chain from the push to a posted review has links, and how many depends on
the consumer. With the shared push-triggered reviewer it is two (push →
`synchronize` → reviewer). In Khan/webapp, where the reviewer is an
`issue_comment` local override, it is four (push → `synchronize` →
`review-kore-prs.yml` posts `/review` → reviewer). Any link can fail
independently of gh-aw.

Whether a break is *visible* also depends on the consumer, and this is the part
worth knowing before trialling autofix in a new repo:

- **Push-triggered reviewer:** the reviewer's jobs join the PR's check suite, so
  a failed re-review is a red X on the commit autofix pushed.
- **`issue_comment`-triggered reviewer:** the run's head SHA is a default-branch
  merge commit, so it never joins the PR's check suite at all. With
  `status-comment: false` it posts nothing either. gh-aw's own fallback
  (`failure-report-as-issue`) is then the last line of defence, and it is
  unavailable in a repo with issues disabled.

In Khan/webapp all three of those conditions hold at once: the reviewer is an
`issue_comment` override, `status-comment` is false, and issues are disabled. On
#41194 the re-review of the autofix commit `ad8da8d4` failed in `Install AWF
binary`, before the model ran, so it cost zero AI credits and produced no
output; gh-aw tried to file its failure issue and got `410 Issues has been
disabled in this repository`. The only trace
on the PR was the 👀 the activation job had already put on the `/review`
comment, which is indistinguishable from "still running". The commit sat
unverified for 36 minutes, and the human who eventually re-triggered it found it
by querying the Actions runs list, not from anything on the PR. This is not a
rare shape: of that repo's last 100 reviewer runs, 15 of the 53 that started
ended in `failure`.

**The human re-arming loop is the backstop, and that is accepted for v1.** It is
the same loop that arms autofix in the first place. What v1 owes it is the
pending statement, not machinery.

A detector is deferred, not blocked, and needs nothing added here. It does not
require reading the trailer back: the question is "does a review by the reviewer
bot exist whose `commit_id` is this autofix commit or later", answerable from
the SHA alone. What it needs is a home that runs *later* than the autofix run,
which a one-shot workflow does not have. Note also that verification state must
never go **in** the trailer: nothing in v1 could ever flip an `Autofix-Verified:
pending` field, so it would sit permanently wrong on every commit that was in
fact verified.

## The axis model

Both surfaces share one currency: the **token**, the value after the namespace.
`autofix: blocking` and `/autofix blocking` carry the same token, resolve
through the same function (`scope.ts` `resolveTokens`), and cannot drift.

The token space is flat while the semantics are not. Three axes exist; a token
names a value on exactly one of them:

| Axis        | Tokens                        | Combination rule       | Implemented |
| ----------- | ----------------------------- | ---------------------- | ----------- |
| **scope**   | `blocking`, `nits`, `docs`    | union                  | yes         |
| **cadence** | `loop` (absent = once)        | flag                   | no          |
| **source**  | `human`, `author` (absent = the reviewer bot) | union  | no          |

The three scope values are not three disjoint classes. `blocking` and `nits`
partition the reviewer's threads between them; **`docs` is a subset of `nits`**,
selecting only the `documentation` reviewer's label. Arming both is the same as
arming `nits`, and the containment runs one way only: `docs` exists because
arming `nits` to clear three stale comments also invites the fixer into every
other cosmetic thread on the PR. A flat namespace cannot show that, so it is
written down here and in `scope.ts`.

One class of documentation finding never reaches this workflow at all: a PR
title/description readability finding posts PR-level, folded into the review
body rather than opened as a thread, so the worklist (which reads threads and
parses their labels) never sees it. That is deliberate, not a gap: the
description is the author's voice, the review body already carries the plain
rewrite for the author to take or leave, and a bot editing PR metadata is a
different trust decision than a bot editing comment text on a branch.

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

What enforces this in v1 is the **token table**: `loop` sits in
`UNIMPLEMENTED_TOKENS`, so `autofix: loop` is rejected and no cadence can be
armed at all. `isLoopEligible` in `scope.ts` states the rule itself and has no
production caller, because there is no cadence axis to call it; it exists so the
rule does not have to be rediscovered. **Whoever builds the cadence axis must
call it**; until then it is a documented intent with a test, not a gate.

The rule: non-blocking findings have no fixed point, so a nits-scoped loop
cannot converge. Blocking scope terminates at the merge gate, which is why it is
the scope a cadence axis would be built on. But note what that rests on: the
merge gate is a claim about a human eventually merging, not something the
pipeline enforces, and the one mechanism that does bound re-flagging exempts
blocking from itself: the reviewer's newly-changed-code scope filter
(`applyScopeFilter` in `review/lib/dispatch-contracts.ts`) keeps plain
`issue (blocking)` / `todo (blocking)` findings regardless of scope, so blocking
is the one class that can be re-raised on previously-reviewed, untouched lines on
every cycle. The filter bounds nits; it does not bound blocking.

Khan/webapp#41194 is the first live evidence, and it corrects what this section
used to claim the generator was. One blocking-scoped cycle fixed its finding, and
the re-review resolved that thread and approved, then filed two fresh
non-blocking findings against code autofix never wrote (`counts.go:7` is
`func MergeCounts`, twelve lines above its first added line; `counts.go:16` is a
context line in its own hunk). That run planned `no-prior-fingerprint`, so the
scope filter was a no-op and the whole diff was re-derived with no memory of what
the previous review had already said. Open non-blocking threads went 3 → 5 in one
cycle with no nits-scoped work done. The generator is a **memoryless
re-derivation over the whole diff**, not the fixer's own prose; it does not need
the fixer to have written anything.

`docs` is the value worth pausing on, because it looks like the exception. It is
not, and the reason is mechanical rather than a question of which half of the
documentation policy dominates in practice — which is what this section used to
defer the decision to.

The bound on re-flagging is the reviewer's newly-changed-code scope, built from
each unseen hunk's **added** lines (`computeNewScope` in
`review/lib/stage-pr.ts`). A docs-scoped fix writes comment text and nothing
else, and comment text is exactly what the documentation reviewer reviews. So
the halves are two mechanical outcomes, not two tendencies:

- **Deletion converges, and only by erasure.** A deleted comment adds no lines,
  so it puts nothing in the next cycle's scope and cannot be re-flagged.
  Khan/webapp#41204 is the cost: a "restates the constant" finding on
  `staleAfter` was fixed by deleting the comment instead of supplying the
  rationale. Defensible for pure restatement, and the constant is still
  undocumented.
- **Rewriting re-arms.** Replacement prose *is* added lines, so the next cycle's
  in-scope set is very nearly all prose the fixer just wrote, handed back to the
  reviewer that asked for it. Khan/webapp#41207 measured one cycle:
  `autofix: docs` fixed 5 of 5 documentation threads at perfect precision (7
  non-documentation threads untouched, one file modified, all four edits
  comments), and the re-review its own push triggered minted three fresh
  documentation findings — on `isAlnum`'s and `Slugify`'s docs — that did not
  exist when the run was armed.

#41207 is the data point #41194 could not be. That earlier run came from a repo
whose `review` release is too old to mint the `documentation` label, so its
finding posted as a plain `note (non-blocking)` that `autofix: docs` would never
have selected, and it was a memoryless whole-diff re-derivation besides.
#41207's re-mints are real documentation findings on lines the autofix commit
itself introduced, which is why no scope filter keyed on newly-changed lines can
bound them: the fixer is the author of the newly-changed lines.

#41207 predates the per-lens volume caps this release puts on the documentation
reviewer, so the re-mint count it measured is an upper bound on what the capped
reviewer would post. The caps bound how many findings a cycle emits, not whether
the fixer's own prose lands in the next cycle's in-scope set, and convergence
needs the latter to be empty; a capped loop re-arms more slowly, but it re-arms.

So `docs` is ineligible **permanently under the current scope model**, and the
two configurations fail in opposite directions: deletion-only converges while
erasing rationale, rewrite-enabled preserves rationale and re-arms. One-shot
mode has no cadence to protect, so the prompt is deliberately biased toward
rewrite-with-why (Step 4), which is the right trade for quality per shot and
the wrong one for a loop.
Anyone building a cadence axis that includes `docs` needs an authorship-aware
bound as a **precondition**, not a better prompt: exclude hunks whose commit
carries `Autofix-Scope: docs` from the documentation lens's in-scope set. It is
not built now because in one-shot mode a re-mint costs three advisory threads on
a PR its author is already reading, and every further cycle needs a fresh human
arming.

### Why `docs` is the safest scope

Its edits cannot change program behaviour, which no other scope can say. That
makes it the natural first scope to trial in a repo that has not run autofix
before, and the prompt holds the line in Step 4: if the honest fix for a
documentation finding would touch an executable line, the item is left unfixed
and reported rather than quietly becoming a code change wearing a documentation
label.

Note the version coupling. Autofix selects threads by parsing the
Conventional-Comment label off each posted comment, so `autofix: docs` finds
threads only when the reviewer that posted them minted the documentation label.
A repo needs a `review` release carrying that label **installed** before this
scope does anything; against an older reviewer it is not broken, it is simply
always empty.

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

### Degrading when there is no fingerprint (the normal case)

If the reviewer's review carries no diff fingerprint, the file-level check
cannot run. Autofix **degrades rather than refusing**, and says so in the
summary.

This is not an edge case. gh-aw's safe-output ingest strips every XML/HTML
comment before a review posts (`removeXmlComments` in
`sanitize_content_core.cjs`), so the reviewer's hidden stamp is deleted on the
way out and has never reached a posted review; Khan/actions#287 documents it end
to end and gives the reviewer a second carrier in its cache-memory record. That
carrier is not reachable from here, because cache memory is scoped per workflow
and autofix is a different workflow. So the per-thread anchor check is what
autofix actually runs on, and the fingerprint branch is the optimisation.

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
  `GITHUB_TOKEN`, so a push made with it emits no `synchronize` and the reviewer
  is never even asked to re-review. With the bot token it is asked; see
  [Verification is best-effort](#verification-is-best-effort) for what that does
  and does not guarantee.

### Repository setup

Create the labels you want (`autofix: blocking`, `autofix: nits`,
`autofix: docs`) if you want the label surface; the `/autofix` command needs no
setup, and an uncreated label simply cannot be applied. Nothing else is
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
`github.event.pull_request`, so the fork guard cannot be evaluated in the `if:`
at all; it moves into the plan, after the agent job has started. An `/autofix`
on a fork PR the label path would have rejected for free still costs a job.

It is instead enforced in `plan.ts`, from the staged `context.json`, on every
path rather than only the command one. A duplicated guard is cheap; a missing
one authorises a code push.

### `skip-ai-review` does not disarm autofix

Deliberately. That label stops the reviewer's *next* run; it does not withdraw a
review already posted, so a labelled PR can still be carrying current findings.
The reviewer even suggests the label from inside a review body it just posted, so
that state is one the workflow steers people into. An explicit `autofix:` label
or `/autofix` from someone with write access is the authorisation to act on those
findings, and the earlier gate swallowed it silently.

The case that gate was justified by ("no review, so nothing to fix") is real and
still covered, by the review-currency guard that actually checks for a review.

Revisit when autofix runs automatically rather than only when a human arms it:
that is when a push nobody asked for becomes possible, and autofix should then
get its own opt-out rather than borrowing the reviewer's.

The gate that actually matters is unaffected: gh-aw's `roles` check still runs,
compiling to an `author_association` test against `OWNER`/`MEMBER`/
`COLLABORATOR`, so a comment from someone without write access never reaches the
agent. That is the gate standing between a drive-by comment and a code push.

**`/autofix` only works from the default branch.** `issue_comment` is a
repository-level event, so GitHub reads the workflow from the default branch and
never from a PR head. An install that exists only on a branch cannot be driven
by the command at all; the label is the only surface available to it.

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

Code decides; the model edits. Two deterministic stages run before the agent is
asked to change anything:

- **`lib/stage.ts` runs as a `pre-agent-steps:` step**, before the agent starts,
  and fetches everything the plan needs (labels, the reviewer's unresolved
  threads with their full reply chains, prior reviews, the diff, commit
  messages, the head SHA). It costs zero assistant turns, and a staging failure
  fails the step before any AI credits are spent. This follows the reviewer's
  own orchestrator slice 1 (Khan/actions#280): anything that never needed model
  output belongs in a pre-agent step.
- **`lib/plan.ts`** then resolves the scope, checks currency, builds the work
  list, and renders the trailer. The plan is final —
the prompt's contract is to execute it or stop, never to widen it, narrow it, or
re-classify a skipped thread. Nothing in `lib/` composes a sentence about the
code under review.

## Versioning

`autofix.md` pins `Khan/actions` at `autofix-v<version>` in both its
`pre-agent-steps` checkout and its `source:`, so prompt and code always come
from one release. `utils/sync-workflow-versions.ts` rewrites those literals
during the release; `version-sync.test.ts` fails CI if they ever drift from the
package version.
