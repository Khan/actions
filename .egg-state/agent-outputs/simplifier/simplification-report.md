# Simplifier Report — refine phase, pipeline-dcdad92d

Assessed artifact: `.egg-state/drafts/pipeline-dcdad92d-analysis.md` (seeded, operator-approved prior analysis with revision header) at repo `main` = `54f804c9`, contract-init commit `45d7990d`.

Binding constraint honored throughout: the 2026-07-02 operator directives mandate building ALL 11 specialist lenses, the full model launch defaults, and every in-scope item in this run, with **no** eval-/benchmark-gated construction. Nothing below proposes cutting operator-mandated scope; every recommendation is reuse-over-rebuild, one-mechanism-not-two, or removal of discretionary complexity the directives do not require.

## Verdict

The seeded analysis is already lean and largely directive-compliant — its body (not just its header) incorporates directions 1–4 (R10 says "ALL ELEVEN", R12 implements launch defaults now, AC-2 bans eval-evidence deferral). The reuse posture is strong: #194 inventory is treated as baseline (§3), R14 reuses R11's version stamp, R15 mines #194's existing per-run JSON artifacts, R17 renders from R8's schema via the existing add-comment safe output, and the router subsumes `reviewer-mapper` rather than sitting beside it. I found **no scope that can be cut** without violating the directives, and **no re-implementation of a §3 item**.

Findings are therefore small: 2 correctness cleanups for the refiner, 4 keep-it-simple guardrails to make explicit so the plan phase cannot accidentally double-build.

## S1 (cleanup, refiner): stale identifiers and the revision header

- Line 5 says `Pipeline: pipeline-121df67a` — the prior run's id. Must read `pipeline-dcdad92d`.
- The line-1 revision header describes edits that the body already contains. Once the refiner confirms the body is fully revised, the header should be deleted, not left as a second, potentially-divergent statement of the directives. One authoritative text, not two.

## S2 (simplification, refiner → plan): do NOT split the security & auth lens

R10 says security & auth "may split along the risk config's seam". The operator direction names exactly 11 lenses; a discretionary split makes 12 and adds a roster seam nobody asked for. Recommend: build exactly the named 11; if a genuine need to split emerges during implementation, that is a HITL question (directive 7), not a builder's option. The "may split" clause should be demoted from a design option to an explicit HITL-if-needed note.

## S3 (one harness, not two): R5 smoke set ⊂ R11 eval suite

R5 (smoke benchmark) and R11 (full suite) must share one dataset format, one runner, and one no-post run mode — the smoke set being a tagged subset of the suite's cases with a CI entry point, not a separate corpus or harness. The draft implies this but doesn't state it; making it an explicit plan constraint prevents the most likely double-build in the whole pipeline.

## S4 (one surface, not two): version/config-hash

R11's reviewer-versioning stamp (hash of prompt+config via the existing HTML marker) and R14's drift-guard surface must be **the same artifact**. The draft already calls R11 "the natural hook" — the plan should harden that to "R14 adds no new mechanism; it documents R11's stamp as the consumer-readable surface."

## S5 (determinism boundary discipline): R8 stays a few hundred lines

R8's own tripwire (thinner finder output ⇒ loosen fields, not the boundary) is the right guard. Add the converse for the plan phase: code owns merging/aggregation/labels/safe-output calls **only** — any slice that grows code into judgment territory (rewriting model prose, scoring findings in code beyond the declared severity/confidence fields) is scope creep and should be rejected in review, not negotiated.

## S6 (router floor, not lens minimum): budget note

§9's mitigation is correct and simple: tier-scaled budget means the full 11-lens roster rarely runs at once. Keep the misrouted-PR floor as the only special case; resist any plan-phase temptation to add per-lens budget knobs — one scaling rule + one floor.

## Interface & out-of-scope check

§5/§6 are clean: no consumer-repo targets, all consumer-named work expressed as interface requirements. AC-1..5 are testable and match the directives. Open questions (§7) correctly route to HITL rather than guesses — consistent with directive 7. No HITL decision is required for anything in this report; S2's HITL is conditional and only if implementation actually needs the split.

## Summary for peers

ACK-worthy analysis once S1 is fixed; S2–S6 are guardrails the refiner can fold in with a few sentences each. Nothing here blocks; nothing here cuts mandated scope.
