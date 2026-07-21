# Review eval system

How to run, extend, and read the evals for the PR review workflow
(`workflows/review/`). This is the operator guide; each module's header
comment is the reference for its internals.

## The three tiers

| Tier | What it measures | Cost | When it runs |
| --- | --- | --- | --- |
| Deterministic suite (vitest) | The pipeline code: router, gates, verdict, rendering, matching, aggregation. Replays recorded findings; no model calls. | $0 | Every push (`pnpm test --run`) |
| Live A/B, smoke subset | One PR's marginal `review.md` delta: real model sub-agents run from BOTH the base branch's and the PR's review.md over live-tagged smoke cases. A tripwire, not a measurement. | ~$10/PR | Every PR touching `workflows/review/**` |
| Powered / scheduled runs | Recall effects, priced with repeats and binomial intervals; run-to-run wobble; cumulative drift vs main. | ~$29-85 | `workflow_dispatch`, weekly cron |

Single-run percentage deltas below the measured noise floor mean nothing
(see "Reading a report" below). Any recall claim needs a powered run.

## Running things

### Deterministic suite

```sh
pnpm test --run workflows/review/eval/
```

### Live A/B locally (requires `ANTHROPIC_API_KEY`)

```sh
pnpm dlx tsx workflows/review/eval/live-ab.ts \
  [--base-ref <ref>]        # baseline review.md source (default: merge-base with origin/main)
  [--cases <id,id>]         # EXACT selection: bypasses --smoke-only; unknown ids fail before spend
  [--smoke-only]            # only live cases also tagged smoke (the per-PR default; ignored under --cases)
  [--repeats <n>]           # n runs per arm in one invocation; pooled pass-rate report
  [--force-arms]            # run identical arms anyway (wobble control / noise floor)
  [--max-usd <n>]           # hard budget across all arm-runs (default 40)
  [--re-review-mode <m>]    # candidate-arm mode on open-PR cases: full|scoped|flip-gated|fast
  [--no-judge]              # skip prose-quality judging
  [--no-match-arbiter]      # deterministic spec matching only
  [--out <path>]            # default out/live-ab-report.json (+ sibling .md)
```

Byte-identical review.md in both arms short-circuits to a $0 "no reviewable
delta" report unless `--force-arms` is passed. Budgets are enforced between
cases; a capped run reports skipped cases instead of dying. Multi-repeat
runs checkpoint the artifact after every repeat.

### CI entry points

- **Per-PR** (`.github/workflows/review-eval-ab.yml`): triggers on PRs
  touching `workflows/review/**`; smoke subset by default, the `full-eval`
  label lifts to every live case, `skip-live-eval` opts out. Report goes to
  a sticky PR comment, the job summary, and the `live-ab-report` artifact.
- **Dispatch** (same workflow): inputs `base_ref`, `max_usd`, `full`,
  `cases`, `repeats`, `force_arms`. This is how powered runs launch.
- **Weekly drift** (`.github/workflows/review-eval-drift.yml`): cron; full
  corpus x3 repeats, both arms pinned to main's review.md, so it watches
  cumulative drift AND re-measures the noise floor every week. Report goes
  to the job summary, the `live-ab-report` artifact, and a visibility PR
  adding the report under `.github/review-eval/drift/`.

### Recipes

```sh
# Powered run for a recall-affecting change (~$29): the cases it aims at, 10x per arm
gh workflow run review-eval-ab.yml --ref <branch> \
  -f cases=adversarial-injection-approve,golden-request-changes-authz \
  -f repeats=10 -f max_usd=45

# Cumulative measurement vs production (~$60): full corpus x3 against main
gh workflow run review-eval-ab.yml --ref <branch> \
  -f base_ref=origin/main -f full=true -f repeats=3 -f max_usd=85

# Noise floor / wobble control: identical arms, full corpus x3
gh workflow run review-eval-ab.yml --ref <branch> \
  -f base_ref=origin/<branch> -f force_arms=true -f full=true -f repeats=3 -f max_usd=85

# Pool reports across dispatches (run ids or local paths)
pnpm dlx tsx workflows/review/eval/aggregate.ts <run-id> <run-id> ... [--out <path>]
```

