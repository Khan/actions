# Plan: live A/B evals for review-bot changes

Status (2026-07-09): Phase 1 implemented in Khan/actions#233 (draft) except the
trial-case port, which runs as a follow-up on top of it; this plan doc is
Khan/actions#232. Phases 2a/2b (prompt extraction, case staging) are
Khan/actions#234, stacked on #233; phase 2c (model dispatch) and phases 3 to 5 not
started. Each phase is scoped so a separate
agent can execute it with only this document plus the repo. Phases 1 and 2 are
independent of each other; Phase 3 needs both; Phase 4 needs Phase 3; Phase 5 (the
trial-runner skill) is independent of all of them.

## Context

The review workflow (`workflows/review/review.md` plus `workflows/review/lib/`) has an
eval harness (`workflows/review/eval/`) that today is entirely deterministic: corpus
cases carry **recorded** model findings and validator verdicts, and the runner replays
only the code half of the pipeline (routing, provenance gate, scope filter, validation
apply rules, verdict, rendering). This gates every PR via `pnpm test` and is good at
catching regressions in `lib/`, but it is structurally blind to prompt and model
changes: a `review.md` edit produces bit-identical eval results.

The "Review agent, round two" design doc
(https://claude.ai/code/artifact/1d674d29-297c-4f60-b6d5-665cf202a97b; its round-one
predecessor "Improving the review agent" is
https://claude.ai/code/artifact/367b68e3-c077-459d-8b37-2fe092427c97) defines an eval
playbook in which behavior-shifting prompt changes require "full suite before/after on
all four datasets; the five metrics compared arm to arm", and cost-affecting changes
additionally require measured dollars and wall clock. That machinery does not exist
yet. The decision (2026-07-09) is to build it: **changes to the review bot are
infrequent enough to justify real LLM calls on every change, diffed arm-to-arm against
the prior version in the same CI run.**

The intended end state: a PR touching `workflows/review/**` triggers a workflow that
runs the model sub-agents from both the merge-base version and the PR version of
`review.md` over the same live-enabled corpus subset, scores both arms with the
existing metrics/gates/judge, and posts a delta report on the PR. Report-only at
first (except the adversarial hard gate, which fails the job outright, per the
playbook's standing rule); gating thresholds are a later human ratification (doc Q1/Q5).

## Existing surfaces to build on (do not reimplement)

- `eval/runner.ts`: `runCase(corpusCase, options)` already accepts
  `options.produceFindings: (corpusCase) => RecordedFinding[]`. This is the designed
  seam for a live arm; the entire downstream pipeline (provenance gate, scope filter,
  validation replay, verdict, rendering) stays identical.
- `eval/corpus/loader.ts`: `CorpusCase` type, `parseCase`, `loadCorpus`,
  `filterByTag`, and an injected-fs seam (`LoaderFs`) that keeps the loader testable
  with memfs. Cases already support an optional `diff` (unified diff text) and
  `routerConfig`.
- `eval/metrics.ts` (`computeMetrics`: must-catch recall, golden precision, clean
  false-block, noise, calibration) and `eval/gates.ts` (`evaluateGates`,
  `checkExpectation`, adversarial hard gate, overfitting split).
- `eval/judge.ts`: pure judge core with an injected `JudgeModel`;
  `PINNED_JUDGE_MODEL = "claude-opus-4-8"`. `eval/live-judge.ts` is the existing live
  implementation (plain `fetch` to the Messages API) and the pattern for API access.
- `workflows/review/lib/finding-schema.ts`: `FINDING_SCHEMA_VERSION = 2`,
  `validateFinding` / `assertFinding`, `Finding` type (requires `failure_scenario`,
  `evidence_trace`, `producing_hunt`, etc.).
- `workflows/review/lib/router.ts`: `route({files}, routerConfig)` picks lenses per
  case deterministically.
- Sub-agent definitions live in `review.md` as `## agent: \`name\`` sections, each
  with YAML frontmatter (`name`, `description`, `model`, effort comment) followed by
  the prompt body. There are 21 as of 2026-07-09 (list them with
  `grep -n '## agent:' workflows/review/review.md`). Production sub-agents read staged
  files from `/tmp/gh-aw/review/` (`pr.diff`, `pr-context.json`, `review-files.json`)
  and the repo checkout; they have no GitHub access and return JSON findings.
- CI: `.github/workflows/node-ci.yml` runs `pnpm run test --run` per PR;
  `.github/workflows/review-eval-full.yml` is the weekly live-judge job and the
  pattern for secret handling (skip gracefully when `ANTHROPIC_API_KEY` is absent).

## Settled design decisions

1. **Same-run A/B, not stored baselines.** The baseline arm's prompts come from
   `git show <merge-base>:workflows/review/review.md`; the candidate arm's from the
   working tree. No persisted metrics history, no judge drift between runs, exact
   attribution.
2. **The corpus and the deterministic pipeline come from the candidate (PR head) for
   both arms.** The live A/B isolates the model-behavior seam (prompts, models,
   effort); `lib/` changes are already covered by the deterministic suite's
   expectations. Full-tree-per-arm A/B is reserved for architecture-bet experiments
   and is out of scope here.
3. **Live sub-agents run as bounded agentic loops, not single completions.**
   Production reviewers investigate (read files, grep) before finding; a
   one-shot completion would measure a different reviewer. Use the Claude Agent SDK
   (TypeScript, `@anthropic-ai/claude-agent-sdk`) with tools restricted to
   Read/Grep/Glob, cwd pinned to the case's staged tree, no network, per-agent model
   pinned from the `review.md` frontmatter, and a hard `maxTurns` cap.
4. **Live findings are matched to labeled defects by anchor and mechanism, not by
   id.** Recorded cases correlate `expected.mustCatch` with finding ids, but a live
   model chooses its own ids. Live-enabled cases therefore carry labeled defect
   specs (path, line window, mechanism keywords) and a matcher maps produced findings
   onto them (Phase 1 defines the schema, Phase 3 the matcher).
5. **Report-only, except the adversarial hard gate.** The job fails only if the
   candidate arm mishandles an adversarial-injection case or produces no scorable
   output. Metric deltas, judge deltas, and costs are reported for humans until
   thresholds are ratified.
6. **Budget guardrails are code, not convention.** Case-count cap, per-agent
   turn/time caps, and a per-run USD ceiling that aborts before dispatching work that
   would exceed it. A run that dies at a cap must still emit a partial report (the
   doc's standing rule: dying at the ceiling with nothing posted is the worst
   outcome).
7. Follow repo conventions: pnpm, vitest, eslint/prettier, changesets (each phase's
   PR includes a changeset for the `review` package), no GitHub writes from eval code
   except the Phase 4 workflow's PR comment.

## Phase 1: live-enabled corpus cases

> Status: shipped in Khan/actions#233 except the trial-case port (the
> Khan/webapp#40690 cases), tracked as a follow-up PR on top of #233. Notes for
> whoever touches this next: the live half of the format lives in
> `corpus/live.ts` (the loader re-exports it; `loader.ts` sits near its
> 1000-line lint cap), and case anchors were REWRITTEN to the authored defect
> lines rather than padding files to the old synthetic line numbers.

**Goal:** enough corpus cases carry the real change content for a model to review.
Today only `smoke/provenance-pre-existing-dropped.json` has a `diff` (331 bytes); no
case carries file contents.

**Schema work** (in `eval/corpus/loader.ts`, keeping `parseCase` strict and the
memfs seam intact):

- Add an optional `live` block to the case schema:
  - `live.prContext`: `{title, description, author, baseBranch}` (description is
    untrusted author text, same as production).
  - `live.tree`: relative path to a directory of post-change file contents (the
    "checkout" the sub-agents read). Convention: live-enabled cases move from
    `corpus/<dataset>/<id>.json` to `corpus/<dataset>/<id>/case.json` with a sibling
    `tree/` directory; the loader treats both layouts as valid.
  - `live.mustCatchSpecs`: array of labeled defects, each
    `{key, path, lineStart, lineEnd, mechanism, lens?}` where `mechanism` is a short
    list of keyword/regex alternates describing the causal defect (used by the Phase 3
    matcher, and by a human reading a miss report). Clean cases may instead carry
    `live.mustNotFlagSpecs` with the same shape for known traps (e.g. the Datastore
    DeleteMulti wrapper case from the seeded-defect trial).
  - Require `diff` to be present and non-empty whenever `live` is present.
- Tag live-enabled cases `"live"`; add `LIVE_TAG` and a `loadLiveCorpus()` helper
  mirroring `loadSmokeCorpus()`.
- Validation rules: every `mustCatchSpecs` path must appear in `changedFiles` and in
  the diff; reject a `live` case whose tree is missing a file named in the diff.

**Case authoring** (target: 10 live cases; quality over quantity):

- Port the seeded-defect trial PR (the webapp ai-guide memory-retention feature):
  the nine real seeded defects become one or two incident-repro live cases (split if
  the diff is large), and the Datastore operation-cap non-defect becomes a clean
  must-not-flag case. Source material: Khan/webapp#40678 documents the trial
  (defect-by-defect table, lifecycle pushes); the isolated arm PRs are #40682 (old
  prompt), #40690 (new stack; the copy whose transcripts pair with this repo's
  prompts), and #40699 (hosted review). The second lifecycle push carries three more
  fresh seeds worth a second case.
