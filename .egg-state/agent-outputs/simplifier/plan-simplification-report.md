# Simplifier Report — plan phase, pipeline-dcdad92d

Input: finalized refine analysis `.egg-state/drafts/pipeline-dcdad92d-analysis.md` at `996fe06d` + HITL resolutions (`8abb035f`). No plan draft exists yet at assessment time — these are the simplifier's binding-input-derived guardrails for the plan; I will review the actual plan against them in my reviewer role.

Refine-phase guardrails S2–S6 were folded into the finalized analysis (R5, R8, R10, R14, §9) and carry into the plan automatically; they are not repeated here except where slicing makes them concrete.

## P1 — Slice by the three real dependency chains; nothing else orders anything

The analysis names exactly three genuine build dependencies (§0.3, AC-2): router → lenses; finding schema → computed verdict → rendering; smoke set → wave-2 rebalance (R7). Plus one derived edge: R6 (causal experiment) needs edits 8+10 and the no-post run mode to exist. Everything else is parallel. A plan that adds ordering beyond these edges (roadmap phases, "foundations first" chains, eval-before-lens or lens-before-eval ordering) is adding fake dependencies — NACK material under AC-2.

## P2 — Eleven lenses = one template + eleven instantiations, not eleven designs

The lenses share one shape: skill rules + incident-derived executable hunts + the R8 finding schema + a model/effort assignment. The plan should carve ONE lens-pattern task (structure, hunt-reporting contract ran/not-applicable/found, schema conformance) and then eleven content-filling tasks that instantiate it. Eleven bespoke lens designs is the biggest over-build risk in this plan. `skill-auditor` retirement rides the lens slices; it is not a separate task.

## P3 — Subsumption tasks are one task, not two

Router subsumes `reviewer-mapper` (R10/R12): one build-and-replace task, never a build task plus a separate removal task that can drift apart. Same pattern for `skill-auditor` → lenses (P2).

## P4 — HITL resolutions delete work; the plan must not resurrect it

Per the operator's refine-gate resolutions:
- **No graduation-bar tasks** of any kind — not even "make it settable" beyond what R11 already delivers (metrics, adversarial set, version stamp).
- **Blocking-verdict threshold**: an implementer-chosen, documented default inside the R8(b) task — NOT a HITL task, NOT a separate policy slice.
- **Ownership**: at-risk framing is gone; no ownership caveats or contingency tasks around R15/R16/suite upkeep.
- **Budget/timeout caps**: reasonable defaults, documented in the task that assumes them — no cap-raising tasks, no cap HITL questions. This also simplifies R9: investigation tooling builds inside current caps with its per-finding tool-call cap as the safety, full stop.

## P5 — Coherent slices, not one slice per requirement ID

Seventeen R-numbers do not mean seventeen slices. Natural coherent groupings (indicative, not binding): reliability P0s (R1+R2) · wave-1 prompt edits (R3+R3b) · router (R10a+R12 mapper replacement) · lens template + 11 lenses (R10c, P2 above) · always-on roster + edit 14 (R10b/d) · determinism boundary (R8 a→b→c, R17 rendering rides c) · thumbs sweep (R4) · eval suite + smoke subset (R11+R5, one harness) · wave-2 rebalance + refuter panel + posting bar (R7, after smoke) · R6 experiment · P2 leftovers (R13, R15, R16; R14 is a documentation line in R11's slice, not a slice).

## P6 — Two requirements are near-zero-cost riders; plan them as riders

- **R14** = documenting R11's stamp as the consumer surface (one section, no mechanism).
- **R17** = a render path from R8's existing `obligation` field via the existing add-comment safe output. Rider on R8(c), not a slice.

## P7 — Interface requirements are constraints, not tasks

§6's six interface guarantees are acceptance criteria attached to the slices that could break them (severity reading → lens slices; correctness-checks import → lens migration; trigger overrides → any workflow-trigger touch). A plan that turns them into standalone "verify interface" tasks builds test theater; a plan that omits them from the relevant slices' acceptance criteria loses them. Constraint-on-slice is the simple middle.

## Bottom line

The approved analysis already did the simplification heavy lifting; the plan's job is to not undo it. Watch-list for my review: fake ordering (P1), eleven bespoke lenses (P2), split subsumption tasks (P3), resurrected HITL work (P4), requirement-ID slicing (P5), riders promoted to slices (P6), interface-requirement task theater (P7).