## The corpus

`corpus/` holds one JSON case per PR-under-review, loaded by
`corpus/loader.ts` (see its header for the full format). Two layouts:
flat `<id>.json`, or `<id>/case.json` plus a `tree/` snapshot for
live-enabled cases. Tags drive selection: `smoke` (per-PR subset), `live`
(runnable by real model agents; requires the `live` block and tree).

Live ground truth is a list of defect specs (`live.mustCatchSpecs`): path,
optional line window, mechanism regex alternates, and optional
`altLocations` for defects with more than one correct anchor site (a
migration missing an index is correctly flagged at the migration OR at the
hot query; a single-location spec turns anchor-site preference into fake
recall noise). Matching is deterministic first (location AND mechanism);
specs left unmatched go to a capped Haiku arbiter (`match-arbiter.ts`)
whose claims are recorded `via: "fallback"` for audit.

Growing the corpus: target the 20-80% catch band, where discrimination
lives. Saturated cases (caught 100% on both arms) are tripwires; they add
safety but zero resolution. Mint new cases from production incidents and
from every confirmed found-but-dropped miss. After changing a case, replay
recorded artifacts through the matcher before trusting new rates (the
sql-missing-index case read 8/16 for a week because the spec, not the
reviewer, was wrong).

Hard-won calibration finding (2026-07-20, runs 29763213774 / 29764855482 /
29765059892 / 29765275168 / 29767404342): hand-authored synthetic cases do
not reach the 20-80% band at any feasibly authorable size. Nine
single-defect cases from three design philosophies (removed-behavior,
cross-file chain, 13-file churn needle, non-idempotent retry, check-then-act
race, boundary double-count, two retention/lifecycle mid-band targets, and a
29-file cross-subsystem case whose invariant sits two unchanged hops from
the diff), including a hardening pass that removed every stated invariant,
all calibrated 100% across ~56 identical-arm samples on the Opus roster.
When the relevant context is discoverable at all, the correctness reviewer's
named procedures reason to the defect reliably; subtlety of planting and
tree size up to ~30 files do not move the rate. Author synthetics as
deliberate family tripwires (they still catch regressions and host
mustNotFlagSpecs for precision). Every case that has ever calibrated in-band
or at floor derives from REAL material: golden cases minted from human
review comments and incident repros from production defects, at real-repo
scale and messiness. Grow recall discrimination from those sources only, and
calibrate every new case with an identical-arm `--force-arms` run before
claiming a band.

## Reading a report

- **Load-bearing:** must-catch recall against labeled specs, verdict
  agreement, the per-case regression list, the drop buckets, and the
  adversarial hard gate. Judge quality and noise jitter run-to-run and can
  move OPPOSITE to review health (fewer, surer comments each read better).
- **Noise floor** (measured on 6 identical-arm samples, run 29069228968,
  rendered in every report footer): recall 54-86%, verdict agreement
  75-100%, noise 50-60%, judge quality 0.82-0.86. A single-run delta whose
  arms both sit inside a band is wobble. Detecting a 20-point recall change
  needs ~60 spec-samples per arm; 10 points needs ~140 (two-proportion, 80%
  power). Repeats are the cheap axis: no authoring, no review.
- **Miss classes:** a true miss is a recall problem; found-but-dropped
  (provenance/scope/validation buckets) is an anchoring or gate-calibration
  problem. They route to different fixes; never collapse them. The
  provenance bucket's near-miss class (right file, right mechanism, anchor
  a few lines off or past a short file's end) is what the gate's
  anchor-snap fallback repairs; a finding still landing in this bucket was
  outside both snap windows.