- Hand-author minimal real diffs plus trees for a subset of existing smoke cases
  whose recorded findings imply an obvious concrete change:
  `incident-money-rounding`, `incident-auth-bypass`, `incident-cache-missing-key`,
  `incident-race-condition`, `incident-sql-missing-index` (5 incident cases),
  `clean-typed-refactor` (clean), and one adversarial-injection case where the diff
  or PR description carries the injection payload (adversarial cases MUST be live:
  injection resistance is a model property). Keep each tree small: the changed files
  plus only the context files a reviewer genuinely needs.
- Existing recorded fields (`findings`, `validation`, `expected`) stay untouched, so
  every live case still runs in the deterministic suite exactly as before.

**Acceptance criteria:**

- `pnpm run test --run` stays green (the deterministic suite must not notice).
- New loader unit tests cover the `live` block parsing, both layouts, and the
  validation rules, via memfs.
- `loadLiveCorpus()` returns >= 10 cases spanning incident-repro, clean,
  adversarial-injection, and at least one golden or synthetic-mutation case.
- A changeset (minor, `review` package).

## Phase 2: the live producer

**Goal:** given a live-enabled `CorpusCase` and a `review.md` file, run the real
sub-agent roster over the case's change and return schema-valid findings, validator
verdicts, and per-agent cost/wall-clock. New files under `workflows/review/eval/`.

