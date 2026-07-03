# Architect BRC memory — pipeline-dcdad92d (plan phase)

## My proposal state
- **PROPOSED v1** @ commit `0311b988` (2026-07-03). Reviewers: `reviewer_plan`, `risk_analyst`.
- Artifacts:
  - `.egg-state/agent-outputs/pipeline-dcdad92d-architect-slices.yaml` — **authoritative forest slice scaffold** (contract population reads this exact path).
  - `.egg-state/agent-outputs/pipeline-dcdad92d-architect-output.json` — structured architect-output (gate reads this exact path).
  - `.egg-state/drafts/pipeline-dcdad92d-plan.md` — added §8 (architect integration/siting) on top of the task_planner's §0–§7 + yaml appendix.

## Role division (learned)
- **task_planner** owns the slice/task decomposition (plan.md `# yaml-tasks` appendix: slices, tasks, files, roles).
- **architect** owns: (a) the authoritative `architect-slices.yaml` scaffold (forest structure + serialized_chain_order), and (b) the technical-design decision the task_planner explicitly deferred (plan §1 forest-note): how the R8/R10 code integrates in the gh-aw single-session model, and where it is sited.
- We independently CONVERGED on the same linear spine — endorse, don't relitigate.

## Key decisions (keep consistent across re-invocations)
1. **Forest = single linear spine** S1→S2→S3→S4→S5→S6→S7→S9→S10→S11→S12, with **S8 (thumbs, file-disjoint) parallel off S1**. Forced by `workflows/review/review.md` being edited by 8 slices (overlap #3046) + convergence code-availability. Validated: `egg_contracts.plan_parser.validate_forest` = VALID, `validate_slice_file_overlap` = NONE.
2. **serialized_chain_order** (architect-emitted) records each slice's GENUINE upstream deps (analysis DAG), distinct from the spine `dependencies` edge. Operator edges honored: schema(S1)→verdict(S2), router(S3)→lenses(S7), smoke(S9)→rebalance(S10).
3. **Code siting = `workflows/review/lib/` + `workflows/review/eval/`** (review-internal code in the self-contained `workflows/review/` package). NOT `actions/` — that's for `action.yml`-bearing reusable composite actions consumed via `uses:`. (Reversed an earlier actions/review/ draft; fixed the stale forest-note ref.)
4. **Integration mechanism:** deterministic TS CLIs invoked by the orchestrator via `bash` (`node -r @swc-node/register`) over JSON in `/tmp/gh-aw/review/`; orchestrator = single session + sole safe-output caller. Three surfaces: A in-session CLIs, B standalone scheduled workflows (thumbs/counters/dismissal), C no-post eval harness.
5. No #194 re-implementation; consumers interface-only; trigger overrides preserved; no HITL registered (all open questions operator-resolved at refine gate; security-lens-split + blocking-verdict-threshold are HITL-if-a-build-choice-depends, not live now).

## On next invocation
- If action=propose again / NACK received: re-verify origin tip, rebase, keep the scaffold verbatim-consistent with the task_planner's latest appendix (spine deps) + my serialized_chain_order; re-run the two validators before re-proposing.
- Push protocol: `mcp__brc__propose` pushes first; on non-fast-forward, `git fetch` + `git rebase origin/egg/pipeline-dcdad92d/work`, resolve plan.md by keeping the task_planner's content verbatim + my §8 additive, then re-propose with the new HEAD sha.
- Do NOT block on wait-loops; the orchestrator re-spawns one-shot per event.
