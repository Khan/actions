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

---

## 8. Architecture — code integration mechanism & siting (architect; resolves the §1 flagged decision)

The §1 note correctly reserved one decision for the architect: *how* the determinism-boundary code (R8) and router (R10) are invoked inside the gh-aw single-session model (analysis §9), and where that code is sited (task-1-1's "architect to site"). This section fixes that. The task_planner's slice DAG (§2) and this design were reached independently and **converge** — the three operator-named edges (router→lenses, schema→verdict, smoke→rebalance) hold under this integration mechanism with **no re-ordering** of §3.

### 8.1 Decision

Implement the deterministic code as **TypeScript CLI tools sited under `actions/review/`**, built and tested with the repo's *existing* toolchain (`tsc -p actions/tsconfig.json`, `@vercel/ncc` bundling, co-located `*.test.ts` under `vitest`), and **invoked by the orchestrator via `bash` (`node …`) on JSON files in the existing `/tmp/gh-aw/review/` scratch directory** that #194 already uses. The orchestrator remains the single agentic session and the *sole* caller of GitHub and safe outputs; the code is deterministic JSON-in/JSON-out plumbing it shells out to mid-session.

Rejected alternatives and why: **multi-job split** (router/verdict as separate GH Actions jobs) fights gh-aw's single-session model and forces state hand-off between jobs — rejected. **A bespoke runtime/build system** — rejected; the repo already ships the `actions/*/index.ts` (+ `.test.ts`, `action.yml`, ncc) pattern, and `actions/fix-workflows/cli.ts` is direct precedent for a CLI entry point. Reuse it (principle "reuse over rebuild").

### 8.2 Three integration surfaces (name them; they are not all the per-PR session)

- **Surface A — in-session CLIs (per review run).** Router (S3), schema-validate (S1), computed verdict (S2), Conventional-Comment render (S2). The orchestrator invokes these via bash during a review, exchanging JSON under `/tmp/gh-aw/review/`. This is the only surface that touches a live PR.
- **Surface B — standalone scheduled/polling workflows (no per-PR session).** Thumbs sweep (S8, R4), live counters (S12, R15), dismissal-learning candidate generation (S12, R16). These run on their own triggers (schedule/poll) as deterministic code over reaction data and #194's per-run JSON artifacts — never inside the review session. R4's "deployable against both consumer repos" (interface §4.3) is realized as this standalone workflow parameterized by consumer config, not a consumer commit.
- **Surface C — CI / scheduled eval harness (no-post).** Smoke set (S9) as a CI entry point on Khan/actions; full suite (S11) scheduled. Drives the same code pipeline (and, where scored, model sub-agents) in no-post mode. One harness, one dataset format, one runner (simplifier guardrail; §0).

The task_planner's per-slice dependencies are unchanged; §8 only says *which surface each code task lands on*.

### 8.3 Code siting (resolves task-1-1's open siting)

One action directory, **`actions/review/`**, with shared modules and thin CLI entrypoints co-located, added to the `actions/tsconfig.json` `include` list:

```
actions/review/
  schema.ts        # R8a finding schema + validator + VERSION constant   (S1 task-1-1)
  router.ts        # R10 classification/tier/team + budget rule+floor      (S3)
  verdict.ts       # R8b computed verdict incl. hold-for-human             (S2)
  render.ts        # R8c Conventional-Comment templating                   (S2)
  version-stamp.ts # R11/R14 prompt+config hash → HTML marker (one surface)(S11)
  cli/*.ts         # thin argv/stdin→JSON wrappers over the above          (Surface A)
  *.test.ts        # vitest, co-located per repo convention
```

Standalone code (Surface B) and the eval harness (Surface C) live in their own dirs/workflows but **import the same `schema.ts`** so findings are one type everywhere. Keeping the plumbing in one lib is what physically enforces "a few hundred lines" and one-owner-per-concern (§0, R8).

**This finalizes the appendix's indicative paths.** The Structured Task Appendix and task-1-1 use `workflows/review/lib/*.ts` as explicitly *indicative* siting pending the architect's decision; §8.3 finalizes that to `actions/review/*.ts` (chosen for the existing `actions/tsconfig.json` + ncc + vitest build with zero new config — `workflows/` has no TS build wired). Task file paths in the appendix map name-for-name (`render-comment.ts` → `actions/review/render.ts`, etc.); the task_planner's decomposition, roles, and ordering are otherwise unchanged.

### 8.4 In-session data-flow contract (Surface A, per review run)

Extends #194's on-disk convention; each arrow is a bash `node actions/review/cli/<tool>.js` call:

1. Orchestrator stages `full.diff` + `files.json` (existing) → **`router`** reads them → writes `routing.json` (`{lensesToSpawn[], teams, perFileTier, runBudget}`). Step 3 dispatch consumes it (task-3-3); `reviewer-mapper` dispatch removed.
2. Each lens/reviewer sub-agent writes `out/<agent>.json` (existing #194 flow) → **`schema-validate`** validates each against `schema.ts`; malformed → the dimension is treated as *unavailable*, feeding the R2 missing-dimension gate (task-2-2) rather than being silently dropped.
3. Validated findings + posted-comment labels → **`verdict`** → `verdict.json` (`{event: APPROVE|REQUEST_CHANGES|HOLD_FOR_HUMAN, reasons[]}`). Consumes #194's mechanical label rule; does not re-implement it.
4. Findings + verdict → **`render`** → comment bodies + review body. Orchestrator posts them through the *existing* safe outputs (`submit-pull-request-review`, `add-comment`). Code never posts.

### 8.5 No-post run mode (Surface C) — one stubbed boundary

Because safe-output calls are the *only* side-effecting boundary (principle 1), no-post mode is a one-place swap: the harness drives §8.4 steps 1–4 against a fixture `pr-context.json`/`files.json`/`full.diff` and captures step 4's output to disk instead of calling safe outputs. This is what makes R5/R6/R11 exercisable without any GitHub write, and is the mechanism behind task-9-2 / task-10-4.

### 8.6 Router's one model touch (design constraint for S3)

The router core is pure deterministic TS. The only judgment it needs — diff-direction-dependent risk tiers (task-3-1) — stays *outside* the deterministic core: `router.ts` emits the ambiguous files as a bounded question; the orchestrator resolves that single small-model call (or a minimal sub-agent) and passes the answer back on a second `router` invocation. The deterministic core never calls a model, so it stays unit-testable (task-3-4) and inside the boundary.

### 8.7 Boundary enforcement (review gate wiring for principle 1 / R8 tripwire)

The physical split — CLIs transform JSON, models author prose — makes the converse tripwire (§0) mechanically checkable: any diff that adds prose synthesis to a file under `actions/review/`, or grows verdict/router scoring beyond the declared `severity`/`confidence` fields, is scope creep to reject in review. reviewer_plan/reviewers should treat "an `actions/review/*` CLI emitting a human-read sentence" as the tripwire signal.

### 8.8 Trigger-override integrity (interface §4.6)

Adding Surface-A bash invocations to the orchestrator prompt does not touch the workflow `on:`/label frontmatter, so webapp's manual `/review` and frontend's automatic mode (interface §4.6) are preserved by construction; the cross-cutting AC on S3/S6/S10 remains "no trigger-frontmatter regression."

> **Slice-DAG note (forest constraint):** the slice DAG must be a forest (each slice ≤1 parent). Multi-upstream slices below carry a single `dependencies` parent plus `serialized_chain_order` recording the full upstream order the orchestrator must respect. Code file paths under `workflows/review/lib/` are **indicative**; the architect finalizes the exact code-siting and the gh-aw single-session invocation mechanism (§1 architect dependency).

---

## Structured Task Appendix

```yaml
# yaml-tasks
pr:
  title: "review: roster restructure, determinism boundary, eval suite"
  description: |
    Implements the Khan/actions half of the "Improving the Khan PR review agent"
    proposal on top of #194: reliability P0s, the 13 remaining prompt edits, the
    determinism boundary (finding schema -> computed verdict -> templated rendering),
    a deterministic router that subsumes reviewer-mapper, all 11 specialist lenses
    plus the always-on reviewers, the thumbs feedback sweep, the wave-2
    recall/precision rebalance, and the full eval suite. No consumer-repo changes;
    consumer-named work is preserved as interface guarantees on the shared workflow.
  test_plan: |
    - Automated: vitest unit tests for the finding schema/validator, computed verdict
      (incl. hold-for-human), comment rendering, router (classification/tier/budget),
      per-finding tool-call cap, thumbs sweep, and the eval-suite runner; the smoke
      subset runs in CI on this repo via the shared no-post runner.
    - Manual: run the review workflow in no-post mode against the smoke corpus and
      confirm findings/verdict render without any GitHub write; rerun webapp PR #40536
      through the no-post harness with edits 8+10 and confirm the OpenAccess
      authorization question surfaces (R6).
  manual_steps: |
    Pre-merge: none (no migrations). Confirm the reviewer version stamp changes when
    prompt/config changes.
    Post-merge: consumer repos (webapp/frontend) inherit changes via `source:` import
    on their own schedule; the thumbs sweep and drift-guard stamp are deployable
    against both from day one but consumer wiring happens separately, later.
slices:
  - id: 1
    name: |-
      Foundations: finding schema, submission reliability, context staging
    goal: |-
      Establish the versioned structured finding schema, a single robust review
      submission call, and staged per-run context for all sub-agents. Unblocks the
      determinism boundary, the router, and the prompt edits.
    exit_criteria: |-
      Schema validates well-formed findings and rejects malformed ones; exactly one
      submission path exists; every sub-agent reads staged context from disk.
    tasks:
      - id: TASK-1-1
        description: |-
          R8(a): versioned structured finding schema + validator. Fields: id, lens,
          anchor (incl. a PR-level anchor type), severity, confidence, evidence_trace,
          optional suggested_patch, optional pre_merge_obligation, producing_hunt,
          model_authored_prose. Export a schema version constant.
        acceptance: |-
          Validator accepts a well-formed finding and rejects a malformed one; version
          constant exported and unit-tested.
        role: coder
        files:
          - "workflows/review/lib/finding-schema.ts"
      - id: TASK-1-2
        description: |-
          R1: standardize review submission on one robust call with a real body in the
          orchestrator prompt; remove the --body-stdin / empty-body retry dance.
        acceptance: |-
          Exactly one submission path documented in review.md; no empty-body fallback
          remains.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-1-3
        description: |-
          Prompt edit E2: stage pr-context.json on disk for ALL sub-agents (extends
          #194 diff staging). Foundation for the lenses in slice 7.
        acceptance: |-
          Every sub-agent dispatch reads context from the staged file.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-1-4
        description: |-
          Unit tests for the finding schema/validator (TASK-1-1).
        acceptance: |-
          Tests cover valid + malformed findings and the version constant; green.
        role: tester
        files:
          - "workflows/review/lib/finding-schema.test.ts"
  - id: 2
    name: |-
      Determinism boundary: computed verdict, rendering, missing-dimension gate
    goal: |-
      Compute the verdict in code from findings + posted-comment labels (with a
      hold-for-human path), render Conventional Comments from templates, and hold for
      a human when a core review dimension produced no output.
    dependencies: "slice-1"
    exit_criteria: |-
      Verdict is a pure function of schema + labels with an exercised hold-for-human
      path; missing core dimension holds for a human instead of approving.
    tasks:
      - id: TASK-2-1
        description: |-
          R8(b): computed verdict in code from findings + posted-comment labels,
          including a hold-for-human outcome for policy-named conflicts. Consume #194's
          mechanical label model (do not re-implement it). Pick and document a sensible
          blocking-threshold default (operator: implementer judgment, tunable later,
          not a HITL gate).
        acceptance: |-
          Verdict is a pure function of schema + labels; hold-for-human path covered by
          a test; chosen default documented.
        role: coder
        files:
          - "workflows/review/lib/verdict.ts"
      - id: TASK-2-2
        description: |-
          R2: never auto-approve when the correctness pass OR the skill/severity pass
          produced no output -- hold for a human. A lost pattern-triage may still
          note-and-continue. This is the gate atop #194's visibility-only note.
        acceptance: |-
          Missing core dimension -> hold-for-human (not approve-with-note); missing
          pattern-triage -> note-and-continue.
        role: coder
        files:
          - "workflows/review/lib/verdict.ts"
      - id: TASK-2-3
        description: |-
          R8(c): templated rendering of Conventional Comments from the schema. Code
          owns label-wrapping + template; models own every human-read sentence.
        acceptance: |-
          Rendering is deterministic given a finding; no prose synthesis in code.
        role: coder
        files:
          - "workflows/review/lib/render-comment.ts"
      - id: TASK-2-4
        description: |-
          Tests: verdict truth table (incl. hold-for-human + missing-dimension) and
          rendering snapshots.
        acceptance: |-
          Truth-table and snapshot tests green.
        role: tester
        files:
          - "workflows/review/lib/verdict.test.ts"
          - "workflows/review/lib/render-comment.test.ts"
  - id: 3
    name: |-
      Deterministic router (subsumes reviewer-mapper)
    goal: |-
      Classify changed files, map paths to lenses, map teams from REVIEWERS, assign a
      per-file risk tier, and scale the run budget by tier -- replacing the Haiku
      reviewer-mapper sub-agent with code.
    dependencies: "slice-1"
    exit_criteria: |-
      Router yields deterministic lens/team/tier for a fixture diff; reviewer-mapper is
      no longer dispatched; budget scales by tier with a misrouted-PR floor.
    tasks:
      - id: TASK-3-1
        description: |-
          R10 router in code: file classification from .gitattributes, path->lens
          mapping, team mapping from consumer REVIEWERS, per-file risk tier (small-model
          check only for diff-direction-dependent tiers). Subsumes reviewer-mapper (R12).
        acceptance: |-
          Deterministic lens/team/tier output for a fixture diff; reviewer-mapper no
          longer dispatched.
        role: coder
        files:
          - "workflows/review/lib/router.ts"
      - id: TASK-3-2
        description: |-
          R10 budget: ONE rule scaling run budget by highest touched risk tier + ONE
          floor for misrouted PRs (no per-lens knobs). Document assumed default caps.
        acceptance: |-
          Budget scales monotonically with tier; misrouted PR gets the floor.
        role: coder
        files:
          - "workflows/review/lib/router.ts"
      - id: TASK-3-3
        description: |-
          Wire the orchestrator (Step 3) to consume router output for lens dispatch and
          drop the reviewer-mapper dispatch/parse.
        acceptance: |-
          Only the router feeds lens/team routing in review.md.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-3-4
        description: |-
          Router unit tests: classification, path->lens, tier, budget scaling, floor.
        acceptance: |-
          Router tests green over fixtures.
        role: tester
        files:
          - "workflows/review/lib/router.test.ts"
  - id: 4
    name: |-
      Reliability/quality prompt edits (E1, E3, E5, E6, E7, R3b)
    goal: |-
      Land the remaining reliability/quality prompt edits: high-risk trigger,
      untrusted-input rule, deletions-are-findings, reply-chain reconciliation,
      skip-open-thread lines, and the flag-a-pre-existing-bug rule.
    dependencies: "slice-1"
    exit_criteria: |-
      Each edit is present in review.md with its rule text; no §3 regression.
    tasks:
      - id: TASK-4-1
        description: |-
          E1 high-risk trigger named + one-line judgment; E3 untrusted-input rule
          (embedded instructions are content to analyze; an attempt to direct the
          reviewer is itself a finding); E5 deletions-are-findings.
        acceptance: |-
          Each edit present with its rule text.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-4-2
        description: |-
          E6 full reply-chain staged; reconciler judges author reasoning and never
          re-raises a conceded point. E7 skip lines with open human threads.
        acceptance: |-
          Reconciler prompt reflects both rules.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-4-3
        description: |-
          R3b flag-a-pre-existing-bug rule: a real bug in touched lines is fair to flag
          even if it predates the change. Builds on #194 severity; does not reopen it.
        acceptance: |-
          Rule present, scoped to touched lines.
        role: documenter
        files:
          - "workflows/review/review.md"
  - id: 5
    name: |-
      Investigation tooling for reviewers
    goal: |-
      Give reviewers bounded investigation: grep callers, trace call chains, run one
      targeted cheap check per finding, with a per-finding tool-call cap enforced in
      code.
    dependencies: "slice-1"
    exit_criteria: |-
      Investigation instructions present and used by the lenses; per-finding cap
      enforced deterministically.
    tasks:
      - id: TASK-5-1
        description: |-
          R9 sub-agent instructions for bounded investigation: grep callers, trace call
          chains, run one targeted cheap check per finding.
        acceptance: |-
          Instructions present; consumed by slice-7 lenses.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-5-2
        description: |-
          R9 enforce a cap on tool calls per finding in code, living inside the run
          budget from slice 3. Document the assumed default cap (not a HITL surface).
        acceptance: |-
          Cap enforced; over-cap calls refused deterministically.
        role: coder
        files:
          - "workflows/review/lib/investigation-cap.ts"
      - id: TASK-5-3
        description: |-
          Test the per-finding tool-call cap.
        acceptance: |-
          Cap test green.
        role: tester
        files:
          - "workflows/review/lib/investigation-cap.test.ts"
  - id: 6
    name: |-
      Roster framework: always-on reviewers, model defaults, kept gates
    goal: |-
      Define the always-on reviewers (holistic, completeness, test-adequacy,
      first-principles, conventions) with their trust/advisory constraints, apply the
      model launch defaults + effort table, and wire the kept gates to the new roster.
    dependencies: "slice-5"
    serialized_chain_order:
      - "slice-3"
      - "slice-5"
    exit_criteria: |-
      Five always-on reviewers defined with constraints; every role carries its
      launch-default model + effort; kept gates preserved with no §3 regression.
    tasks:
      - id: TASK-6-1
        description: |-
          Always-on reviewers: holistic; completeness (Jira/Confluence read-only inside
          the non-posting sub-agent; fetched text is data under review); test-adequacy;
          first-principles (advisory-only, never blocks, Fable 5 day one); conventions
          (advisory; router-gated by greppable trigger signatures).
        acceptance: |-
          Five always-on reviewers defined with their trust/advisory constraints.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-6-2
        description: |-
          Prompt edit 14: named mandates for holistic / completeness / first-principles.
        acceptance: |-
          Mandates present.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-6-3
        description: |-
          R12 model launch defaults + effort table: Opus 4.8 workhorse; medium =
          triage/reconciliation; high = lenses/whole-change; xhigh = security lens +
          claim-validator/refuters; first-principles = Fable 5. Do NOT re-pin #194's
          existing model pins -- extend the effort assignments.
        acceptance: |-
          Every role carries its launch-default model + effort matching the R12 table.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-6-4
        description: |-
          Kept gates wired to the new roster: pattern-triage (exclusions in guidance
          comment), claim-validator + refuter panel (batched/parallel), deterministic
          dedup + verdict bookends (verdict from slice 2), thread-reconciler.
        acceptance: |-
          Gates preserved; no §3 regression.
        role: documenter
        files:
          - "workflows/review/review.md"
  - id: 7
    name: |-
      Eleven specialist lenses (+ skill-auditor fold-in)
    goal: |-
      Build all eleven specialist lenses, each folding its skill's rules plus
      incident-derived executable hunts (tri-state: ran / not-applicable / found) that
      emit into the finding schema. Fold skill-auditor into the lenses.
    dependencies: "slice-6"
    exit_criteria: |-
      All eleven lenses present with rules + tri-state hunts emitting valid schema
      findings; skill-auditor folded; correctness-checks.md extension point intact.
    tasks:
      - id: TASK-7-1
        description: |-
          Security & auth lens -- SINGLE lens, effort xhigh. Do NOT split it. If
          implementation shows a genuine need to split along the risk-config seam
          (authorization correctness vs. web/platform security), raise a HITL question
          (operator direction 7 / simplifier guardrail 2); do not split unilaterally.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort xhigh; no
          unilateral split.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-2
        description: |-
          AI safety & moderation lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-3
        description: |-
          Mass-comms & COPPA lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-4
        description: |-
          Caching & resource lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-5
        description: |-
          Data & migrations lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-6
        description: |-
          Concurrency & async lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-7
        description: |-
          API & federation compat lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-8
        description: |-
          Cross-deploy serialization lens: skill rules + incident-derived tri-state
          hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-9
        description: |-
          Deploy & infra config lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-10
        description: |-
          Money & payments lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-11
        description: |-
          Content & i18n lens: skill rules + incident-derived tri-state hunts.
        acceptance: |-
          Rules + tri-state hunts present; findings emit valid schema; effort high.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-12
        description: |-
          Remove the standalone skill-auditor dispatch once its checks fold into the
          lenses; ensure no consumer correctness-checks.md content is stranded
          (interface req §4.2).
        acceptance: |-
          skill-auditor folded; correctness-checks.md extension point intact.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-7-13
        description: |-
          Fixture-based tests that each lens's incident hunts fire on a known repro and
          report not-applicable on a clean fixture (reuse slice-9 fixtures where
          available).
        acceptance: |-
          Lens hunt fixtures green (fires on repro, not-applicable on clean).
        role: tester
        files:
          - "workflows/review/lib/lenses.test.ts"
  - id: 8
    name: |-
      Thumbs feedback sweep (independent deterministic code)
    goal: |-
      Collect 👍/👎 reactions at two grains, ask one follow-up per new 👎, and never
      re-ping -- pure code, deployable against both consumer repos from day one.
    dependencies: "slice-1"
    exit_criteria: |-
      One follow-up per new 👎, idempotent (never re-pings), works against either
      consumer repo's config.
    tasks:
      - id: TASK-8-1
        description: |-
          R4 thumbs sweep, pure code (no model): 👍/👎 at two grains; polling sweep
          collects reactions; one follow-up per NEW 👎 (incorrect / unimportant /
          unclear / duplicate + free text); never re-ping. Deployable against both
          consumer repos (interface guarantee §4.3) -- no consumer commit.
        acceptance: |-
          One follow-up per new 👎; idempotent (no re-ping); two-grain collection;
          config-driven for either repo.
        role: coder
        files:
          - "workflows/review/lib/thumbs-sweep.ts"
      - id: TASK-8-2
        description: |-
          Tests: new-👎 detection, single follow-up, no re-ping, two-grain collection.
        acceptance: |-
          Thumbs-sweep tests green.
        role: tester
        files:
          - "workflows/review/lib/thumbs-sweep.test.ts"
  - id: 9
    name: |-
      Smoke benchmark (tagged subset of the eval corpus)
    goal: |-
      Author a ~dozen-case smoke corpus (incident repros, adversarial-injection PRs,
      known-clean PRs) in the shared eval dataset format, run it through a shared
      no-post runner, and wire it as a CI gate on this repo. Must precede the wave-2
      rebalance.
    dependencies: "slice-2"
    exit_criteria: |-
      Smoke cases load via the shared loader; no-post run produces findings/verdict
      with zero GitHub writes; CI runs the smoke set green on baseline.
    tasks:
      - id: TASK-9-1
        description: |-
          R5 smoke corpus (~a dozen cases): incident repros, adversarial-injection PRs,
          known-clean PRs -- SAME dataset format as the slice-11 corpus (tagged subset,
          one harness).
        acceptance: |-
          Cases load with the shared loader; tags identify the smoke subset.
        role: coder
        files:
          - "workflows/review/eval/corpus/smoke/"
      - id: TASK-9-2
        description: |-
          R5 shared runner with a no-post run mode exercising the real review path
          without posting to any real PR.
        acceptance: |-
          Run mode produces findings/verdict with no GitHub write.
        role: coder
        files:
          - "workflows/review/eval/runner.ts"
      - id: TASK-9-3
        description: |-
          CI entry point running the smoke set on Khan/actions.
        acceptance: |-
          CI invokes the smoke set; green on baseline.
        role: tester
        files:
          - "workflows/review/eval/smoke.test.ts"
          - ".github/workflows/review-smoke.yml"
  - id: 10
    name: |-
      Wave-2 recall/precision rebalance
    goal: |-
      Land edits 8-13, the blocking-claim refuter panel, and the posting bar, verified
      against the smoke set so recall/precision do not regress while the rebalance
      ships. Includes the webapp #40536 causal experiment via the no-post harness.
    dependencies: "slice-9"
    serialized_chain_order:
      - "slice-7"
      - "slice-9"
    exit_criteria: |-
      Edits present; smoke set green (no must-catch recall regression, no new clean
      false-block); #40536 experiment recorded.
    tasks:
      - id: TASK-10-1
        description: |-
          Edits 8 (coverage first), 9 (blocking requires a concrete failing scenario),
          10 (drop only the refuted; downgrade the uncertain), 11 (confirm before you
          claim), 12 (cite exact lines or quote).
        acceptance: |-
          Each edit present.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-10-2
        description: |-
          Blocking-claim refuter panel (batched/parallel) + edit 13 posting bar: ranked
          posting; inline >= medium confidence; low-confidence in one collapsed section;
          suggested diffs where clear; no padding. Wire to the slice-2 verdict / slice-1
          confidence fields.
        acceptance: |-
          Posting bar + refuter panel wired to verdict/confidence.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-10-3
        description: |-
          Verify the rebalance against the slice-9 smoke set (no recall regression on
          must-catch; no new false-block on clean).
        acceptance: |-
          Smoke set green after rebalance.
        role: tester
        files:
          - "workflows/review/eval/smoke.test.ts"
      - id: TASK-10-4
        description: |-
          R6 causal experiment: rerun the reviewer on webapp PR #40536 with edits 8+10
          via the no-post harness (no consumer write). Success = the OpenAccess
          authorization question surfaces.
        acceptance: |-
          Experiment recorded; surfacing observed or a documented negative result.
        role: tester
        files:
          - "workflows/review/eval/experiments/webapp-40536.md"
  - id: 11
    name: |-
      Full eval suite (four datasets, five metrics, judge, version stamp)
    goal: |-
      Build the eval suite that measures what this run shipped: four datasets, five
      metrics, an Opus-4.8 LLM-judge with human audit, overfitting guards, an
      adversarial hard gate, and the reviewer version stamp that doubles as the single
      drift-guard surface.
    dependencies: "slice-9"
    serialized_chain_order:
      - "slice-7"
      - "slice-8"
      - "slice-9"
    exit_criteria: |-
      Four datasets load via the shared loader; five metrics computed; judge scores a
      run with an audit sample; version stamp changes on prompt/config change; smoke
      subset gates CI, full suite scheduled.
    tasks:
      - id: TASK-11-1
        description: |-
          Four datasets: incident repros; regenerated synthetic mutations mapped to
          lenses; golden set (human-comment + revert/follow-up labels); clean set. Built
          from Khan incident history + consumer PR records WITHOUT writing to consumer
          repos.
        acceptance: |-
          Four datasets load via the shared loader.
        role: coder
        files:
          - "workflows/review/eval/corpus/"
      - id: TASK-11-2
        description: |-
          Five metrics: must-catch recall (~100%), golden precision, clean false-block
          (~0), noise, calibration.
        acceptance: |-
          Metrics computed over a dataset run.
        role: coder
        files:
          - "workflows/review/eval/metrics.ts"
      - id: TASK-11-3
        description: |-
          Opus 4.8 LLM-judge with a human-audit sample; thumbs labels (slice 8)
          calibrate the judge.
        acceptance: |-
          Judge scores a run; audit sample surfaced.
        role: coder
        files:
          - "workflows/review/eval/judge.ts"
      - id: TASK-11-4
        description: |-
          Overfitting guards: golden-set holdout + fresh mutations; adversarial set as a
          hard gate for automatic mode.
        acceptance: |-
          Holdout separated; adversarial gate enforced.
        role: coder
        files:
          - "workflows/review/eval/gates.ts"
      - id: TASK-11-5
        description: |-
          Reviewer version stamp: hash of prompt+config stamped via the existing #194
          HTML marker. This is the SINGLE drift-guard surface (R14 reuses it; no new
          mechanism).
        acceptance: |-
          Stamp changes when prompt/config changes; readable by a consumer sync check.
        role: coder
        files:
          - "workflows/review/lib/version-stamp.ts"
      - id: TASK-11-6
        description: |-
          Suite self-tests + wire the smoke subset (slice 9) as the CI gate; full suite
          as scheduled (not per-PR).
        acceptance: |-
          CI runs smoke; full suite invocable on schedule.
        role: tester
        files:
          - "workflows/review/eval/suite.test.ts"
  - id: 12
    name: |-
      P2 items (R13, R14, R15, R16, R17)
    goal: |-
      Land the P2 follow-ups: per-finding resolution rule, the drift-guard
      documentation reusing the version stamp, live counters, dismissal-learning
      candidates, and the conditional-approval verdict.
    dependencies: "slice-11"
    serialized_chain_order:
      - "slice-8"
      - "slice-11"
    exit_criteria: |-
      Each P2 requirement present; drift guard adds no new mechanism; dismissal
      candidates are human-approved, never auto-adopted.
    tasks:
      - id: TASK-12-1
        description: |-
          R13 per-finding resolution rule on re-review: every actionable finding gets
          fixed / deferred-to-filed-issue / disagreed-with-reason.
        acceptance: |-
          Rule present.
        role: documenter
        files:
          - "workflows/review/review.md"
      - id: TASK-12-2
        description: |-
          R14 config drift guard: document the slice-11 version stamp as the stable
          consumer-readable sync surface (interface §4.5). Adds NO new mechanism.
        acceptance: |-
          Doc points to the stamp; no second surface.
        role: documenter
        files:
          - "workflows/review/README.md"
      - id: TASK-12-3
        description: |-
          R15 live counters mined from run logs + #194 per-run JSON artifacts: validator
          drop rate per lens, comments/PR, verdict mix, thumbs agree rate, cost/run.
        acceptance: |-
          Counters computed from existing artifacts; no new logging mechanism required.
        role: coder
        files:
          - "workflows/review/lib/counters.ts"
      - id: TASK-12-4
        description: |-
          R16 dismissal-learning: dismissed/resolved threads, 👎-with-replies, and
          correct pushback become candidate do-not-flag-here notes proposed as changes
          to a committed config file a human approves -- never auto-adopted.
        acceptance: |-
          Candidates written as a proposed diff for human approval; nothing
          auto-applied.
        role: coder
        files:
          - "workflows/review/lib/dismissal-learning.ts"
      - id: TASK-12-5
        description: |-
          R17 conditional-approval verdict: APPROVE + a prominent structured obligations
          comment via the existing add-comment safe output; renders from the schema's
          pre_merge_obligation field.
        acceptance: |-
          APPROVE-with-obligations renders from the schema; uses the existing safe
          output.
        role: coder
        files:
          - "workflows/review/lib/render-comment.ts"
```
