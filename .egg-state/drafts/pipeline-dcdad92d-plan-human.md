# Human summary — plan phase, pipeline-dcdad92d

*Status: written at the start of the plan phase (simplifier's proposal; no task_planner slice list yet). It digests what the plan will contain given the approved analysis and your refine-gate answers, and will be superseded/extended as the planners' drafts land.*

## What the plan is slicing

Everything the approved analysis mandates for this run, all constructed now: the two reliability P0s (one robust review-submission call; hold-for-human when a core review dimension silently fails), the thirteen remaining prompt edits, the deterministic router replacing `reviewer-mapper`, **all 11 specialist lenses**, the always-on reviewer roster (holistic, completeness, test-adequacy, first-principles on Fable 5, conventions), the small determinism boundary (finding schema → computed verdict → templated comments), the thumbs feedback sweep, the eval suite with its CI smoke subset, the wave-2 recall/precision rebalance with the refuter panel and posting bar, and the P2 tail (per-finding resolutions, live counters, dismissal-learning, conditional approvals).

## Only three things order anything

Slices are ordered by real build dependencies only — there are exactly three chains (plus one small rider):

1. **Router before lenses** — the lenses consume its routing.
2. **Finding schema before computed verdict before comment rendering** — each layer builds on the previous.
3. **Smoke set before the wave-2 rebalance** — so the recall/precision rebalance ships with regression protection (plus: the causal experiment on webapp PR #40536 runs once edits 8+10 and the no-post mode exist).

Everything else can proceed in parallel. Any other ordering in a plan draft would be a fake dependency, and I'll flag it in review.

## Keep-it-simple guardrails the plan must honor

- **Lenses**: one shared lens template (structure, hunt-reporting contract, schema conformance) + eleven content instantiations — not eleven bespoke designs. `skill-auditor` folds into the lenses as part of those slices.
- **Replacements are single tasks**: build-router-and-remove-mapper is one task, not two that can drift apart.
- **No double mechanisms**: the smoke set is a tagged subset of the eval suite (one harness); the drift-guard surface *is* the eval suite's version stamp (a documentation line, not a build); conditional approvals render from the finding schema's existing obligation field.
- **Interface guarantees** (consumer severity declarations, correctness-checks import, trigger overrides, etc.) attach as acceptance criteria on the slices that could break them — not standalone verification tasks.

## Your refine-gate answers removed work

- No graduation-bar tasks anywhere (post-launch, human decision).
- The blocking-verdict threshold is an implementer-chosen, clearly documented default inside the computed-verdict task — no decision round-trip.
- No ownership contingency framing — humans own the reviewer.
- Budget/timeout caps: the plan assumes reasonable defaults and documents them; no cap-raising tasks or questions.

## What you'll be asked during planning

Nothing is expected to need a HITL decision at plan time — your refine answers closed every open judgment call that could gate slicing. The one standing conditional: if implementation genuinely needs to split the security & auth lens in two, that comes back to you rather than being a builder's choice.