**2a. Prompt extraction** (`eval/agent-extract.ts` + unit tests):

- Parse `review.md` into sub-agent definitions: split on `^## agent: \`(.+)\`$`,
  parse the YAML frontmatter (`name`, `description`, `model`), keep the body as the
  prompt. Return `Map<name, {model, prompt}>`. Fail loudly on a section with missing
  or malformed frontmatter. Must work against an arbitrary `review.md` string (Phase 3
  feeds it the merge-base version), so no direct fs reads in the core function.

**2b. Case staging** (`eval/live-stage.ts` + unit tests):

- Materialize the production file layout in a temp dir per case:
  `<staged>/context/pr.diff`, `<staged>/context/pr-context.json`,
  `<staged>/context/review-files.json` (derive from `changedFiles`, include the
  `hasPatch` field the provenance CLI expects), and `<staged>/checkout/` copied from
  the case's `live.tree`. Rewrite the literal `/tmp/gh-aw/review/` paths in each agent
  prompt to the staged context dir (string replacement; add a test that the
  production path constant appears in extracted prompts so a future rename is
  caught).

**2c. Dispatch** (`eval/live-producer.ts`):

- Roster per case: `route({files: changedFiles}, routerConfig)` picks the lenses;
  always include `correctness-reviewer` and `skill-auditor`; include `pattern-triage`
  only if routing asks for it; never `thread-reconciler` (no threads exist in eval).
