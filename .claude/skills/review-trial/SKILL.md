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
   fixed).
5. **Budget approval**: project the cost FIRST and confirm. Measured basis:
   roughly $7-10 per workflow-arm run; total is arms x (1 + lifecycle
   pushes), hosted-arm runs billed separately by the app. Print the
   projection and get an explicit yes before creating any PR.

## Step 1: isolated arm PRs

For each arm, create `trial/<slug>/<arm>` from the seeded branch and open a
PR in the consumer repo (title prefixed `[reviewer-trial]`, body stating it
is a trial and will be closed unmerged). One PR per arm; never point two arms
at the same PR, or their comments contaminate each other.

Per-arm trigger setup:

- `repo-default`: nothing extra; the repo's reviewer triggers normally.
- `workflow @ ref`: commit the compiled workflow for that ref onto the arm
  branch. **Give it a workflow name distinct from the repo's own reviewer
  and from every other arm**: same-named gh-aw workflows share a per-PR
  concurrency group and silently cancel each other (this ate a run in the
  original trial). Then suppress the repo's default reviewer on this PR via
  its documented opt-out (`skip-ai-review` label in Khan repos), so exactly
  one reviewer runs per PR.
- `hosted`: suppress the default reviewer the same way, then trigger with an
  `@claude review` comment.

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

## Guardrails (recap)

- Costs projected and approved before the first PR exists.
- Seeds and ground truth are operator-authored, always.
- One arm per PR; distinct workflow names; exactly one reviewer per PR.
- Score before cleanup; export before cleanup; never lose transcripts.
- Faithful reporting, including the arm you expected to win losing.
