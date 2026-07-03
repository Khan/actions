# task_planner durable BRC memory — pipeline-dcdad92d (plan phase)

## Verdict / state
- **PROPOSED** the plan artifact `.egg-state/drafts/pipeline-dcdad92d-plan.md` at commit `618217a3a45b7862519ec0688dfa5f36a234653c` (BRC version 1).
- Reviewers to converge: **reviewer_plan, risk_analyst, simplifier**. Awaiting their ACK/NACK. On NACK, revise the named point and re-propose (re-merge remote tip first — the gateway pushes to the shared `egg/pipeline-dcdad92d/work` branch and it advances between my invocations).
- Attestation: `no_decisions_rationale` (no plan-time HITL; four proposal open questions resolved by operator at refine gate; security-lens split is a pre-declared implement-time HITL trigger only).

## Plan shape (do not re-derive from scratch)
- **12 slices / 56 tasks.** Content: S1 Foundations (schema+submission+context) · S2 Determinism boundary (verdict/render/missing-dim gate) · S3 Router (subsumes reviewer-mapper) · S4 Reliability prompt edits (E1,E3,E5,E6,E7,R3b) · S5 Investigation tooling · S6 Roster framework (always-on + models + gates) · S7 Eleven lenses · S8 Thumbs sweep · S9 Smoke benchmark · S10 Wave-2 rebalance (+R6) · S11 Full eval suite · S12 P2 (R13-R17).
- **Linear spine forced by #3046**: `review.md` is touched by 8 slices (1,3,4,5,6,7,10,12); same-file writers must be on ONE dependency chain. Deps: 1←2←3←4←5←6←7←9←10←11←12, and **8←1** (thumbs is file-disjoint, the only parallel branch). Other overlaps: render-comment.ts {2,12}, smoke.test.ts {9,10} — both satisfied by the spine.
- Prose separates **real build upstreams** (each slice's §3 line) from **serialization order** (spine parent). Reviewers may push back that the spine over-serializes — the defense is #3046: it is a tooling integration constraint, not a claim of real dependency; documented explicitly.

## Hard constraints honored (cite if challenged)
- Operator-named AC2 edges are REAL: schema(S1)→verdict(S2), router(S3)→lenses(S7), smoke(S9)→wave-2(S10).
- All 11 lenses are build tasks (TASK-7-1..7-11). Security = single xhigh lens; split only via implement-time HITL (op dir 7 / simplifier guardrail 2).
- Model launch defaults are build tasks (TASK-6-3); Fable arms = post-suite notes only. No roadmap/eval-gated deferral anywhere. No consumer-repo deliverables (interface guarantees §4). #194/§3 = build-upon, not redone.
- Determinism boundary = plumbing-only; one harness / one version-stamp surface / one budget rule (simplifier guardrails).

## Merges already absorbed
- Architect's **§8** (code siting → `actions/review/*`, gh-aw single-session bash/JSON invocation) is merged into the plan and CONVERGES with my decomposition (no re-ordering). Appendix `files:` remain indicative `workflows/review/lib|eval/*` per architect's explicit name-for-name mapping framing — do NOT rewrite them unless the architect asks.

## Role↔file fixes applied (don't regress)
- `.github/*` is blocked for ALL producer roles → CI workflow staged at `.github-staging/review-smoke.yml` (coder, TASK-9-4); smoke test itself is TASK-9-3 (tester) under existing `pnpm test`.
- TASK-10-4 (R6 experiment note `eval/experiments/webapp-40536.md`) = **documenter** (tester is blocked from that .md).
- Roles: coder=TS under lib/eval + staged yml; documenter=review.md/README/experiment md; tester=*.test.ts. All 56 tasks pass the role allowlist.

## Validation recipe (re-run before any re-propose)
`cd /opt/egg-runtime; python3` with `sys.path.insert(0,'shared')`: `parse_plan` + `validate_plan_preflight(content)` must be None/0-warnings; simulate #3046 (each overlapping file's slices comparable in the `dependencies` ancestry); check `egg_restrictions.patterns.AGENT_PATTERNS[role].can_write(path)` for every task file. Last run: all clean.
