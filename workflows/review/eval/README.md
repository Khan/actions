# Review eval system

How to run, extend, and read the evals for the PR review workflow
(`workflows/review/`). This is the operator guide; each module's header
comment is the reference for its internals.

## The three tiers

| Tier | What it measures | Cost | When it runs |
| --- | --- | --- | --- |
| Deterministic suite (vitest) | The pipeline code: router, gates, verdict, rendering, matching, aggregation. Replays recorded findings; no model calls. | $0 | Every push (`pnpm test --run`) |
| Live A/B, smoke subset | One PR's marginal `review.md` delta: real model sub-agents run from BOTH the base branch's and the PR's review.md over live-tagged smoke cases. A tripwire, not a measurement. | ~$10/PR | Every PR touching `workflows/review/**` |
| Powered / scheduled runs | Recall effects, priced with repeats and binomial intervals; run-to-run wobble; cumulative drift vs main. | ~$29-220 | `workflow_dispatch`, weekly cron |

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

# Cumulative measurement vs production (~$170 at post-Fable-swap measured
# rates: ~$0.80/case-arm-run on the all-Opus baseline arm, ~$1.08 on the
# Fable-correctness candidate arm, 30 live cases x3): full corpus x3
gh workflow run review-eval-ab.yml --ref <branch> \
  -f base_ref=origin/main -f full=true -f repeats=3 -f max_usd=200

# Noise floor / wobble control (~$194 measured with both arms on the
# Fable-correctness roster): identical arms, full corpus x3
gh workflow run review-eval-ab.yml --ref <branch> \
  -f base_ref=origin/<branch> -f force_arms=true -f full=true -f repeats=3 -f max_usd=220

# Powered run for a dedup / duplicate-comment change (~$45): the cases that
# actually produce multi-source clusters are the `documentation`-enabled ones
# (that reviewer contributes the extra copy on a comment defect, which is the
# shape production duplicated in run 30587343777), 5x per arm
gh workflow run review-eval-ab.yml --ref <branch> \
  -f base_ref=origin/main \
  -f cases=golden-documentation-stale-and-narrated,golden-documentation-restated-docstring,golden-documentation-missing-why,golden-documentation-commented-out-code,clean-documentation-earned-comments \
  -f repeats=5 -f max_usd=50

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
whose claims are recorded `via: "fallback"` for audit. When several
posted findings satisfy one spec, the one produced by the spec's `lens`
wins, then posted order.

A case may also carry `live.mayFlagSpecs`: real defects the fixture has
that are NOT the case's ground truth. "Unmatched posted" only means the
spec did not list a finding, and reading run 33671015442's postings showed
10 of the claude arm's 22 unmatched findings were correct about the code
(an unvalidated discount rate, a NOT NULL DEFAULT table rewrite, a test
fake ordering rows opposite to the store's contract). A posted finding
matching a may-flag entry is reported as legitimate unspecced and leaves
the noise numerator, with no recall credit. When you audit a fixture and
find a defect the author did not intend: if it changes the expected verdict,
fix the fixture (as #412 did for the false-block case's pagination doc
comment) or spec it, otherwise add a may-flag entry. Keep the mechanism
alternates tight, they are what tells a legitimate finding from a second
copy of the seeded one. Clean cases can carry them too, but a clean case
with a real defect in its diff is a fixture bug first.

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
  arms both sit inside a band is wobble. The noise band predates the
  may-flag and duplicate buckets (next bullet), so it reads high against
  numbers taken after 2026-09-03 on cases that carry `mayFlagSpecs`, until
  a drift run re-measures it. The report footer carries the same caveat.
  Detecting a 20-point recall change needs ~60 spec-samples per arm; 10
  points needs ~140 (two-proportion, 80% power). Repeats are the cheap
  axis: no authoring, no review.
- **Noise buckets:** the noise row's numerator is residual unmatched
  findings plus duplicates (a second posted copy of a defect another
  finding already claimed, a caught spec or an accepted may-flag entry: a
  merge-stage miss, reported on its own sub-row). Legitimate unspecced findings (may-flag matches, above)
  are NOT in the numerator and get their own row. What remains after both
  is template comments ("no test covers X"), speculation, and unspecced
  findings nobody has audited yet, and on a claude arm the templates are
  most of it. Only audited cases carry `mayFlagSpecs` (8 of the 10 live
  smoke cases so far, none of the rest of the live corpus), so on a case
  without them the noise row is still the old definition, an upper bound.
  A pooled noise rate over audited and unaudited cases together mixes the
  two definitions, so compare `perCase[].noise` / `legitimateUnspecced` in
  the report JSON across arms rather than the pooled row. The entries were written from the claude arm's postings on run
  33671015442 and cross-checked against the gemini arm where it posted, so
  for the first few runs read the per-case buckets against the postings
  once to catch an entry that only matches one model's vocabulary. The
  buckets are regex classification over the finding's text: a leftover
  whose `failure_scenario` fits a may-flag entry is taken at its word, then
  the duplicate check runs, then may-flag against the
  full prose. A distinct finding that borrows the spec's keywords can still
  land in the duplicate bucket (the race case's TTL suggestion says
  "overwrite"), so read the per-case ids before trusting a duplicate count.
- **Miss classes:** a true miss is a recall problem; found-but-dropped
  (provenance/scope/validation buckets) is an anchoring or gate-calibration
  problem. They route to different fixes; never collapse them. The
  provenance bucket's near-miss class (right file, right mechanism, anchor
  a few lines off or past a short file's end) is what the gate's
  anchor-snap fallback repairs; a finding still landing in this bucket was
  outside both snap windows.
- **Cross-source merges:** the report's "Cross-source claims merged (of
  candidates)" row is the duplicate-comment observable, read from the merge
  stage rather than from the posted set (merges happen upstream of every later
  drop, and in production autofix satisfies surviving duplicates with one edit,
  which hides the symptom on the PR). Tier 1, the calibrated text-similarity
  floor, is shared code and runs in BOTH arms; tier 2, the `claim-clusterer`
  agent, is carried by each arm's own review.md, so a baseline built from a ref
  that predates the agent reports `tier 1 only` and the arm delta prices the
  clusterer alone. Read it beside recall: a false merge drops a distinct
  finding, so it shows up as candidate-arm recall loss, not as a better
  duplicate number. The `by clusterer` share counts absorbed COPIES, not groups,
  so a group both tiers contributed to credits tier 2 only with what it actually
  brought; production's `clustering` block records the same per-copy number as
  `clusterMerged` (its `clusterMerges` counts groups), so the artifact and the
  report that graduated the tier cannot be read as disagreeing. The share
  carries tier 2's own dollars and wall-clock beside it, because the dispatch
  precondition is satisfied by most multi-finding reviews: the steady state is a
  serial Sonnet call on nearly every run, and a merge count is a graduation
  argument only next to what those merges cost. `rejected` counts cluster
  MEMBERS the merge rules refused, so one bad
  proposal naming three ids counts three (`unknown-id` there means the clusterer
  named claims that do not exist, which is a prompt or staging failure rather
  than a quiet zero). A dispatch that returned nothing usable is reported as
  `N clusterer failure(s)` rather than folded into the zero: the arm paid and
  measured nothing, which is not the claim that tier 2 found no duplicates.
