# Simplification Assessment — refine phase (pipeline-121df67a)

Role: simplifier · Phase: refine · Repo: Khan/actions · Base: main
Grounding: full contract `task_description` (read in full), `git log` (#194 = 4e7d82f7, merged), `workflows/review/review.md` (1024 lines, all sub-agent prompts inline).

This is the simplifier's producer artifact for the refine phase: scope-reduction and
complexity-avoidance directives the refined spec must honor. Each item cites the
operator directive or the proposal's own text — none of this is new opinion.

## 1. Hard scope exclusions (already shipped — do NOT re-specify)

#194 (merged 2026-07-02) already landed the following. The spec must list these as
out of scope, and any task that touches them must be phrased as *building on* them,
never re-implementing:

- Pinned model IDs for every sub-agent (orchestrator/Opus agents → claude-opus-4-8,
  pattern-triage → claude-sonnet-4-6, reviewer-mapper → claude-haiku-4-5).
- Per-violation blocking/advisory severity; skill-file declaration authoritative,
  impact-judgment fallback preferring advisory on ties; `suggestion` label.
- Verdict computed mechanically from posted-comment labels (REQUEST_CHANGES iff a
  blocking-labeled comment posts).
- Re-review scoping by content-based hunk signatures; skip of redundant no-comment
  re-approvals (note-carrying reviews exempt); skipped-dimension note retained.
- Per-run artifact of each sub-agent's raw JSON (30-day retention).
- `skip-ai-review` opt-out label.
- Optional `.github/aw/review/correctness-checks.md` consumer import.
- Prompt edit 4 (severity is a property of the finding) — landed; 13 edits remain,
  not 14.

## 2. Consumer-repo work is an interface, not a target

Operator directive: webapp/frontend PRs belong to the sibling pipeline. The spec
should express these only as requirements *on the shared workflow*:
- read skill-file severity declarations (mechanism exists via #194);
- honor the correctness-checks extension point (exists via #194);
- thumbs sweep must be *capable of* covering both consumer repos — the sweep
  implementation ships here; enabling/config in consumers is sibling scope.
Cutting consumer tasks out of this spec removes an entire class of cross-repo
coordination complexity.

## 3. Roster: hypothesis inventory, NOT a build order

The proposal says so verbatim ("four runs of evidence do not justify fifteen
roles"; "Build the top four first… add the rest as the eval suite shows they earn
their cost"). Simplification directives for the spec:
- Do NOT create one task per roster role (~15 roles ⇒ ~15 tasks would be the
  over-build). Specify: (a) the deterministic router, (b) the lens *mechanism*
  (one pattern, parameterized per lens), (c) the top-4 lenses only, (d) the
  always-on reviewers as prompt additions (wave-3 edit 14 supplies their mandates).
- Remaining lenses: a documented extension pattern + benchmark gate, not tasks.
- Every added blocking voter compounds false-block rate — the spec should carry
  that as an acceptance criterion (new lens = benchmark-justified), not as a to-do.

## 4. Eval suite: smoke set first, full suite grows later

The proposal's own sequencing: a **dozen-case smoke set** (incident repros +
adversarial PRs + known-clean) plus a no-post run mode gates wave-2. The four full
datasets grow alongside Phase 3 "rather than in front of it." The spec must not
front-load the full suite; it is explicitly the largest line item and gates only
balance-shifting changes. Zero-regret Phase-1 items ship on judgment + thumbs —
putting any eval-suite dependency in front of Phase 1 is a sequencing error.
Cheapest test first: the #40536 rerun with edits 8+10 (thirty minutes) precedes
any wave-2 landing.

## 5. Determinism boundary: a few hundred lines, incremental, no framework

Proposal caveats to preserve verbatim in the spec: schema first → computed verdict
next → templated rendering last; "a few hundred lines, never a framework";
prose stays model-authored; PR-level finding type; hold-for-human verdict outcome.
Note the current reality: the entire workflow is ONE markdown prompt with inline
sub-agents on a single-session engine (gh-aw). The spec should not mandate a file
restructure or a separate codebase beyond what the boundary strictly needs.

## 6. Model/effort table is benchmark-gated, not Phase 1

#194's pins are the shipped state. The doc's per-role recommendations (e.g.
pattern-triage → Opus medium) and every Fable-5 arm are explicitly
benchmark-gated. The only day-one Fable role is first-principles (advisory,
cannot block) — and that role itself is wave-3/Phase-3. So Phase 1 contains ZERO
model changes. The spec should say that in one line rather than reproduce the
whole per-role table as tasks.

## 7. Open Questions are HITL gates, not tasks

Operator directive: "surface that as a question rather than guessing." Four items
must appear in the spec as decisions-for-operator, with no implementation tasks
attached: graduation bar, blocking-verdict policy, vendor-vs-consume, product
ownership. The vendor question in particular must not leak into this pipeline's
design (e.g. do not structure the repo "ready for vendoring") — it is a
consumer-side product decision.

## 8. Smallest honest Phase-1 slice

Phase 1 reduces to exactly three lines of work, all in `review.md` + one small
sweep job:
1. Reliability remainder: standardize the review-submission call; hold-for-human
   when correctness or skills produced no output (patterns may still note-and-go).
2. Wave-1 prompt edits 1, 2, 3, 5, 6, 7 (edit 4 landed).
3. Thumbs sweep: deterministic code, scheduled, one follow-up per new 👎, never
   re-ping; read rates as relative trends.
Anything else claimed for Phase 1 is scope creep against the proposal's own text.

## Summary of assessment

The dominant simplification risk in this pipeline is *faithful-sounding
over-build*: turning the roster into 15 tasks, the eval suite into a Phase-0
dependency, the model table into Phase-1 changes, and #194's shipped items into
re-work. The proposal already contains its own scope controls; the refined spec
is correct exactly insofar as it copies them into enforceable structure (phase
gates, benchmark gates, HITL decisions). I will review the refiner's spec against
sections 1–8 above.

enrichment_sha: (set at commit)
