# PRIOR REFINE ANALYSIS (operator-approved 2026-07-02, previous pipeline run) — revise per the updated operator directions in the task description; do not start from scratch. The main required changes: (1) all 11 specialist lenses build in this run (the top-4/eval-gated split in §4 R10 and cq-1 is superseded); (2) remove every "benchmark-gated"/"eval-evidence-gated" construction precondition (§4 Phase 3 framing, R9/R10/R12) — the eval suite measures after the fact; (3) sequencing is dependency-based slicing for the plan phase, not roadmap phases; (4) model launch defaults (R12) are implemented in this run, Fable arms stay post-suite experiments. Ground truth (§2), the #194 inventory (§3), requirement definitions, interface requirements (§6), open questions (§7), and risks (§9) remain valid.

# Refined Requirements — "Improving the Khan PR review agent" (Khan/actions shared workflow)

Pipeline: `pipeline-121df67a` · Repo: `Khan/actions` · Base: `main` · Phase artifact: refine

## 1. Scope statement

This pipeline implements the **Khan/actions portion** of the "Improving the Khan PR review agent" proposal: the shared PR-review workflow (`workflows/review/review.md` and its inline sub-agent prompts) and everything that ships with it — the outstanding reliability fixes, the fourteen prompt edits (minus the one #194 landed), the severity rules, the reviewer roster restructure, the thumbs feedback sweep, and the eval suite.

**Not this pipeline**: any PR against Khan/webapp or Khan/frontend — skill-file severity annotations, the consumer-side `correctness-checks.md` content, the consumer half of the config drift guard, and pin/repin updates. Where the proposal names consumer work, this pipeline treats it as an **interface requirement** on the shared workflow (§6), never as a target.

## 2. Ground truth (verified against this repo at `54f804c9`)

- `workflows/review/review.md` (1,024 lines) is the single shared prompt: an orchestrator making all GitHub calls, with inline read-only sub-agents — `pattern-triage`, `correctness-reviewer`, `skill-auditor`, `reviewer-mapper`, `thread-reconciler`, `claim-validator` (7 steps: gather context → early-exit → review → verdict → per-line comments → submit → risk/patterns comment on approval).
- Consumers import it via `source:` and supply four config files (risk tiers, CI-tooling exclusions, skills index, reviewer allowlist) plus the `add-reviewer` safe output.
- #194 (merged 2026-07-02, commit `4e7d82f7`) is present on `main`; its changes are the baseline this pipeline builds on, not work to redo.

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
- **R5 (P1)** Smoke benchmark: ~a dozen cases — incident repros, adversarial-injection PRs, known-clean PRs — plus a run mode exercising the real review path without ever posting to a real PR.
- **R6** The causal experiment: rerun the reviewer on webapp PR #40536 with edits 8+10 applied; success = the OpenAccess authorization question surfaces.
- **R7 (P1)** Wave-2 rebalance as one unit, verified against the smoke set: edits 8 (coverage first), 9 (blocking requires a concrete failing scenario), 10 (drop only the refuted; downgrade the uncertain), 11 (confirm before you claim), 12 (cite exact lines or quote), plus the blocking-claim refuter panel and edit 13's posting bar (ranked posting; inline ≥medium confidence; low-confidence in one collapsed section; suggested diffs where clear; no padding).
- **R8 (P1)** Determinism boundary, incrementally: (a) versioned structured finding schema (id, lens, anchor incl. PR-level type, severity, confidence, evidence trace, optional suggested patch, optional pre-merge obligation, producing hunt, model-authored prose); (b) computed verdict in code, including a hold-for-human outcome for policy-named conflicts; (c) templated rendering of Conventional Comments. Code owns merging, aggregation, label-wrapping, safe-output calls; models own all judgment and every human-read sentence. Keep it small (a few hundred lines); tripwire: thinner finder output after schema tightening means loosen fields, not the boundary.
- **R9 (P1)** Investigation tooling for reviewers: grep callers, trace call chains, run one targeted cheap check; cap tool calls per finding; raise run budget/timeout before broad enablement.
- **R10 (P1/P2)** Roster restructure under "one owner per concern":
  - Deterministic router (code): file classification from `.gitattributes`, path→lens mapping, team mapping from REVIEWERS, per-file risk tier (small model check only for diff-direction-dependent tiers); subsumes `reviewer-mapper`; scales the run budget by highest touched risk tier, with a floor for misrouted PRs.
  - Always-on: `holistic`, `completeness` (Jira/Confluence read-only inside the non-posting sub-agent; fetched text is data under review — trust boundary per §6.4), `test-adequacy`, `first-principles` (advisory-only, never blocks, Fable 5 day one), `conventions` (advisory; router-gated by greppable trigger signatures).
  - Specialist lenses: ALL ELEVEN in this run (per updated operator direction 1): security & auth, AI safety & moderation, mass-comms & COPPA, caching & resource, data & migrations, concurrency & async, API & federation compat, cross-deploy serialization, deploy & infra config, money & payments, content & i18n. Each folds its skill's rules + incident-derived executable hunts (each hunt reports ran / not-applicable / found). `skill-auditor` folds into the lenses. Security & auth may split along the risk config's seam (authorization correctness vs. web/platform security).
  - Gates kept: `pattern-triage` (exclusions listed in the guidance comment; eval scores its false-exclusion rate), `claim-validator` + refuter panel (batched/parallel), deterministic dedup + verdict bookends, `thread-reconciler`.
  - Prompt edit 14: the named mandates for holistic / completeness / first-principles.
- **R11 (P1)** Full eval suite (the largest line item; budget as a project): four datasets (incident repros; regenerated synthetic mutations mapped to lenses; golden set with human-comment + revert/follow-up labels; clean set), five metrics (must-catch recall ≈100%; golden precision; clean false-block ≈0; noise; calibration), Opus 4.8 LLM-judge with human audit sample, thumbs labels calibrate the judge, golden-set holdout + fresh mutations against overfitting, adversarial set as a hard gate for automatic, smoke set runs as CI on this repo, and reviewer versioning (hash of prompt+config stamped via the existing HTML marker).
- **R12 (P1)** Model launch defaults implemented in this run: Opus 4.8 workhorse; effort per role (medium triage/reconciliation, high lenses/whole-change, xhigh security lens + claim-validator/refuters); `reviewer-mapper` becomes code; first-principles on Fable 5 day one. Per-role Fable arms and Sonnet experiments are post-suite measurement questions.
- **R13 (P2)** Per-finding resolution rule on re-review: every actionable finding gets an explicit resolution (fixed / deferred-to-filed-issue / disagreed-with-reason).
- **R14 (P2)** Config drift guard, shared side: expose a stable version/config-hash surface (R11's version stamp is the natural hook) for consumer-side sync checks.
- **R15 (P2)** Live counters mined from run logs and #194's per-run JSON artifacts: validator drop rate per lens, comments/PR, verdict mix, thumbs agree rate, cost per run.
- **R16 (P2)** Dismissal-learning: dismissed/resolved threads, 👎 with replies, and correct pushback become candidate "do-not-flag-this-here" notes proposed as changes to a committed config file a human approves — never auto-adopted.
- **R17 (P2)** Conditional-approval verdict: APPROVE + a prominent structured obligations comment via the existing add-comment safe output; renders from the finding schema's `obligation` field (R8).

## 5. Explicitly out of scope

- Any commit or PR against Khan/webapp or Khan/frontend.
- Skill-file severity annotations in consumer repos; consumer `correctness-checks.md` content; consumer-side drift-guard wiring; consumer pin/repin updates.
- Flipping any consumer to automatic triggering; naming the graduation numbers (§7).
- Assigning a product owner for the reviewer (§7).
- Re-implementing anything in §3.

## 6. Interface requirements (contract with consumer repos)

1. Skill-severity declarations: keep reading the skill file's own blocking/advisory declaration as authoritative (post-#194 behavior).
2. `correctness-checks.md` extension point: keep the optional import working; migration into lenses must not strand consumer content.
3. Thumbs sweep: deployable against both consumer repos from day one.
4. Completeness reviewer access: Jira/Confluence tokens scoped read-only, fetch confined to the non-posting sub-agent, fetched text treated as data under review — a real trust-boundary change, documented for consumers.
5. Drift guard: shared workflow exposes a stable version/config-hash surface.
6. Trigger override: consumers' manual `/review` override (webapp) and automatic mode (frontend) must keep working across every change.

## 7. Open questions — surfaced, not guessed

Per the operator directive, the proposal's deferred decisions surface as HITL decisions, never as implementation tasks or guesses:
- **Graduation bar** (Open Question 1): operator policy; this pipeline delivers only what makes the bar settable (metrics, adversarial set, version stamps).
- **What earns a blocking verdict** (Open Question 2): mechanics land via #194 + R7 + R8; the policy threshold surfaces as HITL if a build choice depends on it.
- **Vendor vs. consume** (Open Question 3): resolved for this pipeline by the task statement — the restructure lands in the shared Khan/actions workflow; extension points kept so either later answer works.
- **Who owns the reviewer** (Open Question 4): organizational; not buildable; noted that R15/R16/suite upkeep are at-risk until an owner exists.

## 8. Acceptance criteria (refine-level)

1. Every requirement traces to a specific proposal finding, prompt edit, roster item, or bet — and none re-implements a §3 item.
2. The plan orders slices by real build dependencies (router before lenses; schema before computed verdict; smoke set before the wave-2 rebalance lands); no roadmap-phase or eval-evidence deferral of construction.
3. No deliverable targets a consumer repo; every consumer-named item appears only as a §6 interface requirement.
4. All 11 specialist lenses appear as build tasks in the plan.
5. Model launch defaults (R12) appear as build tasks; Fable arms appear only as post-suite experiment notes.

## 9. Risks & constraints for the plan phase

- **gh-aw engine limits**: single-session model; the determinism boundary (R8) must land incrementally inside that constraint (schema → verdict → rendering).
- **Budget/timeout**: 20-min / $10 caps conflict with investigation + the full 11-lens roster; the router's tier-scaled budget (R10) is the mitigation — a run only spawns the lenses whose paths are touched, so the full roster rarely runs at once. Cap changes are an operator decision to surface, not assume.
- **Eval-suite data dependencies**: incident repros and golden/clean sets are built from Khan incident history and consumer-repo PR records; the suite must consume those without this pipeline writing to consumer repos.
- **Fable 5 constraints**: 2× pricing, 30-day org data-retention, longer turns vs. the timeout — reasons the Fable arms stay post-suite experiments (first-principles excepted, advisory-only).
- **Suite cost**: full-suite runs spend real inference budget; smoke set is the CI gate, full suite is scheduled.