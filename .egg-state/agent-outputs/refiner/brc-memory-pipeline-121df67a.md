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

## Event log

- 2026-07-02 · event `propose` (first invocation, no prior memory): wrote analysis v1,
  registered cq-1, proposed to reviewer_refine / first_principles_reviewer / simplifier.
