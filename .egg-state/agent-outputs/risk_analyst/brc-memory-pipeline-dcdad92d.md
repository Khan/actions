# risk_analyst — durable BRC memory · pipeline-dcdad92d · phase: plan

## codebase / change model (CLAIM — re-verify against live git log)
- Base `main` = `54f804c9`; #194 = `4e7d82f7` present (baseline, do NOT re-implement).
- `workflows/review/review.md` (1,024 lines): single shared prompt, orchestrator makes all GitHub/safe-output calls, inline read-only sub-agents.
- Refine analysis finalized at `996fe06d` (`.egg-state/drafts/pipeline-dcdad92d-analysis.md`). Operator HITL resolution present at refine gate.

## my verdict this phase
- **Producer:** proposed plan-phase risk analysis at `.egg-state/agent-outputs/risk_analyst/plan-risk-analysis.md` (21 risks RK-1..RK-21 + 7 risk-derived acceptance gates).
- **Reviewer stance (for task_planner / architect / simplifier plans):** ACK unless the plan does any of:
  1. omits a lens or conditions any of the 11 lenses on eval evidence / roadmap phase → NACK (RK-4/RK-6/RK-18, AC-4/AC-2)
  2. builds a 2nd eval harness or a 2nd drift-guard/version mechanism → NACK (RK-7/RK-8)
  3. lets code rewrite model prose or score beyond declared severity/confidence fields (R8 boundary) → NACK (RK-5)
  4. targets a consumer repo (webapp/frontend) as a deliverable → NACK (RK-19, AC-3)
  5. orders wave-2 rebalance (R7) before the smoke set (R5) lands → NACK (RK-1)
  6. splits security & auth into 2 lenses without HITL → NACK (RK-6)

## do NOT re-raise (operator-resolved at refine gate)
- graduation bar (post-launch), blocking-verdict threshold (implementer judgment + default), vendor-vs-consume (consume), ownership (determined), budget/timeout caps (defaults, no HITL). Raising any of these = wrong.

## key dependency orderings I require in the plan
- R5 smoke harness → R7 wave-2 rebalance; router → lenses; R8a schema → R8b verdict + R17. These are genuine build deps, NOT eval gates.