- Run each sub-agent via the Agent SDK: `allowedTools: ["Read", "Grep", "Glob"]`,
  `cwd: <staged>/checkout`, model from frontmatter, `maxTurns` cap (start at 30),
  a wall-clock timeout per agent (start at 5 min), no network. Capture token usage
  and computed USD per agent from the SDK result.
- Parse the agent's final JSON output; validate every finding with
  `validateFinding`. On malformed output, retry once with the validation errors
  appended; a second failure records the agent as failed for that case (partial
  results are kept, the failure is reported, the run continues).
- After findings are produced, dispatch `claim-validator` live with the produced
  findings as its claims (stage them the way production does; read the validator's
  section of `review.md` for the exact input contract before implementing). Parse its
  three-state verdicts into the `CaseVerification[]` shape `applyValidation`
  consumes.
- Public API:
  `produceLive(corpusCase, agents, opts) => Promise<{findings: RecordedFinding[], validation: CaseVerification[], perAgent: {name, model, usd, wallMs, turns, failed}[]}>`.
- Concurrency: cases sequential by default, sub-agents within a case parallel with a
  small cap (4); make both configurable.

**Acceptance criteria:**

- Extraction and staging fully unit-tested (no network in tests; the dispatch layer
  takes an injected runner so tests stub the SDK, mirroring how `judge.ts` stubs its
  model).
- A manual smoke script (`pnpm dlx tsx workflows/review/eval/live-producer.ts
  --case <id>`) runs one live case end to end with a real key and prints findings,
  validation, and cost. Document measured per-case cost in the PR description.
- A changeset (minor).

## Phase 3: the A/B runner and delta report

**Goal:** one entry point that runs both arms over the live corpus and emits the
comparison. New file `eval/live-ab.ts` (plus `eval/live-match.ts` for the matcher).

**3a. Finding-to-spec matcher** (`eval/live-match.ts` + unit tests):

- Deterministic first pass: a produced finding matches a `mustCatchSpec` when its
  anchor path equals the spec path, its line falls within `[lineStart, lineEnd]`
  (file/PR anchors match on path presence alone), and any mechanism alternate matches
  the finding's `failure_scenario` or `model_authored_prose` case-insensitively.
- Ambiguity fallback: when a spec is unmatched deterministically but findings exist
  on the same file, ask the pinned judge model "does finding X describe defect Y"
  (one small call per candidate pair, hard-capped). Record which matches came from
  the fallback so a human can audit them.
- Output per case: which specs were caught/missed per arm, and which produced
  findings matched no spec (the live noise numerator).

**3b. Arm execution:**

- Arms: `baseline` = `git show <base>:workflows/review/review.md` (where `<base>` is
  `--base-ref`, defaulting to `git merge-base HEAD origin/main`); `candidate` = the
  working-tree `review.md`. Everything else (corpus, `lib/`, runner, metrics, judge)
  comes from the working tree for both arms (settled decision 2).
- Per arm, per case: `produceLive(...)` then
  `runCase(corpusCase, {produceFindings: () => live.findings})` with the live
  `validation` substituted for the recorded one (extend `RunOptions` with an optional
  `validation` override; trivial runner change, keep it backward-compatible).
- Score: live-metric variants of recall/precision/noise computed from the matcher
  output (`computeMetrics` keys on recorded ids, so add
  `computeLiveMetrics(runsWithMatches)` in `live-match.ts` or `metrics.ts` rather
  than forcing id equality); `evaluateGates` semantics for the adversarial cases
  (candidate arm must meet each adversarial case's expected verdict and catches
  outright); judge both arms' posted comments with the existing `judgeCorpus` +
  the `live-judge.ts` fetch model (extract that fetch model into a shared module
  rather than duplicating it).
- Budget: `--max-usd` (default 40): estimate before each case dispatch from measured
  running average; when the next case would exceed the cap, stop dispatching, mark
  remaining cases skipped, and still emit the report with a loud SKIPPED section.

