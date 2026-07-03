# Simplifier durable BRC memory — pipeline-dcdad92d

## Phase history

- **refine (complete, operator-approved)**: proposed v1 (`4ac141b4`), report + required human summary at `.egg-state/drafts/pipeline-dcdad92d-analysis-human.md` (NOTE: the propose gate REQUIRES that exact human-summary path; expect a plan analog on plan proposes). All six refine findings (S1–S6) were folded into the finalized analysis (`996fe06d`). HITL resolutions persisted (`8abb035f`): no graduation-bar work; blocking threshold = implementer default, documented, no HITL; consume-not-vendor; ownership determined (at-risk framing removed); budget caps = reasonable documented defaults, never surfaced as blockers.
- **plan (current)**: producing guardrails; see below.

## Current state (plan phase)

- **Proposed**: v1 accepted, `enrichment_sha: a71070e79777b28e07368ed3e22214fb3e62bc72`, reviewer: reviewer_plan. Artifacts: `plan-simplification-report.md` + required human summary `.egg-state/drafts/pipeline-dcdad92d-plan-human.md` (plan-gate-required path, confirmed; update it on any re-propose and once the task_planner's actual slice list lands).
- Input assessed: finalized analysis `996fe06d` + HITL `8abb035f`. No plan draft existed at assessment time — guardrails are prospective; my reviewer verdict on the actual plan applies them.

## summary_of_assessment (claim)

Plan guardrails P1–P7:
- **P1** only 3 real dependency chains (router→lenses; schema→verdict→rendering; smoke→wave-2) + R6-after-edits-8/10; any other ordering is fake — NACK under AC-2.
- **P2** lenses = ONE template task + 11 instantiations; skill-auditor retirement rides the lens slices. Biggest over-build risk.
- **P3** subsumptions are single build-and-replace tasks (router/reviewer-mapper; skill-auditor/lenses).
- **P4** HITL resolutions delete work: no graduation-bar tasks, no blocking-threshold HITL/slice (implementer default inside R8(b)), no ownership caveats, no cap-raising tasks or cap questions (R9 builds inside current caps).
- **P5** coherent slices, not one per R-number (indicative grouping in report §P5).
- **P6** R14 and R17 are riders (doc line in R11 slice; render path on R8(c)), not slices.
- **P7** §6 interface guarantees = acceptance criteria on the slices that could break them; neither standalone verify-tasks nor omission.

## Reviewer stance (for my reviewer_phase duties on the plan)

ACK a plan that: orders only by P1's edges; templates the lenses (P2); keeps subsumptions unified (P3); resurrects no HITL-deleted work (P4); groups coherently (P5); keeps R14/R17 as riders (P6); attaches §6 constraints to slices (P7); satisfies refine AC-1..5 (esp. all 11 lenses as build tasks, launch-default models as build tasks, Fable arms as notes only, no consumer-repo deliverables, no eval-evidence deferral).
NACK-worthy: fake ordering/deferral (AC-2 violation), missing lenses or model defaults (AC-4/5), consumer-repo targets (AC-3), re-implementing §3/#194 items (AC-1), resurrected HITL work (P4). P5/P6/P7 misses alone = push in ACK notes or single NACK only if pervasive.

## HITL ledger

No decisions registered in plan phase; rationale: the operator's refine-gate resolutions closed every open judgment call that could gate planning; remaining P-findings are guardrails, not decisions. S2's conditional security-lens-split HITL still owned by implement phase if the need materializes.
