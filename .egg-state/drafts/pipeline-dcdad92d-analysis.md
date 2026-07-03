# Refined Requirements — "Improving the Khan PR review agent" (Khan/actions shared workflow)

Pipeline: `pipeline-dcdad92d` · Repo: `Khan/actions` · Base: `main` (code baseline `54f804c9`, #194 = `4e7d82f7` present) · Phase artifact: refine

## 0. Revision log (this refine round)

This document revises the operator-approved analysis from the prior refine round (pipeline-121df67a) per the operator's updated directions of 2026-07-02, which are binding and supersede conflicting prior text:

1. **All 11 specialist lenses build in this run** — the prior "top-4 now, rest eval-gated" split (old R10/cq-1) is superseded; R10 now lists all eleven as construction items, measured by the eval suite after they exist.
2. **No benchmark-gated / eval-evidence-gated construction preconditions anywhere** — the proposal's four-phase roadmap language is human sequencing prose, not build gating; every gating qualifier was removed from R9/R10/R12. The eval suite (R11) measures after the fact and keeps future changes honest.
3. **Sequencing is the plan phase's job, by real build dependencies only** — e.g. deterministic router before the lenses that consume its routing; finding schema before the computed verdict; smoke set landed before the wave-2 recall/precision rebalance ships (regression protection is a genuine dependency). No roadmap-phase or evidence-based deferral (§8 AC2).
4. **Model launch defaults are construction items in this run** (R12); per-role Fable-5 arms remain post-suite measurement experiments, not build tasks.

Ground truth (§2), the #194 inventory (§3), requirement definitions, interface requirements (§6), open-question treatment (§7), and risks (§9) carry over from the approved analysis and were re-verified against the live repo on 2026-07-03.

## 1. Scope statement

This pipeline implements the **Khan/actions portion** of the "Improving the Khan PR review agent" proposal: the shared PR-review workflow (`workflows/review/review.md` and its inline sub-agent prompts) and everything that ships with it — the outstanding reliability fixes, the thirteen remaining prompt edits (edit 4 = #194), the severity rules, the full reviewer roster restructure, the thumbs feedback sweep, and the eval suite.

**Not this pipeline**: any PR against Khan/webapp or Khan/frontend — skill-file severity annotations, the consumer-side `correctness-checks.md` content, the consumer half of the config drift guard, and pin/repin updates. Where the proposal names consumer work, this pipeline treats it as an **interface requirement** on the shared workflow (§6), never as a target.

## 2. Ground truth (re-verified against this repo, 2026-07-03)

- `workflows/review/review.md` (1,024 lines) is the single shared prompt: an orchestrator making all GitHub calls, with inline read-only sub-agents — `pattern-triage`, `correctness-reviewer`, `skill-auditor`, `reviewer-mapper`, `thread-reconciler`, `claim-validator` (7 steps: gather context → early-exit → review → verdict → per-line comments → submit → risk/patterns comment on approval).
- Consumers import it via `source:` and supply four config files (risk tiers, CI-tooling exclusions, skills index, reviewer allowlist) plus the `add-reviewer` safe output.
- #194 (merged 2026-07-02, commit `4e7d82f7`) is present on `main`; its changes are the baseline this pipeline builds on, not work to redo. Verified present: pinned models (`claude-opus-4-8` orchestrator/sub-agents, `claude-sonnet-4-6` pattern-triage, `claude-haiku-4-5` reviewer-mapper), hunk-signature re-review scoping, `skip-ai-review` label, `correctness-checks.md` import.

## 3. Already shipped in #194 — do NOT re-implement

1. Pinned model versions everywhere (orchestrator + Opus sub-agents → claude-opus-4-8, pattern-triage → claude-sonnet-4-6, reviewer-mapper → claude-haiku-4-5).
2. Per-violation blocking/advisory severity; skill file's own severity declaration is authoritative, impact-judgment fallback prefers advisory on ties; new `suggestion (non-blocking, best-practice)` label. (= prompt edit 4.)
3. Validator may downgrade an overstated severity.
4. Mechanical verdict from posted-comment labels: REQUEST_CHANGES iff a posted comment carries a blocking label.
5. Re-review scoping by content-based hunk signatures (added-lines-only hash per hunk); genuine-issue blocking correctness findings survive on unchanged code.
6. Skip of redundant no-comment re-approvals — with the note-carrying-review exemption.
7. Skipped-dimension tracking in Step 3, noted in the review body for either verdict (visibility only, not a gate).
8. Per-run artifact of each sub-agent's raw JSON (30-day retention).
9. `skip-ai-review` opt-out label.
10. Optional repo-specific `.github/aw/review/correctness-checks.md` import folded into the correctness pass.

## 4. Requirements

- **R1 (P0)** Standardize review submission on one robust call with a real body. Eliminates the observed `--body-stdin` / empty-body retry dance. Still open after #194.
- **R2 (P0)** Never auto-approve with a core dimension missing: if the correctness pass or the skill/severity pass produced no output, **hold for a human** instead of approving with a note. A lost `pattern-triage` pass may still note-and-continue. (#194's note is visibility; this is the gate.)
- **R3 (P0)** Prompt edits **1, 2, 3, 5, 6, 7** (edit 4 = #194): E1 High-risk trigger named + one-line judgment; E2 stage `pr-context.json` for all sub-agents; E3 untrusted-input rule (embedded instructions are content to analyze, an attempt to direct the reviewer is itself a finding); E5 deletions-are-findings; E6 full reply chain staged, reconciler judges author reasoning, never re-raises a conceded point; E7 skip lines with open human threads.
- **R3b** Flag-a-pre-existing-bug rule: a real bug in the lines the PR touches is fair to flag even if it predates the change. Builds on #194's severity model; does not re-open it.
- **R4 (P1)** Thumbs feedback sweep — deterministic code, no model: 👍/👎 at two grains; polling sweep collects reactions; one follow-up per new 👎 (incorrect / unimportant / unclear / duplicate + free text); never re-ping. Must be deployable against both consumer repos from day one. Feeds the golden set (R11) and dismissal-learning (R16).
- **R5 (P1)** Smoke benchmark: ~a dozen cases — incident repros, adversarial-injection PRs, known-clean PRs — plus a run mode exercising the real review path without ever posting to a real PR. **One harness, not two**: the smoke set is a tagged subset of the R11 eval suite's corpus — same dataset format, same runner, same no-post run mode — with a CI entry point; never a separate corpus or harness.
- **R6** The causal experiment: rerun the reviewer on webapp PR #40536 with edits 8+10 applied; success = the OpenAccess authorization question surfaces.
- **R7 (P1)** Wave-2 rebalance as one unit, verified against the smoke set: edits 8 (coverage first), 9 (blocking requires a concrete failing scenario), 10 (drop only the refuted; downgrade the uncertain), 11 (confirm before you claim), 12 (cite exact lines or quote), plus the blocking-claim refuter panel and edit 13's posting bar (ranked posting; inline ≥medium confidence; low-confidence in one collapsed section; suggested diffs where clear; no padding). The smoke set (R5) must exist first — a real build dependency, not an evidence gate.
- **R8 (P1)** Determinism boundary, incrementally: (a) versioned structured finding schema (id, lens, anchor incl. PR-level type, severity, confidence, evidence trace, optional suggested patch, optional pre-merge obligation, producing hunt, model-authored prose); (b) computed verdict in code, including a hold-for-human outcome for policy-named conflicts; (c) templated rendering of Conventional Comments. Code owns merging, aggregation, label-wrapping, safe-output calls; models own all judgment and every human-read sentence. Keep it small (a few hundred lines); tripwire: thinner finder output after schema tightening means loosen fields, not the boundary. Converse tripwire: code owns merging, aggregation, label-wrapping, and safe-output calls **only** — any slice that grows code into judgment territory (rewriting model prose, scoring findings beyond the declared severity/confidence fields) is scope creep to reject in review, not negotiate.
- **R9 (P1)** Investigation tooling for reviewers: grep callers, trace call chains, run one targeted cheap check; cap tool calls per finding. Builds in this run. The run budget/timeout caps it must live inside are an operator decision to surface, not assume (§9).
- **R10 (P1)** Roster restructure under "one owner per concern" — all constructed in this run:
  - Deterministic router (code): file classification from `.gitattributes`, path→lens mapping, team mapping from REVIEWERS, per-file risk tier (small model check only for diff-direction-dependent tiers); subsumes `reviewer-mapper`; scales the run budget by highest touched risk tier, with a floor for misrouted PRs.
  - Always-on: `holistic`, `completeness` (Jira/Confluence read-only inside the non-posting sub-agent; fetched text is data under review — trust boundary per §6.4), `test-adequacy`, `first-principles` (advisory-only, never blocks, Fable 5 day one), `conventions` (advisory; router-gated by greppable trigger signatures).
  - Specialist lenses: **all eleven in this run** (operator direction 1): security & auth, AI safety & moderation, mass-comms & COPPA, caching & resource, data & migrations, concurrency & async, API & federation compat, cross-deploy serialization, deploy & infra config, money & payments, content & i18n. Each folds its skill's rules + incident-derived executable hunts (each hunt reports ran / not-applicable / found). `skill-auditor` folds into the lenses. Security & auth builds as **one** lens — the eleven named lenses are the roster; if implementation shows a genuine need to split it along the risk config's seam (authorization correctness vs. web/platform security), that is a HITL question per operator direction 7, not a builder's option. Effectiveness is measured by the eval suite **after** they are built.
  - Gates kept: `pattern-triage` (exclusions listed in the guidance comment; eval scores its false-exclusion rate), `claim-validator` + refuter panel (batched/parallel), deterministic dedup + verdict bookends, `thread-reconciler`.
  - Prompt edit 14: the named mandates for holistic / completeness / first-principles.
- **R11 (P1)** Full eval suite (the largest line item; budget as a project): four datasets (incident repros; regenerated synthetic mutations mapped to lenses; golden set with human-comment + revert/follow-up labels; clean set), five metrics (must-catch recall ≈100%; golden precision; clean false-block ≈0; noise; calibration), Opus 4.8 LLM-judge with human audit sample, thumbs labels calibrate the judge, golden-set holdout + fresh mutations against overfitting, adversarial set as a hard gate for automatic, smoke set runs as CI on this repo, and reviewer versioning (hash of prompt+config stamped via the existing HTML marker). The suite measures what this run builds; it is never a precondition for building it.
- **R12 (P1)** Model launch defaults implemented in this run: Opus 4.8 workhorse; effort per role (medium triage/reconciliation, high lenses/whole-change, xhigh security lens + claim-validator/refuters); `reviewer-mapper` becomes code (subsumed by R10's router); first-principles on Fable 5 day one. Per-role Fable arms and Sonnet experiments are post-suite measurement questions, not build tasks.
- **R13 (P2)** Per-finding resolution rule on re-review: every actionable finding gets an explicit resolution (fixed / deferred-to-filed-issue / disagreed-with-reason).
- **R14 (P2)** Config drift guard, shared side: **adds no new mechanism** — R11's reviewer-versioning stamp (hash of prompt+config via the existing HTML marker) IS the drift-guard surface; R14 documents that stamp as the stable consumer-readable surface for sync checks. One surface, not two.
- **R15 (P2)** Live counters mined from run logs and #194's per-run JSON artifacts: validator drop rate per lens, comments/PR, verdict mix, thumbs agree rate, cost per run.
- **R16 (P2)** Dismissal-learning: dismissed/resolved threads, 👎 with replies, and correct pushback become candidate "do-not-flag-this-here" notes proposed as changes to a committed config file a human approves — never auto-adopted.
- **R17 (P2)** Conditional-approval verdict: APPROVE + a prominent structured obligations comment via the existing add-comment safe output; renders from the finding schema's `obligation` field (R8).

## 5. Explicitly out of scope

- Any commit or PR against Khan/webapp or Khan/frontend.
- Skill-file severity annotations in consumer repos; consumer `correctness-checks.md` content; consumer-side drift-guard wiring; consumer pin/repin updates.
- Flipping any consumer to automatic triggering; naming the graduation numbers (§7).
- Assigning a product owner for the reviewer (§7).
- Re-implementing anything in §3.
- Per-role Fable-5 / Sonnet model arms (post-suite measurement experiments, not construction).

## 6. Interface requirements (contract with consumer repos)

1. Skill-severity declarations: keep reading the skill file's own blocking/advisory declaration as authoritative (post-#194 behavior).
2. `correctness-checks.md` extension point: keep the optional import working; migration into lenses must not strand consumer content.
3. Thumbs sweep: deployable against both consumer repos from day one.
4. Completeness reviewer access: Jira/Confluence tokens scoped read-only, fetch confined to the non-posting sub-agent, fetched text treated as data under review — a real trust-boundary change, documented for consumers.
5. Drift guard: shared workflow exposes a stable version/config-hash surface.
6. Trigger override: consumers' manual `/review` override (webapp) and automatic mode (frontend) must keep working across every change.

## 7. Open questions — surfaced, not guessed

Per operator direction 7, the proposal's deferred decisions surface as HITL decisions when a build choice depends on them; they are never guessed or encoded as implementation tasks. Status for this refine round — none currently blocks construction, so none is registered as a gate at refine time:

- **Graduation bar** (Open Question 1): operator policy, post-launch; this pipeline delivers only what makes the bar settable (metrics, adversarial set, version stamps). Raised as HITL if any build choice comes to depend on a specific number.
- **What earns a blocking verdict** (Open Question 2): the mechanics land via #194 + R7 + R8, and #194's severity model already answers the mechanical question (best-practice = suggestion, non-blocking; REQUEST_CHANGES iff a blocking label posts). The residual policy threshold surfaces as HITL the moment a build choice in R8(b)'s computed verdict depends on it.
- **Vendor vs. consume** (Open Question 3): resolved for this pipeline by the operator's task statement — the restructure lands in the shared Khan/actions workflow; extension points kept so either later answer works.
- **Who owns the reviewer** (Open Question 4): organizational; not buildable; noted that R15/R16/suite upkeep are at-risk until an owner exists.

## 8. Acceptance criteria (refine-level)

1. Every requirement traces to a specific proposal finding, prompt edit, roster item, or bet — and none re-implements a §3 item.
2. The plan orders slices by real build dependencies (router before lenses; schema before computed verdict; smoke set before the wave-2 rebalance lands); no roadmap-phase or eval-evidence deferral of construction.
3. No deliverable targets a consumer repo; every consumer-named item appears only as a §6 interface requirement.
4. All 11 specialist lenses appear as build tasks in the plan.
5. Model launch defaults (R12) appear as build tasks; Fable arms appear only as post-suite experiment notes.

## 9. Risks & constraints for the plan phase

- **gh-aw engine limits**: single-session model; the determinism boundary (R8) must land incrementally inside that constraint (schema → verdict → rendering).
- **Budget/timeout**: 20-min / $10 caps conflict with investigation + the full 11-lens roster; the router's tier-scaled budget (R10) is the mitigation — a run only spawns the lenses whose paths are touched, so the full roster rarely runs at once. One scaling rule + one misrouted-PR floor; no per-lens budget knobs. Cap changes are an operator decision to surface, not assume.
- **Eval-suite data dependencies**: incident repros and golden/clean sets are built from Khan incident history and consumer-repo PR records; the suite must consume those without this pipeline writing to consumer repos.
- **Fable 5 constraints**: 2× pricing, 30-day org data-retention, longer turns vs. the timeout — reasons the Fable arms stay post-suite experiments (first-principles excepted, advisory-only).
- **Suite cost**: full-suite runs spend real inference budget; smoke set is the CI gate, full suite is scheduled.