**3c. Report:**

- `out/live-ab-report.json`: full structured result (per-arm metrics, per-case
  catches/misses/noise, judge aggregates, per-agent costs, wall clock, skipped
  cases, arm prompt hashes, base/head SHAs).
- Markdown rendering (also written to `GITHUB_STEP_SUMMARY` when set): a five-metric
  arm-to-arm table with deltas, judge meanQuality and verdict-count deltas,
  total and per-case USD per arm, a regression list (any spec the baseline caught
  and the candidate missed, and vice versa), adversarial gate status, and matcher
  fallback audit notes.
- Exit code: 0 normally; 1 when the candidate arm fails the adversarial hard gate,
  produced no scorable output, or the run aborted before scoring any case.

**Acceptance criteria:**

- Matcher and report rendering unit-tested with stubbed producers/judges.
- A full local run over the Phase 1 corpus with a real key completes under the
  default budget and the report is legible; attach it to the PR.
- A changeset (minor).

## Phase 4: CI wiring

**Goal:** `.github/workflows/review-eval-ab.yml`.

- Triggers: `pull_request` (types: opened, synchronize, reopened, ready_for_review)
  with `paths: [workflows/review/**]`, plus `workflow_dispatch` with `base_ref` and
  `max_usd` inputs.
- Guards: skip drafts; skip with a notice when `ANTHROPIC_API_KEY` is empty (copy the
  pattern from `review-eval-full.yml`; fork PRs get no secrets and must not fail);
  `concurrency: {group: review-eval-ab-${{ github.event.pull_request.number }},
  cancel-in-progress: true}` so a new push supersedes a running A/B. Skip entirely
  when the PR carries a `skip-live-eval` label. Note the round-two doc's warning:
  live arms must use a distinct workflow name (same-named workflows share a gh-aw
  concurrency group and cancel each other); `Review Eval A/B` is distinct from
  everything existing, verify before merging.
- Job: checkout with `fetch-depth: 0` (merge-base needs history), shared node cache
  action (`./actions/shared-node-cache`), run
  `pnpm dlx tsx workflows/review/eval/live-ab.ts --base-ref origin/${{ github.base_ref }}`,
  upload `out/live-ab-report.json` as an artifact, and post/update a single sticky
  PR comment with the markdown report (permissions: `pull-requests: write`; find the
  prior comment by a hidden HTML marker, edit instead of stacking).
- Scope control: default runs the live smoke subset (cases tagged both `live` and
  `smoke`); a `full-eval` label on the PR runs every live case.
- The changeset-release PR ("Version Packages") matches the path filter because
  changesets touch package files; exclude it by branch name
  (`changeset-release/main`), it changes no behavior.

**Acceptance criteria:**

- A test PR touching only a comment in `review.md` produces a near-zero-delta report
  comment; a test PR deliberately weakening a reviewer instruction shows a recall
  regression in the report. Include both run links in the PR description.
- Non-Khan forks and secretless runs skip green.
- A changeset (patch is fine; the workflow file is repo CI, but the plan doc and any
  eval code touched ride along).

## Phase 5: a trial-runner skill for seeded live-PR evals

**Goal:** turn the Khan/webapp#40678 trial pattern (isolated copies of one seeded
PR, each reviewed by a different arm of the real production workflow, lifecycle
pushes, defect-by-defect scoring) from a hand-choreographed week into a Claude Code
skill an operator invokes in an afternoon. Independent of Phases 1 to 4; lives in
this repo as `.claude/skills/review-trial/SKILL.md` (agent-facing instructions plus
any helper scripts), since the trial choreography belongs to the workflow's owners
even though a given trial runs in a consuming repo.

What stays human: authoring the seeded branch and the ground-truth defect table
(seed quality is the whole value of a trial; a model authoring its own seeds would
grade its own homework). Everything after that is choreography the skill automates:

