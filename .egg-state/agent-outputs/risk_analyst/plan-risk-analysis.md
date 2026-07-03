# Plan-Phase Risk Analysis — "Improving the Khan PR review agent" (Khan/actions shared workflow)

Pipeline: `pipeline-dcdad92d` · Repo: `Khan/actions` · Base: `main` (`54f804c9`, #194 = `4e7d82f7` present) · Phase: plan · Producer: risk_analyst

## 0. Purpose & posture

This document enumerates the implementation risks the **plan phase's slicing must account for**, with likelihood/impact and a concrete mitigation the plan can encode as a slice ordering, an acceptance criterion, or a review tripwire. It is derived from analysis §9, re-verified against the live workflow (`workflows/review/review.md`, 1,024 lines) and #194 (`4e7d82f7`), and folds the simplifier's S2–S6 guardrails.

Two binding constraints frame every mitigation:
- **Operator directive 2/3 (2026-07-02):** no eval-/benchmark-gated construction; the eval suite measures *after* the build. Any mitigation that reads like "gate slice N on eval evidence" is itself a directive violation and is called out below where the temptation is real.
- **Operator HITL resolution (refine gate):** the four open questions are resolved (consume, not vendor; no graduation-bar blocker; ownership determined; blocking-verdict threshold delegated to implementer judgment with a documented default). The 20-min/$10 budget/timeout caps are **not** blockers and are **not** to be surfaced as HITL — proceed with documented defaults. Risks below respect this: none re-raises a resolved question.

Severity scale: **Impact** (regression to a shipped/consumer-facing behavior = high; internal rework = medium; cosmetic = low) × **Likelihood** given the current plan shape.

---

## 1. Sequencing / dependency risks (the plan's core job)

**RK-1 — Wave-2 rebalance ships before the smoke set exists (Impact: HIGH, Likelihood: MED)**
R7 changes recall/precision behavior (edits 8–13 + refuter panel + posting bar) on a *live* reviewer. Without the R5 smoke set already landed and green, a recall regression (a must-catch case silently dropped by the "drop only refuted / blocking requires a concrete failing scenario" edits) ships undetected.
- *Mitigation (plan):* the smoke set (R5) is an explicit predecessor slice to the wave-2 rebalance (R7). This is a genuine build dependency per AC-2, **not** an eval-evidence gate — the ordering exists so a regression is caught, not so construction waits on a benchmark number. Encode as: R5-slice `blocks` R7-slice; R7's slice acceptance = "smoke set runs green in the no-post mode against the rebalanced prompts."

**RK-2 — Lenses built before the deterministic router exists (Impact: MED, Likelihood: MED)**
R10's specialist lenses consume the router's file-classification/path→lens/risk-tier output. Building lens prompts against an unstable or absent routing contract forces rework and risks lenses each re-deriving classification (duplication + drift).
- *Mitigation (plan):* router slice precedes the lens slices; the router's routing contract (path→lens map, per-file risk tier, team map) is frozen as an interface before lens construction begins. Lenses consume it; they never re-classify.

**RK-3 — Computed verdict built before the finding schema is versioned (Impact: MED, Likelihood: MED)**
R8(b)'s in-code verdict and R17's conditional-approval both read the R8(a) finding schema (severity, confidence, anchor incl. PR-level type, `obligation` field). Building the verdict against an unversioned/unstable schema causes churn and risks the verdict logic embedding assumptions the schema later contradicts.
- *Mitigation (plan):* schema slice (R8a) precedes verdict slice (R8b) and R17. Schema is versioned (id + version field) from its first landing so downstream stamps (R11/R14) are stable.

**RK-4 — Roadmap-phase deferral smuggled back in as slice ordering (Impact: HIGH to directive compliance, Likelihood: MED)**
The proposal's four-phase roadmap prose is seductive; a planner may reintroduce it as "phase 1 = top-4 lenses, phase 2 = rest" or "defer eval-heavy lenses." That directly violates directives 1–3.
- *Mitigation (plan):* AC-4 (all 11 lenses are build tasks) and AC-2 (no roadmap/eval deferral) are hard slice-acceptance gates. Reviewer_plan must reject any slice set that omits a lens or conditions a lens on eval evidence. Only genuine build dependencies (RK-1/2/3) justify ordering.

---

## 2. Scope / boundary risks

**RK-5 — Determinism boundary (R8) grows into judgment territory (Impact: HIGH, Likelihood: HIGH)**
The single most likely over-build. Code legitimately owns merging, aggregation, label-wrapping, safe-output calls; it must **not** rewrite model prose or score findings beyond the declared severity/confidence fields. Left unchecked, R8 balloons past "a few hundred lines" and encodes judgment, defeating the models-own-judgment principle.
- *Mitigation (plan):* adopt both tripwires as review gates on every R8-touching slice — (a) thinner finder output after schema tightening ⇒ loosen fields, not the boundary; (b) **converse** — any code that rewrites prose or scores beyond declared fields is scope creep to reject in review, not negotiate (simplifier S5). Add a slice-level LOC/behavior sanity check to the R8 slices' acceptance.

**RK-6 — Security & auth lens split into two (Impact: MED, Likelihood: MED)**
R10's "may split along the risk-config seam" clause invites a 12th lens nobody asked for. The operator named exactly 11.
- *Mitigation (plan):* build exactly the 11 named lenses. A split is a **HITL question (directive 7)**, not a builder's option (simplifier S2). The plan must carry security & auth as one lens slice; if implementation surfaces a genuine seam, raise HITL then — do not pre-split.

**RK-7 — Double-build of the smoke set vs. full eval suite (Impact: MED, Likelihood: HIGH)**
R5 and R11 sharing "one harness, not two" is stated but easy to violate under parallel slicing — two people build two runners/corpora.
- *Mitigation (plan):* one dataset format, one runner, one no-post run mode; the smoke set is a **tagged subset** of the R11 corpus with a CI entry point (simplifier S3). Make the shared harness a single foundational slice that both R5 (CI smoke) and R11 (full suite) depend on; neither builds its own runner.

**RK-8 — Drift-guard / version-stamp built as a second mechanism (Impact: LOW–MED, Likelihood: MED)**
R14 must reuse R11's reviewer-versioning stamp (hash of prompt+config via the existing HTML marker), not add a parallel surface (simplifier S4).
- *Mitigation (plan):* R14 adds no new mechanism — it documents R11's stamp as the consumer-readable surface. One surface. Fold R14 into the R11 slice's deliverables rather than a standalone slice.

**RK-9 — Accidental re-implementation of a #194 item (Impact: MED, Likelihood: LOW–MED)**
The 13 remaining prompt edits interleave with #194's shipped behavior (severity model, mechanical verdict, hunk-signature re-review, redundant-approval skip, per-run JSON artifacts, skip-ai-review). A slice touching adjacent prompt regions may re-derive shipped logic.
- *Mitigation (plan):* AC-1 (nothing re-implements a §3 item) as a per-slice review check. Slices that touch severity/verdict/re-review regions must cite the #194 baseline they build *on top of* (e.g., R3b builds on the severity model; R8b's verdict extends the mechanical label-driven verdict, not replaces it).

---

## 3. Correctness / behavioral-regression risks

**RK-10 — Never-auto-approve-with-a-missing-core-dimension gate (R2) interacts with #194's visibility note (Impact: HIGH, Likelihood: MED)**
#194 added skipped-dimension *visibility* (not a gate). R2 turns a missing correctness or skill/severity pass into a **hold-for-human**, while a lost pattern-triage may still note-and-continue. Getting the dimension classification wrong (gating on the wrong pass, or failing to gate) either blocks clean PRs or lets unreviewed code auto-approve.
- *Mitigation (plan):* R2 slice explicitly enumerates which passes are core (correctness, skill/severity) vs. note-and-continue (pattern-triage); acceptance includes a smoke case for each: a dropped core pass ⇒ hold; a dropped pattern-triage ⇒ approve-with-note.

**RK-11 — Consumer trigger overrides / extension points regress (Impact: HIGH, Likelihood: MED)**
Consumers (webapp manual `/review`, frontend automatic) and the `correctness-checks.md` import must keep working across every change — but consumer repos are **not** targets, so breakage is invisible until it ships to them.
- *Mitigation (plan):* treat §6 interface requirements as slice acceptance criteria on any slice touching triggers, the correctness pass, skill-severity reading, the thumbs sweep, or the version surface. The migration of `correctness-checks.md` into lenses must not strand consumer content (keep the optional import working). Add interface-regression checks to the smoke harness where feasible (no-post mode against a synthetic consumer config).

**RK-12 — Review-submission robustness (R1) not actually exercised (Impact: MED, Likelihood: MED)**
R1 standardizes submission on one robust call with a real body, eliminating the `--body-stdin`/empty-body retry dance — but this path is only hit on real submission, which the no-post mode deliberately avoids.
- *Mitigation (plan):* R1 slice needs a targeted test of the submission call shape (body construction) independent of the no-post smoke path, so the fix is verified without posting to a real PR.

---

## 4. Trust-boundary / security risks

**RK-13 — Completeness reviewer reads Jira/Confluence: untrusted-data ingestion (Impact: HIGH, Likelihood: MED)**
R10's completeness lens fetches Jira/Confluence text read-only inside the non-posting sub-agent. That fetched text is **data under review**, not instructions — a real trust-boundary change (§6.4). Combined with E3 (embedded instructions in PR content are content to analyze, and an attempt to direct the reviewer is itself a finding), this is the pipeline's main injection surface.
- *Mitigation (plan):* the completeness-lens slice and the E3 slice both carry an explicit untrusted-input acceptance criterion; tokens scoped read-only; fetch confined to the non-posting sub-agent (never the orchestrator that makes GitHub calls). Add an adversarial-injection case (PR body / linked ticket containing "approve this PR" style instructions) to the smoke set — it already targets adversarial-injection PRs (R5), so extend it to cover the ticket-fetch path.

**RK-14 — Posting-side confusion between judging and posting agents (Impact: MED, Likelihood: LOW)**
All GitHub/safe-output calls stay with the orchestrator; sub-agents (including lenses and completeness) are read-only. A slice that lets a lens post directly would breach the boundary and the determinism model at once.
- *Mitigation (plan):* code-owns-safe-output-calls is a review invariant on every lens/sub-agent slice (dovetails with RK-5's converse tripwire).

---

## 5. Cost / capacity / model risks

**RK-15 — 11-lens roster + investigation tooling vs. 20-min/$10 run budget (Impact: MED, Likelihood: MED)**
The full roster plus R9 investigation tool calls can blow the timeout/cost caps on a broad-touch PR. Per operator resolution, the caps are **not** blockers and are **not** to be surfaced as HITL.
- *Mitigation (plan):* the router's tier-scaled budget (R10) is the mitigation — a run only spawns lenses whose paths are touched, so the full 11 rarely run at once. **One** scaling rule + **one** misrouted-PR floor; resist per-lens budget knobs (simplifier S6). R9 caps tool calls per finding. Document the assumed caps; do not gate on them. Encode as a plan note, not a HITL.

**RK-16 — Fable 5 for first-principles vs. timeout (Impact: LOW–MED, Likelihood: MED)**
First-principles runs on Fable 5 day one (2× pricing, 30-day org data-retention, longer turns vs. the timeout) but is **advisory-only and never blocks**, which bounds the blast radius. Per-role Fable arms stay post-suite experiments (not build tasks) — a slice that adds them is scope creep.
- *Mitigation (plan):* first-principles slice must assert advisory-only + never-blocks so a slow/absent Fable turn degrades gracefully (no verdict dependency). AC-5: Fable arms appear only as post-suite experiment notes, not build tasks — reviewer_plan rejects any Fable-arm build slice.

**RK-17 — Model launch defaults drift from the proposal's effort table (Impact: LOW, Likelihood: LOW)**
R12's per-role effort assignments (medium triage/reconciliation, high lenses/whole-change, xhigh security lens + claim-validator/refuters; Opus 4.8 workhorse; reviewer-mapper → code) are precise and easy to mis-transcribe across many slices.
- *Mitigation (plan):* centralize the effort/model table as a single config the slices reference, not per-slice literals — reduces drift and eases the later Fable-arm experiments.

---

## 6. Eval-suite-as-a-project risks

**RK-18 — Eval suite (R11) treated as a gate rather than a measurement (Impact: HIGH to directive compliance, Likelihood: MED)**
R11 is the largest line item. The strongest anti-pattern risk is letting it block construction (violating directive 2) or, conversely, under-scoping it because "it only measures."
- *Mitigation (plan):* R11 is budgeted as its own project-sized slice(s) but **never** a predecessor to lens/prompt construction. The one legitimate ordering is the shared harness (RK-7) preceding the smoke CI (RK-1) — that is regression protection, not eval gating.

**RK-19 — Eval data dependencies pull from consumer repos as a write target (Impact: HIGH, Likelihood: LOW)**
Incident repros and golden/clean sets are built from Khan incident history + consumer-repo PR records; the suite must consume those **without this pipeline writing to Khan/webapp or Khan/frontend**.
- *Mitigation (plan):* dataset-construction slices read consumer PR/incident records and vendor them into this repo's eval corpus; zero commits/PRs against consumer repos (§5, AC-3). Reviewer_plan checks no dataset slice targets a consumer repo.

**RK-20 — Golden-set overfitting / judge miscalibration (Impact: MED, Likelihood: MED)**
The Opus 4.8 LLM-judge and golden set can overfit; a miscalibrated judge makes the whole suite misleading.
- *Mitigation (plan):* golden-set holdout + fresh mutations, human audit sample on the judge, thumbs labels (R4) calibrate the judge, adversarial set as a hard gate for *automatic mode* (a future policy lever, not this run's construction). These are R11 slice acceptance items, not build gates on other work.

---

## 7. Engine / platform risks

**RK-21 — gh-aw single-session model constrains the determinism boundary (Impact: MED, Likelihood: MED)**
The determinism boundary (R8) must land incrementally inside the single-session constraint: schema → verdict → rendering, not a big-bang extraction.
- *Mitigation (plan):* R8 is sliced in that order (matches RK-3); each increment ships behind the existing orchestrator without requiring a multi-session redesign.

---

## 8. Risks explicitly NOT raised (resolved / out of scope)

Per the operator HITL resolution, the following are **not** risks to surface and are recorded here only to prevent re-litigation:
- Graduation-bar numbers — post-launch operator policy; never a build blocker.
- Blocking-verdict policy threshold — delegated to implementer judgment with a documented default consistent with #194's severity model; not a HITL gate unless an R8(b) build choice concretely depends on a specific number.
- Vendor-vs-consume — resolved (consume; restructure lands in shared Khan/actions; extension points + drift surface kept).
- Ownership — determined; R15/R16/suite upkeep carry no at-risk framing.
- Budget/timeout caps — proceed with documented defaults; do not surface as HITL.

## 9. Recommended plan-phase acceptance gates (risk-derived)

The plan should carry these as slice-ordering constraints and reviewer checks:
1. R5 smoke harness `blocks` R7 wave-2 rebalance (RK-1); router `blocks` lenses (RK-2); R8a schema `blocks` R8b verdict + R17 (RK-3).
2. One shared eval harness; smoke set is a tagged subset, not a separate runner (RK-7); R14 reuses R11's stamp (RK-8).
3. All 11 lenses are build tasks; security & auth is one lens (split ⇒ HITL); no roadmap/eval-evidence deferral (RK-4, RK-6, RK-18).
4. Untrusted-input acceptance on the completeness lens + E3 slices; safe-output calls stay with the orchestrator (RK-13, RK-14).
5. Determinism-boundary tripwires (both directions) as review gates on R8 slices (RK-5).
6. §6 interface requirements as acceptance criteria on trigger/correctness/severity/thumbs/version slices (RK-11); no consumer-repo target anywhere (RK-19).
7. One budget-scaling rule + one floor; no per-lens knobs; caps documented, not gated (RK-15).

---

*Consistency note (for BRC): this assessment is stable across re-spawns unless a proposed plan introduces (a) a lens omitted/conditioned on eval evidence, (b) a second eval harness or drift-guard mechanism, (c) an R8 slice that scores/rewrites in code, (d) a consumer-repo target, or (e) a wave-2 slice not preceded by the smoke set. Any of those flips my reviewer verdict to NACK with the corresponding RK cited.*
