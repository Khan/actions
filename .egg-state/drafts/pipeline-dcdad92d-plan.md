# Implementation Plan — "Improving the Khan PR review agent" (Khan/actions shared workflow)

Pipeline: `pipeline-dcdad92d` · Repo: `Khan/actions` · Base: `main` (baseline `54f804c9`, #194 = `4e7d82f7` present) · Phase artifact: plan

This plan decomposes the operator-approved refine analysis (`.egg-state/drafts/pipeline-dcdad92d-analysis.md`, requirements R1–R17) into **implementation slices ordered strictly by real build dependencies** (analysis §8 AC2). It encodes **no roadmap-phase, benchmark-gated, or eval-evidence-gated deferral** of construction (operator directions 1–3). Everything in scope is built in this run; the eval suite measures it afterward.

## 0. Ground rules carried into every slice (binding)

- **Never re-implement §3 (#194) items.** Pinned models, per-violation severity + suggestion label, validator downgrades, mechanical label-driven verdict, hunk-signature re-review scoping, redundant-approval skip + note exemption, skipped-dimension tracking, per-run sub-agent JSON artifacts, `skip-ai-review` label, `correctness-checks.md` import — all present on `main`, built upon, not redone. Any slice touching these regions extends; a task that re-does §3 is a review reject.
- **No consumer-repo targets.** Zero commits/PRs against Khan/webapp or Khan/frontend. Consumer-named work appears only as the interface guarantees in §4 below (analysis §6). This is a hard AC (§7 AC3).
- **Determinism boundary stays plumbing-only** (R8): code owns merging, aggregation, label-wrapping, safe-output calls, schema validation, verdict computation, template rendering — **nothing that rewrites model prose or scores findings beyond the declared severity/confidence fields.** Keep it a few hundred lines. Any slice growing code into judgment territory is scope creep to reject in review (analysis R8 converse tripwire).
- **One harness, one version surface, one budget rule** (simplifier guardrails): the smoke set is a *tagged subset* of the eval corpus (not a second harness); the drift-guard surface *is* the eval version stamp (no new mechanism); budget = one tier-scaled rule + one misrouted-PR floor (no per-lens knobs).
- **Budget/timeout caps** (20-min/$10): proceed with reasonable defaults, document assumptions, do not surface as HITL (operator HITL resolution).

## 1. Role → artifact mapping (implement phase)

- **coder** — TypeScript deterministic code + unit-testable modules: finding schema/types, computed verdict, comment rendering, router, thumbs sweep, eval-suite runner/datasets tooling, live counters, dismissal-learning, conditional-approval rendering.
- **documenter** — `workflows/review/review.md` (the gh-aw orchestrator prompt) and all inline sub-agent prompts: prompt edits, lens prompts, always-on reviewer mandates, investigation-tooling instructions, model/effort frontmatter, posting bar, reconciliation rules.
- **tester** — vitest unit/integration tests for all code modules; eval-harness self-tests; CI smoke-set wiring.

> **Architect dependency (flag for architect + reviewer_plan):** the gh-aw engine is single-session (analysis §9). The exact *integration mechanism* for the determinism-boundary code (R8) and router (R10) — separate invocable TS steps/actions vs. code the orchestrator shells out to vs. a pre/post workflow step — is a **technical-design decision the architect owns**, not a task-decomposition decision. This plan assigns *what* is code vs. prompt and *ordering*; the architect fixes *how* code is invoked from the single-session workflow. Slices are written so that decision can slot in without re-ordering.

## 2. Slice dependency graph

```
S1 Foundations (schema + submission reliability + context staging)
   ├── S2 Determinism boundary (verdict + rendering + missing-dimension gate)   [needs S1 schema]
   ├── S3 Deterministic router (subsumes reviewer-mapper)                        [needs S1 schema]
   └── S4 Reliability/quality prompt edits (E1,E2,E3,E5,E6,E7 + R3b)            [needs S1 E2 staging]
S5 Investigation tooling                                                         [needs S1 schema]
S6 Roster framework: always-on reviewers + model defaults + kept gates          [needs S3, S5, S1]
S7 Eleven specialist lenses (+ skill-auditor fold-in)                            [needs S6, S3, S5, S1]
S8 Thumbs feedback sweep (independent code)                                      [needs S1 only]
S9 Smoke benchmark (tagged subset of eval corpus, no-post mode, CI)             [needs S1, S2]
S10 Wave-2 recall/precision rebalance (edits 8–13 + refuter panel + R6)         [needs S9 FIRST, S7, S2]
S11 Full eval suite (4 datasets, 5 metrics, judge, version stamp)               [needs S1, S3, S7, S8, S9]
S12 P2 items (R13,R14,R15,R16,R17)                                              [needs S2, S11, S8]
```

**The three dependency edges the operator named explicitly (AC2) are honored:**
1. Router (S3) before the lenses that consume its routing (S7). ✔
2. Finding schema (S1) before the computed verdict (S2). ✔
3. Smoke set (S9) lands **before** the wave-2 rebalance (S10) — genuine regression protection while the rebalance ships. ✔

All other ordering is real build dependency only; independent slices (S3, S4, S5, S8) may proceed in parallel once S1 lands.

---

## 3. Slices and tasks

### Slice 1 — Foundations: finding schema, submission reliability, context staging
*Depends on: nothing (unblocks S2/S3/S4). Requirements: R1, R8(a), prompt edit E2.*

- **task-1-1 (coder)** — Versioned structured finding schema + validator (R8a). Fields: `id`, `lens`, `anchor` (incl. a PR-level anchor type), `severity`, `confidence`, `evidence_trace`, optional `suggested_patch`, optional `pre_merge_obligation`, `producing_hunt`, `model_authored_prose`. Ship a schema version constant. Files (indicative): new TS module under a review-support lib (architect to site, e.g. `workflows/review/lib/` or a new `actions/review-*`). *AC: schema validates a well-formed finding and rejects a malformed one; version constant exported.*
- **task-1-2 (documenter)** — R1: standardize review submission on **one** robust call with a real body in the Step 6/8 orchestrator prompt; remove the `--body-stdin`/empty-body retry dance. *AC: exactly one submission path documented; no empty-body fallback remains.*
- **task-1-3 (documenter)** — Prompt edit E2: stage `pr-context.json` on disk for **all** sub-agents (extends #194's diff staging). *AC: every sub-agent dispatch reads context from the staged file; foundation for lenses in S7.*
- **task-1-4 (tester)** — Unit tests for the schema/validator (task-1-1).

### Slice 2 — Determinism boundary: computed verdict, rendering, missing-dimension gate
*Depends on: S1 (schema). Requirements: R2, R8(b), R8(c).*

- **task-2-1 (coder)** — R8(b) computed verdict in code from the finding set + posted-comment labels, **including a hold-for-human outcome** for policy-named conflicts. Consistent with #194's mechanical model (REQUEST_CHANGES iff a blocking label posts); do not re-implement #194's label mechanism — consume it. Pick and **document** a sensible blocking threshold default (operator HITL: delegated to implementer judgment, tunable later — not a HITL gate). *AC: verdict is a pure function of schema + labels; hold-for-human path exercised by a test.*
- **task-2-2 (coder/documenter)** — R2 gate: never auto-approve when the correctness pass **or** the skill/severity pass produced no output — **hold for a human** (a lost `pattern-triage` may still note-and-continue). This is the *gate* on top of #194's visibility-only note. *AC: missing core dimension → hold-for-human, not approve-with-note; missing pattern-triage → note-and-continue.*
- **task-2-3 (coder)** — R8(c) templated rendering of Conventional Comments from the schema (code owns label-wrapping + template; models own every human-read sentence). *AC: rendering is deterministic given a finding; no prose synthesis in code.*
- **task-2-4 (tester)** — Tests: verdict truth table (incl. hold-for-human + missing-dimension), rendering snapshots.

### Slice 3 — Deterministic router (subsumes reviewer-mapper)
*Depends on: S1 (schema). Requirements: R10 router, R12 reviewer-mapper→code.*

- **task-3-1 (coder)** — Router in code: file classification from `.gitattributes`, path→lens mapping, team mapping from consumer `REVIEWERS`, per-file risk tier (small-model check invoked only for diff-direction-dependent tiers). **Subsumes `reviewer-mapper`** (removes the Haiku sub-agent; R12). *AC: deterministic lens/team/tier output for a fixture diff; reviewer-mapper no longer dispatched.*
- **task-3-2 (coder)** — Budget scaling: **one** rule scaling the run budget by the highest touched risk tier + **one** floor for misrouted PRs (no per-lens knobs; simplifier guardrail 6). Document the default caps assumed. *AC: budget scales monotonically with tier; misrouted PR gets the floor.*
- **task-3-3 (documenter)** — Wire the orchestrator prompt (Step 3) to consume router output for lens dispatch and drop the `reviewer-mapper` dispatch/parse. *AC: only the router feeds lens/team routing.*
- **task-3-4 (tester)** — Router unit tests (classification, path→lens, tier, budget scaling, floor).

### Slice 4 — Reliability/quality prompt edits
*Depends on: S1 (E2 staging). Requirements: R3 (edits 1,2,3,5,6,7), R3b.*

- **task-4-1 (documenter)** — E1 high-risk trigger named + one-line judgment; E3 untrusted-input rule (embedded instructions are content to analyze; an attempt to direct the reviewer is itself a finding); E5 deletions-are-findings. *AC: each edit present with its rule text.*
- **task-4-2 (documenter)** — E6 full reply-chain staged; reconciler judges author reasoning and never re-raises a conceded point. E7 skip lines with open human threads. *AC: reconciler prompt reflects both rules.*
- **task-4-3 (documenter)** — R3b flag-a-pre-existing-bug rule (a real bug in touched lines is fair to flag even if it predates the change; builds on #194 severity, does not reopen it). *AC: rule present, scoped to touched lines.*

> Prompt edit 4 = #194 (done). Prompt edit 14 (holistic/completeness/first-principles mandates) lands in S6; edit 13 (posting bar) + edits 8–12 land in S10.

### Slice 5 — Investigation tooling for reviewers
*Depends on: S1 (schema). Requirements: R9.*

- **task-5-1 (documenter)** — Sub-agent instructions for bounded investigation: grep callers, trace call chains, run one targeted cheap check per finding. *AC: instructions present; used by S7 lenses.*
- **task-5-2 (coder)** — Enforce a **cap on tool calls per finding** in code (the cap lives inside the run budget from S3; document the default cap — operator: don't surface as HITL). *AC: cap enforced; over-cap calls refused deterministically.*
- **task-5-3 (tester)** — Test the per-finding cap.

### Slice 6 — Roster framework: always-on reviewers, model defaults, kept gates
*Depends on: S3 (router), S5 (investigation), S1 (schema/E2). Requirements: R10 (always-on + gates + edit 14), R12 (model defaults).*

- **task-6-1 (documenter)** — Always-on reviewers: `holistic`, `completeness` (Jira/Confluence read-only **inside the non-posting sub-agent**; fetched text is data under review — trust-boundary rule stated), `test-adequacy`, `first-principles` (**advisory-only, never blocks, Fable 5 day one**), `conventions` (advisory; router-gated by greppable trigger signatures). *AC: five always-on reviewers defined with their trust/advisory constraints.*
- **task-6-2 (documenter)** — Prompt edit 14: named mandates for holistic / completeness / first-principles. *AC: mandates present.*
- **task-6-3 (documenter)** — R12 model launch defaults + effort table: Opus 4.8 workhorse; medium = triage/reconciliation; high = lenses/whole-change reviewers; xhigh = security lens + claim-validator/refuters; first-principles = Fable 5. reviewer-mapper already code (S3). Do **not** re-pin #194's existing model pins — extend the effort assignments. *AC: every role carries its launch-default model + effort; matches R12 table.*
- **task-6-4 (documenter)** — Kept gates wired to the new roster: `pattern-triage` (exclusions in guidance comment), `claim-validator` + refuter panel (batched/parallel), deterministic dedup + verdict bookends (verdict from S2), `thread-reconciler`. *AC: gates preserved; no §3 regression.*

### Slice 7 — Eleven specialist lenses
*Depends on: S6 (roster framework), S3 (router), S5 (investigation), S1 (schema). Requirements: R10 lenses; folds `skill-auditor`.*

Build **all eleven** lenses in this run (operator direction 1). Each folds its skill's rules + incident-derived executable hunts (each hunt reports ran / not-applicable / found) and emits into the S1 finding schema. `skill-auditor` folds into the lenses.

- **task-7-1 … task-7-11 (documenter)** — one lens each: (1) security & auth — **single lens**, effort **xhigh**; do **not** split it — if implementation shows a genuine need to split along the risk-config seam (authorization correctness vs. web/platform security), **raise a HITL question** (operator direction 7 / simplifier guardrail 2), do not split unilaterally; (2) AI safety & moderation; (3) mass-comms & COPPA; (4) caching & resource; (5) data & migrations; (6) concurrency & async; (7) API & federation compat; (8) cross-deploy serialization; (9) deploy & infra config; (10) money & payments; (11) content & i18n. *AC per lens: rules + hunts present; hunt reports tri-state; findings emit valid schema objects; effort = high (xhigh for security).*
- **task-7-12 (documenter)** — Remove standalone `skill-auditor` dispatch once its checks are folded into the lenses; ensure no consumer `correctness-checks.md` content is stranded (interface req §4.2). *AC: skill-auditor folded; extension point intact.*
- **task-7-13 (tester)** — Fixture-based tests that each lens's incident hunts fire on a known repro and report not-applicable on a clean fixture (uses S9 fixtures where available).

### Slice 8 — Thumbs feedback sweep (independent deterministic code)
*Depends on: S1 only. Requirements: R4. Feeds S11 (golden set) and S12/R16 (dismissal-learning).*

- **task-8-1 (coder)** — Thumbs sweep, pure code (no model): 👍/👎 at two grains; polling sweep collects reactions; one follow-up per **new** 👎 (incorrect / unimportant / unclear / duplicate + free text); never re-ping. **Deployable against both consumer repos from day one** as an interface guarantee (§4.3) — no consumer commit. *AC: one follow-up per new 👎, idempotent (never re-pings), works against either repo's config.*
- **task-8-2 (tester)** — Tests: new-👎 detection, single follow-up, no re-ping, two-grain collection.

### Slice 9 — Smoke benchmark (tagged subset of the eval corpus)
*Depends on: S1 (schema), S2 (verdict path). Requirements: R5. MUST precede S10.*

- **task-9-1 (coder)** — Smoke corpus (~a dozen cases): incident repros, adversarial-injection PRs, known-clean PRs — authored in the **same dataset format** as the S11 corpus (tagged subset, one harness). *AC: cases load with the shared loader; tags identify the smoke subset.*
- **task-9-2 (coder)** — Shared runner with a **no-post run mode** that exercises the real review path without posting to any real PR. *AC: run mode produces findings/verdict without any GitHub write.*
- **task-9-3 (tester)** — CI entry point running the smoke set on this repo (Khan/actions). *AC: `pnpm test`/CI invokes the smoke set; green on baseline.*

### Slice 10 — Wave-2 recall/precision rebalance
*Depends on: S9 (smoke set exists FIRST — regression protection), S7 (lenses), S2 (verdict). Requirements: R7, R6, prompt edit 13.*

- **task-10-1 (documenter)** — Edits 8 (coverage first), 9 (blocking requires a concrete failing scenario), 10 (drop only the refuted; downgrade the uncertain), 11 (confirm before you claim), 12 (cite exact lines or quote). *AC: each edit present.*
- **task-10-2 (documenter)** — Blocking-claim **refuter panel** (batched/parallel) + edit 13 posting bar: ranked posting; inline ≥ medium confidence; low-confidence in one collapsed section; suggested diffs where clear; no padding. *AC: posting bar + refuter panel wired to the S2 verdict/S1 confidence fields.*
- **task-10-3 (tester)** — Verify the rebalance against the S9 smoke set (no recall regression on must-catch cases; no new false-block on clean cases). *AC: smoke set green after rebalance.*
- **task-10-4 (tester)** — R6 causal experiment: rerun the reviewer on webapp PR #40536 with edits 8+10 applied **via the no-post harness** (no consumer write). Success = the OpenAccess authorization question surfaces. *AC: experiment recorded; surfacing observed or a documented negative result.*

### Slice 11 — Full eval suite
*Depends on: S1 (schema), S3 (router), S7 (lenses), S8 (thumbs labels), S9 (shared runner). Requirements: R11. Measures what this run built — never a precondition for building it.*

- **task-11-1 (coder)** — Four datasets: incident repros; regenerated synthetic mutations mapped to lenses; golden set (human-comment + revert/follow-up labels); clean set. Built from Khan incident history + consumer PR records **without writing to consumer repos** (analysis §9). *AC: four datasets load via the shared loader.*
- **task-11-2 (coder)** — Five metrics: must-catch recall (≈100%), golden precision, clean false-block (≈0), noise, calibration. *AC: metrics computed over a dataset run.*
- **task-11-3 (coder)** — Opus 4.8 LLM-judge with a human-audit sample; thumbs labels (S8) calibrate the judge. *AC: judge scores a run; audit sample surfaced.*
- **task-11-4 (coder)** — Overfitting guards: golden-set holdout + fresh mutations; adversarial set as a **hard gate** for automatic mode. *AC: holdout separated; adversarial gate enforced.*
- **task-11-5 (coder)** — Reviewer **version stamp**: hash of prompt+config stamped via the existing #194 HTML marker. **This is the single drift-guard surface** (R14 reuses it; no new mechanism). *AC: stamp changes when prompt/config changes; readable by a consumer sync check.*
- **task-11-6 (tester)** — Suite self-tests + wire smoke subset (S9) as the CI gate; full suite as scheduled (not per-PR). *AC: CI runs smoke; full suite invocable on schedule.*

### Slice 12 — P2 items
*Depends on: S2 (verdict/schema), S11 (version stamp, judge), S8 (thumbs). Requirements: R13, R14, R15, R16, R17.*

- **task-12-1 (documenter)** — R13 per-finding resolution rule on re-review: every actionable finding gets fixed / deferred-to-filed-issue / disagreed-with-reason. *AC: rule present.*
- **task-12-2 (documenter)** — R14 config drift guard: **document** the S11 version stamp as the stable consumer-readable surface for sync checks (interface §4.5). **Adds no new mechanism.** *AC: doc points to the stamp; no second surface.*
- **task-12-3 (coder)** — R15 live counters mined from run logs + #194 per-run JSON artifacts: validator drop rate per lens, comments/PR, verdict mix, thumbs agree rate, cost/run. *AC: counters computed from existing artifacts; no new logging mechanism required beyond reading them.*
- **task-12-4 (coder)** — R16 dismissal-learning: dismissed/resolved threads, 👎-with-replies, and correct pushback become candidate "do-not-flag-here" notes **proposed as changes to a committed config file a human approves — never auto-adopted**. *AC: candidates written as a proposed diff/PR-in-shared-repo artifact for human approval; nothing auto-applied.*
- **task-12-5 (coder/documenter)** — R17 conditional-approval verdict: APPROVE + a prominent structured obligations comment via the existing add-comment safe output; renders from the schema's `pre_merge_obligation` field (S1/S2/S3-rendering). *AC: APPROVE-with-obligations path renders from the schema; uses the existing safe output.*

---

## 4. Interface requirements (consumer contract — guarantees, not targets; analysis §6)

Each maps to the slice that must preserve it; **none is a consumer-repo deliverable**:
1. Skill-severity declarations stay authoritative — preserved in S6/S7 (do not regress #194). 
2. `correctness-checks.md` extension point keeps working; no stranded consumer content — S7 task-7-12.
3. Thumbs sweep deployable against both consumer repos day one — S8 task-8-1.
4. Completeness reviewer: Jira/Confluence read-only, confined to the non-posting sub-agent, fetched text = data under review — S6 task-6-1.
5. Drift guard: stable version/config-hash surface exposed — S11 task-11-5 (the single surface; R14/S12 documents it).
6. Trigger overrides (webapp manual `/review`, frontend automatic) keep working across every change — cross-cutting AC on S3/S6/S10 (verify no trigger frontmatter regression).

## 5. Model defaults (build tasks) and post-suite experiments (NOT tasks)

- **Build now (S6 task-6-3):** Opus 4.8 workhorse + effort table (medium triage/reconciliation; high lenses/whole-change; xhigh security lens + claim-validator/refuters); first-principles on Fable 5; reviewer-mapper replaced by code (S3). Satisfies §8 AC5.
- **Post-suite experiments (documented, not built):** per-role Fable-5 arms and Sonnet arms are **measurement questions to run after the suite exists** (analysis §5, R12). They appear here only as notes; no slice/task constructs them.

## 6. Open questions / HITL status at plan time

Per the refine HITL resolution and operator direction 7, the four proposal open questions are **resolved and non-blocking**: graduation bar (not considered this run), blocking-verdict threshold (delegated to implementer judgment, documented default in S2 task-2-1, tunable later — not a gate), vendor-vs-consume (consume; lands in shared workflow), ownership (humans maintain). Budget/timeout caps are not surfaced (defaults + documentation).

**One implement-time HITL trigger is pre-declared** (not registered now): if S7 task-7-1 shows a genuine need to split the security lens along the risk-config seam, the implementer raises it as a HITL question rather than splitting unilaterally.

No HITL decision is registered at plan time — no build choice in this decomposition depends on an unresolved judgment call.

## 7. Acceptance-criteria satisfaction (analysis §8)

1. **Every requirement traces to a slice/task; none re-implements §3** — R1→S1, R2→S2, R3→S4, R3b→S4, R4→S8, R5→S9, R6→S10, R7→S10, R8→S1+S2, R9→S5, R10→S3+S6+S7, R11→S11, R12→S6, R13–R17→S12. §3 guarded in §0. ✔
2. **Slices ordered by real build dependencies** — router→lenses, schema→verdict, smoke→wave-2 all honored (§2); no roadmap/eval deferral. ✔
3. **No consumer-repo deliverable** — all consumer-named work is §4 interface guarantees. ✔
4. **All 11 specialist lenses are build tasks** — S7 task-7-1…7-11. ✔
5. **Model launch defaults are build tasks; Fable arms only post-suite notes** — S6 task-6-3; §5. ✔