1. **Setup.** Input: a seeded branch in the consuming repo, the defect table
   (key, file, mechanism, the same shape as `mustCatchSpecs`), and the list of
   arms (e.g. a pinned prior release tag, the candidate branch's workflow, the
   hosted reviewer). For each arm, create an isolated copy of the seeded branch as
   its own draft PR so no reviewer sees another's comments, and (for workflow arms)
   point that copy's review workflow at the arm's version. Guard from the round-two
   doc's operational floor: live shadow arms need DISTINCT workflow names, because
   same-named workflows share a gh-aw concurrency group per PR and cancel each
   other.
2. **Run and collect.** Trigger each arm's review, wait for completion, then pull
   the run artifacts (findings, claims, verdict, safe outputs) and the billed
   cost/wall clock per run. Support the lifecycle protocol: optional scripted
   second and third pushes (fixes plus fresh seeds, then everything fixed) with a
   re-review per push.
3. **Score and report.** Match posted comments against the defect table (reusing
   the Phase 3 matcher once it exists; manual-assisted matching until then),
   produce the defect-by-defect arm table, verdict/comment/cost summary, and
   lifecycle economics, in the #40678 report format.
4. **Export and clean up.** Emit corpus case skeletons from the trial (diff, tree,
   specs pre-filled; recorded findings from the winning arm's artifacts) so every
   trial feeds Phase 1's corpus, then close the trial PRs and delete the branches.

Acceptance: re-running the #40678 trial via the skill reproduces its table with an
afternoon of operator time, and the skill's output includes ready-to-review corpus
case directories. Cost expectation per the measured trial: roughly $7 to $10 per
workflow-arm run, times arms, times lifecycle pushes; the skill prints the projected
total and asks before dispatching.

## Relationship to seeded live-PR trials (Khan/webapp#40678)

The corpus A/B this plan builds does NOT replace the seeded-defect trial pattern
(three isolated copies of one seeded PR, each reviewed by a different arm of the
real production workflow, then driven through a re-review lifecycle). The two
instruments measure different layers:

- The live-PR trial exercises everything the corpus A/B deliberately bypasses: the
  orchestrator loop (measured at ~80% of run cost), gh-aw plumbing and safe outputs,
  thread reconciliation and re-review economics, the consuming repo's real ROUTING,
  skills, and checkout, and true production cost/wall-clock. The trial is what
  surfaced the lockfile 1M-context escalation, the budget-death failure mode, and
  the runs-per-PR lever; no corpus replay would have.
- The corpus A/B gives what a one-PR trial cannot: breadth (many cases, five
  categories), repeatability on every change, arm-to-arm isolation of the
  prompt/model seam, precision and false-block measurement (N=1 cannot), and the
  adversarial hard gate.

Cadence: the corpus A/B runs per change (this plan); the live-PR trial is reserved
for architecture-bet-class changes (the playbook's fourth class, e.g. the
deterministic orchestrator), for lifecycle/re-review behavior changes, and as a
periodic ground-truthing before graduating a repo to automatic mode. Every trial
feeds its seeds back into the corpus ("the corpus compounds"), which is exactly how
the ten #40678 seeds enter Phase 1. Phase 5 above packages the trial choreography
as a skill so that cadence is actually sustainable.

## Cost expectations (sanity rail, not a gate)

The round-two trial measured all eleven production sub-agents at under $2 per run on
a real PR, each a single bounded dispatch. Eval cases are smaller than real PRs;
expect roughly $0.30 to $1.50 per case per arm for the default roster, so a
10-case two-arm run lands around $6 to $30 plus judge calls (one small Opus call per
posted comment). If Phase 2's measured numbers depart from this by an order of
magnitude, stop and re-examine (likely a context-staging bug, e.g. an unstripped
generated file; the trial saw exactly that failure mode at $5.81/run).

## Open questions (do not block; note answers in the PRs)

1. Should `pattern-triage` run in the live roster by default, or is router output
   enough? (Start without it; add if a live case's routing visibly suffers.)
2. Threshold ratification for turning report-only deltas into a gate is a human
   decision (round-two doc Q1/Q5); leave the gate report-only until then.
3. Whether the sticky PR comment should also post to the round-two artifact's
   tuning-loop counters is out of scope; the JSON artifact is the interface.
