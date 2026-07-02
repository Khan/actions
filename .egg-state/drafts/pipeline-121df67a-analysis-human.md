# Simplification analysis — human summary (refine phase)

**Pipeline:** pipeline-121df67a · **Role:** simplifier · **Repo:** Khan/actions
**Full assessment:** `.egg-state/agent-outputs/simplifier/pipeline-121df67a-refine-simplification.md`

## What this pipeline should build (and what it shouldn't)

The task is to implement the "Improving the Khan PR review agent" proposal for the
shared workflow in this repo. The proposal is disciplined about its own scope; the
main risk is a spec that *over-builds while sounding faithful*. My assessment gives
the refiner eight scope controls, all cited to the proposal's own text or the
operator directive:

1. **#194 is done — don't redo it.** Verified locally merged (4e7d82f7). Pinned
   models, per-violation severity + suggestion label, mechanical label-driven
   verdict, hunk-signature re-review scoping, per-run sub-agent JSON artifacts,
   skip-ai-review label, correctness-checks import, and prompt edit 4 are all
   shipped. 13 prompt edits remain, not 14.
2. **Consumer repos are context, not targets.** webapp/frontend work is the sibling
   pipeline's; here it appears only as interface requirements on the shared
   workflow (severity declarations readable, extension point honored, thumbs sweep
   capable of covering both repos).
3. **The 15-role roster is a hypothesis inventory, not a build order** (the
   proposal says so verbatim). Spec the deterministic router, one parameterized
   lens mechanism, and the top-4 lenses; the rest is a benchmark-gated extension
   pattern, not tasks. **Resolved (cq-1):** the operator chose the
   incident-mapped four — **security & auth, AI safety & moderation,
   mass-comms & COPPA, caching & resource** — matching the documented incident
   classes the must-catch eval set reproduces. Data & migrations, concurrency &
   async, API & federation compat and the rest land later, gated on eval
   evidence.
4. **Eval suite: smoke set first.** A dozen cases + a never-posts run mode gate
   wave 2; the four full datasets grow with Phase 3 and never block Phase 1's
   zero-regret fixes. Cheapest test first: rerun #40536 with edits 8+10.
5. **Determinism boundary stays small and incremental** — schema → computed
   verdict → templated rendering; "a few hundred lines, never a framework." The
   whole workflow is today one 1024-line prompt with inline sub-agents; don't
   mandate a restructure beyond what the boundary needs.
6. **Phase 1 has zero model changes.** All per-role model/effort recommendations
   and Fable-5 arms are benchmark-gated (first-principles' day-one Fable is a
   Phase-3 role anyway).
7. **The four Open Questions (graduation bar, blocking policy, vendor-vs-consume,
   ownership) become HITL decisions** — surfaced to the operator, no
   implementation tasks attached, per the operator directive.
8. **Smallest honest Phase-1 slice:** submission standardization + hold-for-human
   when correctness/skills is missing; wave-1 prompt edits 1, 2, 3, 5, 6, 7; the
   deterministic thumbs sweep. Anything more in Phase 1 is scope creep.

## Bottom line

The proposal already contains its own scope controls; the refined spec is correct
exactly insofar as it converts them into enforceable structure — phase gates,
benchmark gates, and HITL decisions. I will review the refiner's spec against the
eight sections above.

## Post-gate status (revision 2)

The operator approved all eight scope controls at the refine gate — they are now
ratified constraints on the plan phase. cq-1 is resolved (incident-mapped top-4
lenses, reflected in §3 above). No new decisions are induced by this resolution
from the simplifier's side: it narrows scope rather than widening it.