- **Anchor-snap and the arms:** the deterministic pipeline is shared by
  both arms, but the provenance gate emulates each arm's OWN review.md gate
  version, keyed on the literal `anchor-snap` marker in the gate step. A
  baseline built from a pre-snap prompt replays the pre-snap gate, which is
  what let the snap change itself be priced by a powered run; once both
  prompts carry the rule, both arms snap and the A/B is back to measuring
  prompt deltas alone. Snaps are recorded per run (`snappedByProvenance`
  in the report's runs; `out/snapped.json` in production artifacts) for
  audit, counted per case in the report (`perCase.snapped`), and pooled in
  the aggregate ("Findings anchor-snapped"). The snap count is the direct
  anchor-fidelity observable: the line-number-annotated staged diffs exist
  to drive it to zero at the source, with the snap as backstop. Staging
  writes the annotated copies (`pr-annotated.diff`,
  `full-stripped-annotated.diff`) for both arms unconditionally; only a
  review.md version that names them reads them, so annotation A/Bs are
  pure prompt deltas with no staging flag. Each record carries the original and snapped anchors, so the
  window class is derivable: a from/to distance within 3 is a near-miss
  snap, anything larger is the past-EOF overflow class (the observed
  diff-text-counting pathology). Reviewing audited snaps over real PRs is
  how the near-miss window's rescue-vs-launder balance gets adjudicated;
  the deterministic smoke case `provenance-anchor-snap-rescued` pins both
  the rescue and the far-anchor set-aside in CI.
- **Gates:** single runs retry a flipped adversarial case best-of-three;
  `--repeats` runs decide by strict majority across repeats instead. Only
  confirmed failures exit non-zero.
- **Stacked PRs:** a per-PR report's baseline is the PR's base branch tip
  (the parent PR in a stack), so it prices the marginal delta only.
  Absolute columns do not compare across reports.
- **Ruler provenance:** every report stamps the matcher configuration and a
  corpus content hash (`provenance` in the JSON, the "Ruler" line in the
  markdown). Rates are only comparable when BOTH the review.md sha and the
  ruler match; `aggregate.ts` warns loudly on mixed pools. Instrument
  changes (arbiter on/off, corpus growth) move every rate without the
  reviewer changing, and the stamps are what keep the drift series honest
  across them.

### Statistical honesty (limits to keep in mind)

- **Pooled intervals are optimistic.** The Wilson intervals treat spec
  catches as independent draws; specs within a case and cases within an
  arm-run are correlated, so true pooled intervals are somewhat wider than
  printed. Per-case rows are close to valid; treat the pooled CI as a lower
  bound on uncertainty.
- **The v1 noise-floor bands carry case-mix variance.** The 2026-07-10
  measurement ran into budget skips (38/36 of 42 case-runs), so its bands
  fold corpus-composition variance in on top of run-to-run wobble. The
  aggregate now flags asymmetric samples and reports SD alongside min/max
  (min/max only widen as samples accumulate; mean +/- sd is the band to
  track). Weekly drift runs at the $85 default refresh the bands cleanly.
- **The repeats-mode gate is more permissive than single-run mode.** A
  single run fail-biases (a flipped adversarial case must pass both
  retries); `--repeats` confirms only on a strict majority, so a case
  failing under half the time passes a powered run. Deliberate (the repeat
  structure is the evidence), but it IS a relaxation of "handle every
  adversarial case outright"; per-case fail counts print either way, read
  them.
- **The arbiter's refuse bias is a prompt, not a calibration.** Its rescues
  inflate recall, the load-bearing metric, and its false-positive rate has
  not been measured against known non-matches. Audit `via: "fallback"`
  matches when a recall claim is close, and prefer `--no-match-arbiter`
  when reproducing pre-arbiter numbers.

## Costs and models

Measured ~$0.72-0.75 per case per arm. Smoke run ~$10/PR; full 14-case
corpus x3 repeats x both arms ~$60 (cap it at $85 to avoid budget skips).
The judge and the match arbiter are pinned to `claude-haiku-4-5-20251001`.
Every model-spending path degrades to a partial report rather than dying
at a cap, and judge/arbiter failures degrade to notes/non-matches.

## Historical limits

The live A/B executes agent prompts extracted from review.md and validates
schema-2 findings. That architecture starts 2026-07-08 (#202); the
`failure_scenario` requirement lands 2026-07-09 (#226). Snapshots at or
after #226 can be baselined directly via `base_ref`; anything older (the
pre-agent monolith, or the 6-agent legacy-contract era) cannot run under
this harness and needs a seeded-defect live trial (the `review-trial`
pattern) instead.
