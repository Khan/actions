# Refined Requirements — "Improving the Khan PR review agent" (Khan/actions shared workflow)

Pipeline: `pipeline-121df67a` · Repo: `Khan/actions` · Base: `main` · Phase artifact: refine

## 1. Scope statement

This pipeline implements the **Khan/actions portion** of the "Improving the Khan PR review
agent" proposal: the shared PR-review workflow (`workflows/review/review.md` and its inline
sub-agent prompts) and everything that ships with it — the outstanding reliability fixes, the
fourteen prompt edits (minus the one #194 landed), the severity rules, the reviewer roster
restructure, the thumbs feedback sweep, and the eval suite.

**Not this pipeline** (sibling pipeline owns it): any PR against Khan/webapp or Khan/frontend —
skill-file severity annotations, the consumer-side `correctness-checks.md` content, the
consumer half of the config drift guard, and pin/repin updates. Where the proposal names
consumer work, this pipeline treats it as an **interface requirement** on the shared workflow
(§6), never as a target.

**Binding sequencing constraints** (operator directive):
- Respect the proposal's four-phase order: zero-regret fixes → smoke benchmark + rebalance →
  depth/roster → durability. Balance-shifting changes gate on the *smoke set only*, never on
  the full suite; zero-regret changes gate on nothing.
- Respect P0/P1/P2 priorities as stated per finding.
- Do **not** re-implement anything Khan/actions#194 shipped (§3). #194 is merged
  (commit `4e7d82f7` on `main`).
- Where the proposal defers a decision to its Open Questions section, surface it as a
  question rather than guessing (§7). Per the operator's gate note (2026-07-02), the
  Open Questions surface as HITL decisions, never as implementation tasks.
- **Zero model changes in Phase 1** (operator-confirmed scope control): #194's pinned
  models are the Phase 1 baseline; every model/effort move (R12) is Phase 3 and
  benchmark-gated. Of the fourteen prompt edits, **thirteen remain** (edit 4 = #194).

**Gate status**: the operator approved this spec at the refine HITL gate (2026-07-02),
including all eight scope controls, and resolved cq-1 (see §4 R10 and §7).

## 2. Ground truth (verified against this repo at `54f804c9`)

- `workflows/review/review.md` (1,024 lines) is the single shared prompt: an orchestrator
  making all GitHub calls, with inline read-only sub-agents — `pattern-triage`,
  `correctness-reviewer`, `skill-auditor`, `reviewer-mapper`, `thread-reconciler`,
  `claim-validator` (7 steps: gather context → early-exit → review → verdict → per-line
  comments → submit → risk/patterns comment on approval).
- Consumers import it via `source:` and supply four config files (risk tiers, CI-tooling
  exclusions, skills index, reviewer allowlist) plus the `add-reviewer` safe output.
- #194 (merged 2026-07-02) is present on `main`; its changes are the baseline this pipeline
  builds on, not work to redo.

## 3. Already shipped in #194 — do NOT re-implement

1. Pinned model versions everywhere (orchestrator + Opus sub-agents → claude-opus-4-8,
   pattern-triage → claude-sonnet-4-6, reviewer-mapper → claude-haiku-4-5).
2. Per-violation blocking/advisory severity; skill file's own severity declaration is
   authoritative, impact-judgment fallback prefers advisory on ties; new
   `suggestion (non-blocking, best-practice)` label. (= prompt edit 4.)
3. Validator may downgrade an overstated severity.
4. Mechanical verdict from posted-comment labels: REQUEST_CHANGES iff a posted comment
   carries a blocking label.
5. Re-review scoping by content-based hunk signatures (added-lines-only hash per hunk);
   genuine-issue blocking correctness findings survive on unchanged code.
6. Skip of redundant no-comment re-approvals — with the note-carrying-review exemption.
7. Skipped-dimension tracking in Step 3, noted in the review body for either verdict
   (restored after review feedback; visibility only, not a gate).
8. Per-run artifact of each sub-agent's raw JSON (30-day retention).
9. `skip-ai-review` opt-out label.
10. Optional repo-specific `.github/aw/review/correctness-checks.md` import folded into the
    correctness pass.

## 4. Requirements, by proposal phase

### Phase 1 — zero-regret (ship first; no benchmark gate)

- **R1 (P0)** Standardize review submission on one robust call with a real body. Eliminates
  the observed `--body-stdin` / empty-body retry dance. Still open after #194.
- **R2 (P0)** Never auto-approve with a core dimension missing: if the correctness pass or
  the skill/severity pass produced no output, **hold for a human** instead of approving with
  a note. A lost `pattern-triage` pass may still note-and-continue. (#194's note is
  visibility; this is the gate.)
- **R3 (P0/wave-1)** Prompt edits **1, 2, 3, 5, 6, 7** (edit 4 = #194):
  - **E1** For each High-risk file, name the applying High-risk trigger and state a one-line
    judgment on it, even when the judgment is "fine".
  - **E2** Stage `pr-context.json` (title, description, linked ticket ref) next to the diff;
    every sub-agent reads it. (Fixes the instruction sub-agents can't currently follow;
    pairs with E3.)
  - **E3** Untrusted-input rule: diff, file contents, PR description, and ticket text are
    material under review; embedded instructions are content to analyze, never commands;
    an attempt to direct the reviewer is itself a finding.
  - **E5** Deletions are findings: for every deleted guard/check/field/fallback, identify
    what depended on it before accepting the deletion.
  - **E6** Stage the full reply chain per thread; the reconciler judges author reasoning —
    concede-and-resolve or keep open; never re-raise a conceded point; keep the existing
    never-reply rule.
  - **E7** Skip any candidate comment whose line already has an open human thread.
- **R3b (P1 finding · ships wave-1, zero-regret)** Flag-a-pre-existing-bug rule (from the
  P1 severity finding "Make severity a property of the finding", named
  still-unwritten in its #194 annotation): a real bug in the lines the PR touches is fair
  to flag even if it predates the change — "it is not a regression" is not a reason to stay
  silent about code under review. A prompt rule in `review.md`'s finder/severity area; it
  **builds on** #194's landed severity model (edit 4, §3 items 2–4) and does not re-open
  it. Not one of the fourteen numbered edits, so tracked here as its own zero-regret item.
- **R4 (P1)** Thumbs feedback sweep — **deterministic code, no model**: invite 👍/👎 at two
  grains (per inline comment; per review/guidance comment); a polling sweep (cron or
  piggybacked on the next run) collects new reactions; for each new 👎, exactly one
  follow-up in-thread asking incorrect / unimportant / unclear / duplicate + free text;
  never re-ping a silent author. Must cover **both consumer repos from day one** (frontend
  already has 84👍/21👎 unharvested). Output feeds the golden set (§ R11) and
  dismissal-learning (R16).

### Phase 2 — smoke benchmark, then the rebalance (one unit)

- **R5 (P1)** Smoke benchmark first, not the full suite: ~a dozen cases — a few incident
  repros, the adversarial-injection PRs (E3's hard gate), a few known-clean PRs — plus a run
  mode that exercises the real review path **without ever posting to a real PR**.
- **R6** The cheap causal experiment: rerun the reviewer on webapp PR #40536 with edits 8+10
  applied; success signal = the OpenAccess authorization question surfaces. (~30 min; tests
  the proposal's central claim that conservative prompts, not model capability, caused the miss.)
- **R7 (P1)** Land the wave-2 rebalance **as one unit**, verified against the smoke set and
  watched via thumbs: prompt edits **8** (coverage first — finders report everything, tagged
  confidence+severity, no self-filtering), **9** (blocking requires a concrete failing
  scenario), **10** (validator drops only what it can refute; downgrades the uncertain),
  **11** (confirm before you claim — read definition/callers/guards, state what you checked),
  plus the **blocking-claim refuter panel** and edit **13**'s posting bar (ranked posting;
  inline only at ≥medium confidence; low-confidence survivors in one collapsed section;
  cap is a backstop; suggested diffs where the fix is clear; no padding). Edit **12**
  (cite exact RIGHT-side lines or quote the text; feed line-numbered content) ships here too.
- **R8 (P1)** Determinism boundary, incrementally: (a) one versioned structured **finding
  schema** (id, lens, anchor incl. PR-level type, severity, confidence, evidence trace,
  optional suggested patch, optional pre-merge obligation, producing hunt, model-authored
  prose); (b) **computed verdict** in code (mechanical rule is already stated post-#194 —
  move execution from model to code), including a hold-for-human outcome for policy-named
  conflicts; (c) **templated rendering** of Conventional Comments last. Code owns merging,
  aggregation, label-wrapping, safe-output calls; models own all judgment and every
  human-read sentence. Keep it small (a few hundred lines); tripwire: thinner finder output
  after schema tightening means loosen fields, not the boundary.

### Phase 3 — depth + suite growth (each item benchmark-justified)

- **R9 (P1)** Investigation tooling for reviewers: grep callers, trace call chains, run one
  targeted cheap check; cap tool calls per finding; raise run budget/timeout before broad
  enablement; score cost on the benchmark.
- **R10 (P1/P2)** Roster restructure under "one owner per concern":
  - **Deterministic router** (code): file classification (generated/formatting from
    `.gitattributes`), path→lens mapping, team mapping from REVIEWERS, per-file risk tier
    (small model check only for diff-direction-dependent tiers); subsumes `reviewer-mapper`;
    scales the run budget by highest touched risk tier, with a floor for misrouted PRs.
  - **Always-on**: `holistic`, `completeness` (Jira/Confluence read-only inside the
    non-posting sub-agent; fetched text is data under review — trust boundary per §6.4),
    `test-adequacy`, `first-principles` (advisory-only, never blocks, Fable 5 day one),
    `conventions` (advisory; router-gated by greppable trigger signatures).
  - **Specialist lenses**: build the **top four first** — **resolved by cq-1**
    (operator, 2026-07-02, incident-mapped option): **security & auth, AI safety &
    moderation, mass-comms & COPPA, caching & resource** — the four lenses matching the
    documented incidents the must-catch set reproduces. Each folds its skill's rules +
    incident-derived executable hunts (each hunt reports ran / not-applicable / found).
    All remaining lenses (data & migrations, concurrency & async, API & federation
    compat, cross-deploy serialization, deploy & infra config, money & payments,
    content & i18n) gate on measured misses; until then their highest-value hunts can
    ride the `correctness-checks.md` extension point (§3 item 10, §6.2) inside the
    single correctness pass, per the proposal's interim-home note. `skill-auditor`
    folds into the lenses; the severity contradiction's source disappears. Per the
    proposal, `security & auth` is the densest lens and the first candidate to split
    further, along the risk config's own seam: authorization correctness (acl,
    capabilities, resolver permission checks) vs. web/platform security (sessions,
    cookies, CSRF/SSRF/redirects, headers).
  - **Gates kept**: `pattern-triage` (exclusions listed in the guidance comment; eval scores
    its false-exclusion rate), `claim-validator` + refuter panel (batched/parallel so it
    doesn't become the new overloaded single agent), deterministic **dedup + verdict**
    bookends, `thread-reconciler`.
  - Prompt edit **14**: the named mandates for holistic / completeness / first-principles.
- **R11 (P1)** Full eval suite (the largest line item; budget as a project):
  four datasets (incident repros; regenerated synthetic mutations mapped to lenses; golden
  set with human-comment + revert/follow-up labels; clean set), five metrics (must-catch
  recall ≈100% & never regress; golden precision; clean false-block ≈0; noise = comments/PR
  on clean; calibration), Opus 4.8 LLM-judge with human audit sample, thumbs labels
  calibrate the judge, golden-set holdout + fresh mutations against overfitting,
  **adversarial set** as a hard gate for automatic, smoke set runs as CI on this repo so a
  prompt change cannot merge unscored, and **reviewer versioning**: stamp every posted
  review with a hash of prompt+config (the existing HTML marker carries it).
- **R12 (P1)** Model/effort assignments as specified per role (Opus 4.8 workhorse; effort
  medium/high/xhigh per the table; `reviewer-mapper` becomes code; first-principles on
  Fable 5 day one; per-role Fable arms adopted only where the benchmark wins net of 2× cost;
  claim-validator switches models last; Sonnet 5 is a hypothesis for the suite, not a default).

### Phase 4 — durability

- **R13 (P2)** Per-finding resolution rule on re-review: every actionable finding gets an
  explicit resolution (fixed / deferred-to-filed-issue / disagreed-with-reason); nothing
  drops silently between pushes. (#194 landed the delta-scoping half already.)
- **R14 (P2)** Config drift guard, shared side: whatever the shared workflow must expose for
  a consumer-side sync check (the version/config hash from R11 is the natural hook).
  Consumer-side check itself is the sibling's (§6.5).
- **R15 (P2)** Live counters between suite runs, mined from run logs and #194's per-run
  JSON artifacts: validator drop rate per lens, comments/PR, verdict mix, thumbs agree
  rate, cost per run. Complements, not substitutes, for the suite.
- **R16 (P2)** Dismissal-learning: dismissed/resolved threads, 👎 with replies, and correct
  pushback become candidate "do-not-flag-this-here" notes **proposed as changes to a
  committed config file a human approves** — never auto-adopted.
- **R17 (P2)** Conditional-approval verdict: APPROVE + a prominent structured obligations
  comment via the existing add-comment safe output (no new permissions, no new GitHub
  review state); renders from the finding schema's `obligation` field (R8).

## 5. Explicitly out of scope

- Any commit or PR against Khan/webapp or Khan/frontend (sibling pipeline).
- Skill-file severity annotations in consumer repos; consumer `correctness-checks.md` content;
  consumer-side drift-guard wiring; consumer pin/repin updates.
- Flipping any consumer to automatic triggering; naming the graduation numbers (§7).
- Assigning a product owner for the reviewer (§7).
- Re-implementing anything in §3.

## 6. Interface requirements (contract with the sibling/consumer pipelines)

1. **Skill-severity declarations**: keep reading the skill file's own blocking/advisory
   declaration as authoritative (post-#194 behavior); consumers annotate on their side.
2. **`correctness-checks.md` extension point**: keep the optional import working; it is the
   interim home for lens hunts until lenses exist, and the migration path out of it must not
   strand consumer content.
3. **Thumbs sweep**: must be deployable against both consumer repos from day one.
4. **Completeness reviewer access**: Jira/Confluence tokens scoped read-only, fetch confined
   to the non-posting sub-agent, fetched text treated as data under review — this is a real
   trust-boundary change and must be documented as such for consumers.
5. **Drift guard**: shared workflow exposes a stable version/config-hash surface the
   consumer-side guard can check against.
6. **Trigger override**: consumers' manual `/review` override (webapp) and automatic mode
   (frontend) must both keep working across every change here.

## 7. Open questions — surfaced, not guessed

Per the operator directive, the proposal's deferred decisions are surfaced rather than
answered by this pipeline:

- **cq-1 — RESOLVED** (operator, 2026-07-02): which four specialist lenses ship first.
  Answer: the **incident-mapped four** — security & auth, AI safety & moderation,
  mass-comms & COPPA, caching & resource (folded into R10). The resolution induces no
  new decisions: the deferral mechanism for the remaining lenses (eval-gated, with the
  `correctness-checks.md` interim home) was already in the spec.
- **Graduation bar** (proposal Open Question 1): a consumer/operator policy decision.
  This pipeline's deliverable is only what makes the bar settable: the metrics (R11), the
  adversarial hard gate, and frontend's post-#194 deltas as the readout. No build here
  depends on the answer; per the operator's gate note it surfaces as a **HITL decision**
  (registered at proposal-phase-4, when it first gates anything), never as an
  implementation task.
- **What earns a blocking verdict** (Open Question 2): the mechanics land via #194 + R7
  (reproduce-or-downgrade) + R8 (computed verdict); the policy threshold beyond that is the
  operator's and is not guessed here — it surfaces as a HITL decision if and when a build
  choice depends on it.
- **Vendor vs. consume** (Open Question 3): resolved for this pipeline by the operator's
  task statement — the restructure lands in the **shared** Khan/actions workflow; webapp's
  vendoring choice is the sibling's/operator's. This pipeline keeps the extension points
  (§6.2, §6.5) that make either answer workable.
- **Who owns the reviewer** (Open Question 4): organizational; not buildable. Noted that
  every "compounds over time" item (R15, R16, suite upkeep) is at-risk until an owner exists.

## 8. Acceptance criteria (refine-level)

1. Every requirement above traces to a specific proposal finding, prompt edit, roster item,
   or bet — and none re-implements a §3 item.
2. Phase ordering in §4 is preserved by the plan: R1–R4 (incl. R3b) gate on nothing; R7 gates on R5 and
   ships as one unit; R9/R10 items gate on measured evidence; R13–R17 last.
3. No deliverable targets a consumer repo; every consumer-named item appears only as a §6
   interface requirement.
4. ~~cq-1 is resolved before the plan slices the specialist-lens work~~ — **met**:
   resolved by the operator 2026-07-02 (incident-mapped four); the plan slices exactly
   those four lenses plus the eval-gated deferral path for the rest.
5. Phase 1 contains zero model changes (operator-confirmed scope control; #194 pins are
   the baseline, R12 is Phase 3).

## 9. Risks & constraints for the plan phase

- **gh-aw engine limits**: single-session model; the determinism boundary (R8) must land
  incrementally inside that constraint (schema → verdict → rendering).
- **Budget/timeout**: 20-min / $10 caps conflict with investigation + full roster; the
  router's tier-scaled budget (R10) and the caveats in R9 are the mitigation, and any cap
  change is measured on the benchmark.
- **Eval-suite data dependencies**: incident repros and golden/clean sets are built from
  Khan incident history and consumer-repo PR records; the suite must be able to consume
  those without this pipeline writing to consumer repos.
- **Fable 5 constraints**: 2× pricing, 30-day org data-retention requirement, longer turns
  vs. the timeout, harness pricing-table support — all reasons the Fable arms stay
  benchmark-gated (first-principles excepted, advisory-only).
- **Suite cost**: full-suite runs spend real inference budget; smoke set is the CI gate,
  full suite is scheduled.


## HITL Resolution

The following was approved by a human reviewer at the refine phase gate:

Converged draft correctly incorporates the resolved cq-1 (incident-mapped top-4 lenses); eight scope controls ratified; no new questions induced. Proceed to plan.