- **Tier 2's keep-or-cut bar,** written down before the next powered run so the
  decision is auditable after it. The tier ships enabled in the default
  template, so this is the bar it must keep clearing, not one it must clear to
  arrive. Read on the candidate arm of a `--repeats` run:
  - **Any recall loss cuts it.** One `lost` spec traceable to a tier-2 merge
    ends the tier; no merge rate buys back a dropped finding. Same for a failed
    adversarial gate. This one is not traded off against the others.
  - **Rate floor: 0.15 absorbed copies per dispatched case** (`by clusterer`
    over the cases where the clusterer actually ran). Run 30651373253 measured
    0.20 (4 over 20 case-runs). Below the floor the steady state is a serial
    Sonnet call on nearly every review that mostly does nothing, and the
    dispatch precondition should be tightened or the tier cut.
  - **Price ceiling: $0.50 per absorbed copy, and 8% of the arm's cost.** That
    run measured $0.34 and +6% ($22.93 -> $24.30). The two are both needed: a
    cheap tier that never fires and an expensive tier that fires often fail in
    different ways.
  - **Failures are not no-ops.** If `clusterer failure(s)` exceeds 10% of
    dispatches the run measured plumbing, not a rate; fix it and re-measure
    rather than reading the rate as a negative result.
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
- **Ruler provenance:** every report stamps the matcher configuration
  (`deterministic-v2`, `+arbiter` when the fallback ran; v1 is the
  unsuffixed stamp from before the lens tie-break and leftover buckets) and a
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

When an agent fails contract parsing, the report keeps the **raw final text**
of its last attempt (truncated to 4000 chars) and renders it inline under
"Raw output of each failed agent", alongside per-agent **tool-call counts**
from both arms. Reach for those before forming a hypothesis: the failure
reason on its own cannot distinguish a prose answer from a refusal from a
contract cut off mid-emission, and two harness runs (30592964392,
30596474354) cost ~$10 each to establish only that the same two cases fail.

**Empty finals are reported as their own failure**, not as malformed output,
and carry the provider stop reason when the runner can see one
(`empty output: the agent returned no final text (stopReason=...)`). Run
30650071285 showed both harnesses returning length-0 finals from
`correctness-reviewer` on the security-adjacent cases; while that read as
"malformed output" it looked like a contract bug, and three runs chased it as
one. An empty final on cyber-adjacent input is the refusal signature #294
describes as surfacing "as a missing agent result, not an error", so the stop
reason is what separates a refusal from a dropped result.

Standing rule, same class as the SDK-version rule: the budget cap is enforced
from the runner's reported cost, so a runner that cannot price the model under
test turns `--max-usd` into a no-op on precisely that arm. Pi reports a
per-component `cost` breakdown from its own catalog; check that a newly pinned
model is in that catalog before running an arm on it. `resolveModelId` throws
on an unknown pin rather than silently substituting.

## Historical limits

The live A/B executes agent prompts extracted from review.md and validates
schema-2 findings. That architecture starts 2026-07-08 (#202); the
`failure_scenario` requirement lands 2026-07-09 (#226). Snapshots at or
after #226 can be baselined directly via `base_ref`; anything older (the
pre-agent monolith, or the 6-agent legacy-contract era) cannot run under
this harness and needs a seeded-defect live trial (the `review-trial`
pattern) instead.
