---
name: review-trial
description: Run a seeded-defect live trial of the PR review workflow, comparing reviewer arms on isolated copies of one seeded PR (the Khan/webapp#40678 pattern). Use when evaluating an architecture-class review change, a re-review/lifecycle behavior change, or ground-truthing before graduating a repo to automatic mode. Invoke with a consumer repo, a seeded branch, a defect table, and an arms list.
---

# Seeded-defect live trial

Choreograph the trial pattern from Khan/webapp#40678: one human-seeded PR,
copied into isolated PRs so each reviewer arm reviews identical content
without seeing another arm's comments, optionally driven through a re-review
lifecycle, then scored defect by defect and exported into the eval corpus.
This is the playbook's architecture-bet instrument; per-change evals belong to
the corpus A/B (`workflows/review/eval/live-ab-plan.md`), not to this skill.

## What stays human

Do NOT author seeds or ground truth yourself. The operator supplies both; a
model authoring its own seeds would grade its own homework. If either is
missing, stop and ask; do not improvise a defect table from the branch diff.

## Required inputs (collect all before doing anything)

1. **Consumer repo** (e.g. `Khan/webapp`) and the **seeded branch** in it.
2. **The defect table**: one row per seed with `key`, `path`, an approximate
   line window, `mechanism` (2-4 keyword/regex alternates describing the
   causal defect), intended severity, and any deliberate non-defect traps
   (rows the reviewers must NOT flag, with the exculpating evidence named,
   e.g. "the wrapper chunks DeleteMulti; see internal/datastore/client.go").
3. **The arms**: for each, a name plus its reviewer source, one of:
   - `repo-default`: whatever reviewer the consumer repo already runs.
   - `workflow @ <ref>`: the shared review workflow pinned to a tag/branch
     (a candidate build or a prior release).
   - `hosted`: the Claude Code GitHub app review (`@claude review`).

   A `workflow` arm may also carry a **ROUTING override**: extra or changed
   lines for the arm branch's `.github/aw/review/ROUTING`. This is how the
   re-review mode dial is priced; two arms at the SAME ref, one with
   `re-review full` (control) and one with `re-review scoped` (or
   `flip-gated`/`fast`), differ only in the mode line, so the lifecycle
   tables isolate the dial's recall and dollar deltas.
4. **Lifecycle plan** (optional): the push-2 content (fixes mixed with fresh
   seeds, plus their defect-table rows) and the push-3 content (everything
   fixed). If the plan means to exercise **open-thread suppression**, it must
   leave at least one finding unfixed: a push where the fixer repairs
   everything lets the reconciler resolve every thread, `threads.json` comes
   back empty, and suppression has nothing left to suppress, so the round
   proves nothing about it either way.
5. **Budget approval**: project the cost FIRST and confirm. Project in the
   units the cap enforces: the firewall api-proxy's credit meter
   (`ai_credits_this_response` sums in the run's token-usage log), NOT the
   run-summary "AI credits" figure, which reads ~2.5x lower. Measured basis:
   a full-depth, full-roster run of the memory-expiration shape meters
   1,050-1,077 proxy credits (~$10.50); total is arms x (1 + lifecycle
   pushes), hosted-arm runs billed separately by the app. Print the
   projection and get an explicit yes before creating any PR.

## Step 1: isolated arm PRs

Each arm is TWO branches and TWO PRs (the trial3 preview pattern):

- A **scaffolding branch** cut from the seeded content's parent commit. It
  carries everything trial-specific: the arm's compiled workflow, any
  ROUTING override, and the removal of competing reviewer surfaces (below).
  Open a scaffolding PR against the default branch (title prefixed
  `[reviewer-trial]`, body disclosing the trial, the repo's opt-out label,
  e.g. `skip-ai-review`, applied); it exists for review/audit only and is
  closed unmerged.
- A **content branch** stacking the operator's seeded commits on the
  scaffolding, with its PR based on the scaffolding branch, so the diff
  under review is ONLY the seeded change.

**The arm PR must look like a real PR.** The reviewer reads the PR title
and description (`pr-context.json`), so a `[reviewer-trial]` prefix, a
body describing the trial, or any mention of seeded defects taints the
run. Give the arm PR the seeded change's own realistic title and body
(reuse the prior trial PR's body verbatim when replicating); the trial
disclosure lives on the scaffolding PR and in the closing comment only.
One PR per arm; never point two arms at the same PR, or their comments
contaminate each other.

Per-arm trigger setup:

- `repo-default`: nothing extra; the repo's reviewer triggers normally.
- `workflow @ ref`: commit the compiled workflow for that ref onto the
  scaffolding branch, under a **fresh lock filename per trial** (e.g.
  `review-preview-v1-9-0.lock.yml`, not a reused `review-preview.lock.yml`).
  GitHub's workflow registry keys the display name to the file PATH and keeps
  the stale one: two consecutive trials that reused one filename both showed
  up in the Actions list as "PR Reviewer" while the files on the branches
  declared "PR Reviewer Preview v1.8.0" and "...v1.9.0". Nothing about
  concurrency broke (the groups were distinct, and the production workflow
  recorded zero runs on either branch), but a run list that names every arm
  after the production reviewer is unreadable and invites exactly the "did
  production just run?" scare the naming rule exists to prevent.
  **Give it a workflow name distinct from the repo's
  own reviewer and from every other arm**: same-named gh-aw workflows share
  a per-PR concurrency group and silently cancel each other (this ate a run
  in the original trial). Its `if:` must exclude the scaffolding branch
  itself (`head.ref != '<scaffolding branch>'`), so the scaffolding PR
  burns no credits. **Replicate the trial credit cap**: set
  `max-ai-credits: 2500` and the `REVIEW_MAX_AI_CREDITS: "2500"` env mirror
  in the arm workflow; the shared default of 1000 sits BELOW the
  proxy-metered cost of a full-depth, full-roster run (1,050-1,077 measured
  on the memory-expiration shape), and a capped run dies mid-tail with the
  review emitted but the cache record and artifact upload unfinished.
- `hosted`: trigger with an `@claude review` comment after suppression.

**Suppressing every other reviewer: do NOT label the arm PR.** The shared
review workflow carries the same opt-out label gate as the repo's installed
reviewer, so the repo's documented opt-out label (`skip-ai-review` in Khan
repos) skips the TRIAL arm too (observed: 2-second skipped runs). Instead,
remove the competing surfaces from the scaffolding branch so they are absent
from the PR's merge ref: the repo's installed reviewer workflow files AND
any pull_request-triggered shim that posts the reviewer's slash command
(webapp's `review-kore-prs.yml` auto-posts `/review`, which launches the
PRODUCTION reviewer from the default branch onto the trial PR). Note the
limit: command-triggered workflows execute from the default branch, so file
removal cannot stop a human typing the slash command; the shim removal
plus nobody commenting is the actual protection.

Draft PRs generally do not trigger reviewers; open the PRs ready-for-review.

## Step 2: run and collect

For each arm: trigger, then watch to completion (`gh run watch` /
`gh pr checks`). Collect, per run:

- The posted review: verdict, every inline comment (path, line, body), and
  the review body (`gh api` on the PR's reviews and review comments).
- Run artifacts when the arm is the shared workflow (findings, claims,
  verdict JSONs): `gh run download`. Tolerate the known gh-aw staging-path
  artifact bug (an ERR_VALIDATION annotation; the artifacts still upload).
- Cost and wall clock: billed AI credits from the run summary, run duration
  from `gh run view`. Hosted-arm cost is app-billed; record it as opaque
  unless the operator supplies it.

Record everything into a working directory as you go; a trial that loses its
transcripts cannot be scored or exported.

## Step 3: lifecycle (when the plan includes it)

Push the operator's push-2 content to EVERY arm branch (identical commits),
let each arm re-review, and collect again; repeat for push-3. Score each push
separately: re-review behavior (thread resolution, duplicate suppression,
scoping to new hunks) is half the point of the lifecycle.

**Never force-push a trial branch between rounds.** Every push after the first
review is forward-only; rebase, squash, or re-parent the stack BEFORE the first
arm reviews it. The reason is measurement integrity, not correctness: a round
that cannot anchor on a prior fingerprint reports `stampSource: null` in
`out/rereview-plan.json` and executes `depth: full` with `staging: whole-diff`
even where ROUTING says `scoped`, which is visually indistinguishable from a
genuine carrier gap and silently voids the scoped-cost sample that round was
supposed to produce. `stampSource` in that artifact is the authoritative answer
to "did this round anchor?"; read it every round rather than inferring the
carrier state from the shape of the push, and discard scoped-cost samples from
any round that did not anchor.

The carrier internals below explain why a rebase is usually the wrong suspect,
but they are incidental properties of today's implementation rather than
contracts, so do not reason from them in place of the artifact. As of 2026-07:
the hunk signature is content-hashed over each hunk's added and removed lines,
so SHA rewrites and shifted line numbers do NOT move it
(`workflows/review/lib/rereview-mode.ts`), and the cache record's `commitSha`
is written but never read back. On that basis a rebase alone should not refuse
the carrier, and what actually loses the anchor is losing the RECORD (cache
eviction, or a credit-capped run that died before Step 9 wrote it); a
force-pushed round is exactly the round where that goes unnoticed and gets
blamed on the rebase. If a future change starts validating `commitSha` on
restore, this paragraph is what goes stale, not the `stampSource` rule above.

**A closed trial PR is usually a cheaper source of the round you need than a
new lifecycle.** Before building a two-run push-2, check whether a previous
trial already left the shape lying around: a CLOSED PR whose last round's
comments are still unresolved is a partially-fixed round waiting to be
resumed, because its findings were never addressed. webapp#41204 was reopened
this way to get the round that made open-thread suppression fire in production
for the first time (run 30650642317: six threads kept, six suppressions,
REQUEST_CHANGES floored by the suppression floor alone), which the plan had
budgeted two runs for and got in one.

Control the run count through the events, not through hope. On a closed PR no
`pull_request` event fires at all, so pushes are free; `reopened` IS in the
reviewer's trigger list, so reopening fires exactly one run; and pushing to an
already-open PR fires `synchronize`, which is one more run each time. The
sequence that costs a single run is therefore: push the fixture state while the
PR is still closed, adjust thread resolution, then reopen. Unresolving a thread
is a GraphQL mutation (`unresolveReviewThread`) that an agent's tooling may
refuse; hand it to the operator rather than working around it.

**Fault injection: keep it out of the diff under review.** Exercising a
fail-open reporter by deliberately mis-staging works (run 30654454047 tripped
`threadSuppressionUnavailable` with `unusableThreads: 9` by telling the
orchestrator to omit `resolved`), but if the injection edits the prompt or lock
file ON the trial branch, that edit becomes the newly-changed code: every one
of that run's five candidates landed on `review-preview.md` and none on the Go
fixture, so the reporter fired while the duplicate re-posting it warns about
went unobserved, and the reviewers spent the round flagging the injected prose
as blocking (correctly: it reads as instructions aimed at the agent). Land the
injection in the same push as the fixture change you want re-reviewed, or force
full depth, and expect the injected text itself to draw findings.

When an arm runs a reduced re-review mode (`re-review` in ROUTING), also
record per push: the executed depth and tripwire fields from the run's
`out/rereview-plan.json` artifact, and the billed cost, so the report can
price depth against recall. If the lifecycle plan includes an adversarial
push (a rewrite-after-approval or a payload onto a sparse PR; the
`eval/lifecycle/` cases), score it as: the tripwire re-armed AND the payload
got a full review; a reduced-mode arm that approves such a push without
re-arming has failed the trial whatever it cost.

## Step 4: score

Match each arm's posted comments against the defect table, per push:

- Deterministic first: same path, line within (or overlapping) the window,
  and any mechanism alternate matching the comment text, case-insensitively.
  This mirrors `workflows/review/eval/live-match.ts`; one comment satisfies
  at most one seed.
- Ambiguous leftovers: judge manually, and mark judged matches in the report
  so a reader can audit them.
- Non-defect traps: a comment matching a trap row is a false flag; silence
  on a trap is correct suppression and counts FOR the arm.

Produce the #40678 report shape: a headline table (seeds caught, verdict,
comment count, cost, wall clock, per arm), a defect-by-defect table (one row
per seed, one column per arm), a lifecycle table when applicable, and a short
writeup naming where each margin came from. Report faithfully: misses,
wrong severities, and noise comments all go in, whichever arm they favor.

## Step 5: export to the corpus

Every trial compounds the corpus. Emit case skeletons in the live-enabled
format (`workflows/review/eval/corpus/`, layout `<id>/case.json` + `tree/`;
format spec in `corpus/live.ts`): the seeded diff, the post-change tree,
`live.mustCatchSpecs` straight from the defect table, traps as
`mustNotFlagSpecs` on a clean case, and recorded findings taken from the
best arm's artifacts.

**Sanitization gate**: if the consumer repo is private and the corpus repo
public (Khan/webapp into Khan/actions is exactly this), never copy code,
paths, or identifiers. Author structural rewrites that reproduce each
defect mechanism with generic naming, the way the #40678 seeds landed in
Khan/actions#235. When in doubt, rewrite.

## Step 6: clean up

Close every trial PR with a comment linking the report, delete the
`trial/<slug>/*` branches, and confirm no temporary workflow file survived
onto a long-lived branch. Leave the collected transcripts with the operator
(attach the report to the PR or issue that motivated the trial).

One exception, and it is the reason the closed-PR shortcut above works: keep a
branch whose round you expect to resume, and then leave it in a state someone
can reopen safely. Revert every deliberate fault on it (reintroduced defects,
mis-staging injections) in the same pass that closes the PR, and put the
resumable state in the closing comment: which threads are still unresolved,
which run IDs the round produced, and what a reopen would trigger. A surviving
trial branch that still carries a planted panic or a prompt injection is a trap
for whoever reopens it, and the reopen fires a review immediately.

## Guardrails (recap)

- Costs projected and approved before the first PR exists.
- Seeds and ground truth are operator-authored, always.
- One arm per PR; distinct workflow names; a fresh lock filename per trial;
  exactly one reviewer per PR.
- Forward-only pushes once a round has been reviewed; no force-pushes mid-trial.
- Read `stampSource` from every round's plan artifact; scoped-cost samples from
  non-anchored rounds are void.
- Budget runs by counting the events a step fires (`reopened` and `synchronize`
  each cost one review; a closed PR fires none), not by counting pushes.
- Any branch that outlives its PR is reverted to a safe state, with the
  resumable details in the closing comment.
- Score before cleanup; export before cleanup; never lose transcripts.
- Faithful reporting, including the arm you expected to win losing.
