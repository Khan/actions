# Refiner BRC memory — pipeline-121df67a (refine phase)

## Codebase / change model (claims, refiner-authored)

- Repo `Khan/actions`, branch `egg/pipeline-121df67a/work` off `main` (base `54f804c9`).
- The subject of the whole pipeline is `workflows/review/review.md` (1,024-line shared
  gh-aw PR-review workflow, 7 steps, 6 inline sub-agents) and what ships with it.
- Khan/actions#194 is MERGED on main (`4e7d82f7`); its ten shipped items are enumerated in
  §3 of the analysis artifact and are do-not-reimplement.

## My proposal (v1)

- Artifact: `.egg-state/drafts/pipeline-121df67a-analysis.md` — refined requirements:
  scope split vs. sibling consumer-repo pipeline (§1/§5/§6), #194 do-not-reimplement list
  (§3), 17 requirements R1–R17 mapped to the proposal's four phases with P0/P1/P2 and
  gating rules (§4), interface requirements on consumers (§6), open-questions disposition
  (§7), refine acceptance criteria (§8), plan-phase risks (§9).
- HITL registered this phase: **cq-1** — which four specialist lenses ship first (proposal
  says "build the top four" without naming them). Options: roster-order / incident-mapped /
  defer-to-evidence / other. Unresolved at propose time.
- Attestation: decisions_registered=[cq-1].

## Key stances (keep consistent across re-proposals)

1. The proposal's four Open Questions are NOT guessed: graduation bar + blocking policy are
   operator policy (only their enabling mechanics are in scope); vendor-vs-consume is
   settled for this pipeline by the operator task statement (restructure lands in the
   shared workflow); ownership is organizational.
2. Consumer repos are interface requirements only — no webapp/frontend targets ever.
3. R2 (hold-for-human on lost correctness/skills pass) is a gate, distinct from #194's
   note, which is visibility only.
4. Wave-2 edits (8–11 + refuter panel + edit-13 posting bar + edit 12) ship as ONE unit,
   gated on the smoke set (R5), never on the full suite.
5. first-principles reviewer: advisory-only, never blocks, Fable 5 day one — the only
   day-one Fable role.

6. **R3b** (added v2): flag-a-pre-existing-bug prompt rule — from the P1 severity finding,
   explicitly still-unwritten per its #194 annotation; ships wave-1 zero-regret; builds on
   #194's landed edit 4, does not re-open it. This was the single gap both v1 NACKs named.

7. **cq-1 RESOLVED** (operator, 2026-07-02): incident-mapped four lenses — security &
   auth, AI safety & moderation, mass-comms & COPPA, caching & resource. Remaining lenses
   eval-gated with correctness-checks.md as interim hunt home. Resolution induces no new
   decisions.
8. Operator gate note (iteration 0): spec approved incl. all eight scope controls;
   explicit controls to keep restating — 13 prompt edits remain (edit 4 = #194); roster =
   hypothesis inventory, router + top-4 lenses only; smoke set gates wave 2; **zero model
   changes in Phase 1**; the four Open Questions surface as HITL decisions, never as
   implementation tasks (registered only when they first gate work).

## Event log

- 2026-07-02 · event `propose` (first invocation, no prior memory): wrote analysis v1,
  registered cq-1, proposed to reviewer_refine / first_principles_reviewer / simplifier.
- 2026-07-02 · event `open_nacks_blocked` (v1): reviewer_refine + first_principles_reviewer
  both NACKed on ONE identical gap — the flag-a-pre-existing-bug rule missing from R1–R17.
  Found the R3b block already sitting uncommitted in the working tree (prior invocation
  evidently died pre-commit); verified it against the proposal text and both NACK asks,
  adopted it, fixed its priority label (P1 finding, wave-1 shipping), added it to §8 AC-2
  gating, and added first_principles' advisory note to R10 (security & auth lens is the
  first split candidate: authz-correctness vs web/platform-security seam). Re-proposed v2.
  simplifier's producer artifacts: simplification assessment 8e20f0a6 + human-focused
  summary 209daade on the shared branch. Mechanism note: the first propose after NACKs
  409s with status open_nacks_blocked and full NACK content inline (#2142); the immediate
  identical retry succeeded as v2 (commit d67dca3c). LESSON: commit+push memory updates
  only via propose — a local-only commit after propose is lost on respawn.
- 2026-07-02 · event `iteration_feedback` (post-gate): v2 ACKed by reviewer_refine +
  first_principles_reviewer (simplifier→refiner pending at the gate snapshot); operator
  approved the spec at the refine HITL gate and resolved cq-1 → incident-mapped four.
  Updated the analysis: §1 gate-status + zero-model-changes-in-Phase-1 control explicit +
  13-edits-remain wording; §4 R10 names the resolved four lenses and the eval-gated
  deferral (correctness-checks.md interim home) for the other seven; §7 cq-1 marked
  resolved (no induced decisions), graduation-bar/blocking-verdict framed as future HITL
  registrations; §8 AC-4 met, AC-5 added. Re-proposed v3.
