# Simplification Guidance — plan phase (pipeline-121df67a)

Role: simplifier · Phase: plan · Repo: Khan/actions · Base: main
Inputs: operator-approved refine spec `.egg-state/drafts/pipeline-121df67a-analysis.md`
(R1–R17 + R3b, HITL-gated 2026-07-02), ratified eight scope controls (refine gate),
resolved cq-1 (incident-mapped top-4 lenses), contract `task_description`.

The refine gate ratified the scope; the plan phase's failure mode is different:
**structure creep** — a plan that respects every scope boundary but slices, gates,
and staffs the work so it costs more than the spec requires. This document is the
simplifier's plan-shaped constraints. I will review the architect's/planner's
proposals against sections P1–P8.

## P1. Slice by proposal phase, not by requirement or role

The natural slice boundaries are the spec's four phases: (1) R1–R4 + R3b,
(2) R5–R8, (3) R9–R12, (4) R13–R17. Seventeen R-numbers are NOT seventeen slices;
fifteen roster roles are NOT fifteen tasks (only the cq-1 four + always-on set +
router exist as build items at all). A plan with more than ~4–6 slices for this
pipeline should justify each extra boundary.

## P2. Atomicity constraints the spec makes explicit

- **R7 ships as ONE unit** (edits 8, 9, 10, 11, 12, 13's posting bar + refuter
  panel). The plan must not split it into separately-landable tasks: recall-first
  without the downgrade/refute rules downstream is noise-first, per the proposal.
- **R8 is one incremental workstream** (schema → computed verdict → templated
  rendering), strictly in that order, a few hundred lines total, never a framework.
  Not three parallel tasks; not a shared library.
- **R5 precedes R7** (smoke set gates the rebalance) and **R6 precedes R7's
  landing decision** (the cheap causal experiment). Nothing else in Phase 1–2
  depends on eval infrastructure.

## P3. Gate structure: only what can regress gets a gate

- Phase-1 items (R1, R2, R3/R3b, R4) gate on **nothing** — no benchmark, no smoke
  set, no schema work. A plan that puts any eval or schema dependency in front of
  them violates the ratified controls.
- Phase-3/4 items gate on **measured evidence**, so the plan should encode them as
  conditional/gated tasks, not an unconditional schedule. In particular each
  non-top-4 lens must appear in the plan ONLY as the deferral mechanism
  (eval-gated, `correctness-checks.md` interim home) — zero named build tasks.
- The adversarial set is a hard gate for *automatic mode*, which is out of scope
  here (graduation is a consumer/operator decision); the plan needs it in R11's
  dataset work but must not attach an automatic-mode rollout task to it.

## P4. cq-1 is settled — plan exactly these four lenses

security & auth, AI safety & moderation, mass-comms & COPPA, caching & resource.
The plan must not re-open the selection, must not add a fifth (the R10
authz-vs-web/platform split seam stays advisory prose), and must not schedule
data & migrations / concurrency & async / API & federation compat /
cross-deploy serialization / deploy & infra config / money & payments /
content & i18n as tasks.

## P5. Zero model changes in Phase 1 (ratified)

#194's pins are the baseline. R12 is Phase 3 and each move is benchmark-gated,
including every Fable arm (first-principles' day-one Fable rides with its role's
creation in Phase 3, not earlier). Any Phase-1/2 task that edits a model pin is a
defect.

## P6. Consumer repos: interface criteria, not tasks

§6's six interface requirements attach as **acceptance criteria on shared-side
tasks** (e.g. "sweep is deployable against both consumer repos" is a criterion of
R4's task), never as standalone tasks and never as work items targeting
webapp/frontend. The R6 experiment reads a webapp PR (#40536) — read-only, in the
no-post run mode; the plan must be explicit it posts nothing to consumer repos.

## P7. Open Questions stay HITL

Graduation bar registers as a HITL decision at proposal-phase 4 when it first
gates something (per the approved spec §7) — the plan should carry that as a
decision point, not a task. Blocking-verdict policy likewise. Vendor-vs-consume is
resolved for this pipeline (build in the shared workflow; keep §6.2/§6.5 extension
points). Ownership is organizational — no task.

## P8. Smallest honest plan skeleton (reference shape, not a mandate)

- Slice 1 (Phase 1, gates on nothing): R1+R2 submission/hold-for-human; R3+R3b
  prompt edits; R4 thumbs sweep. All inside `workflows/review/review.md` + one
  sweep job.
- Slice 2 (Phase 2): R5 smoke set + no-post run mode → R6 experiment → R7 as one
  unit → R8 (a) schema, (b) computed verdict, (c) rendering.
- Slice 3 (Phase 3, evidence-gated): R9 investigation tooling; R10 router +
  always-on + the cq-1 four lenses + skill-auditor fold-in + edit 14; R11 full
  suite growth; R12 model/effort table.
- Slice 4 (Phase 4): R13 resolution rule; R14 shared-side drift surface; R15
  counters; R16 dismissal-learning; R17 conditional approval. Plus the phase-4
  HITL registration for the graduation bar.

A plan materially larger than this shape carries the burden of showing which spec
requirement forces the extra structure.

## Summary of assessment

The approved spec already sequences and scopes the work correctly; the plan is
correct insofar as it inherits that structure without inflating it. Dominant plan
risks: requirement-per-slice explosion (P1), splitting R7/R8 atoms (P2),
front-loading eval/schema infrastructure before Phase 1 (P3), and re-opening
settled decisions (P4, P7). I will ACK a plan that matches P1–P8 and NACK one that
violates them, citing the ratified controls.

enrichment_sha: (set at commit)
