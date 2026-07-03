# Human summary — refine analysis, pipeline-dcdad92d

**Task**: implement the Khan/actions half of the "Improving the Khan PR review agent" proposal — the shared review workflow (`workflows/review/review.md`), its reliability fixes, the remaining 13 prompt edits, the severity rules, the full reviewer roster restructure, the thumbs feedback sweep, and the eval suite.

## What this run builds (per your 2026-07-02 directives)

- **Everything in scope, now.** No benchmark- or eval-gated construction anywhere. The eval suite is built alongside and measures effectiveness *after* the fact.
- **All 11 specialist lenses** (security & auth, AI safety, mass-comms & COPPA, caching, data & migrations, concurrency, API/federation, cross-deploy serialization, deploy/infra, money, content & i18n), each folding its skill's rules plus incident-derived executable hunts. `skill-auditor` folds into the lenses.
- **Deterministic router** (code, replaces `reviewer-mapper`): classifies files, maps paths to lenses, scales the run budget by risk tier — so the full roster rarely runs at once.
- **Reliability P0s**: one robust review-submission call; never auto-approve when the correctness or skill/severity pass silently failed (hold for a human instead).
- **Determinism boundary**, kept small (a few hundred lines): structured finding schema → computed verdict → templated comment rendering. Code owns plumbing; models own all judgment and every human-read sentence.
- **Thumbs feedback sweep** (pure code): 👍/👎 collection with one follow-up question per 👎; deployable against both consumer repos from day one.
- **Eval suite** (largest item): four datasets, five metrics (must-catch recall, golden precision, clean false-block, noise, calibration), LLM-judge with human audit, smoke subset running as CI on this repo, and a prompt+config version stamp.
- **Model launch defaults**: Opus 4.8 workhorse with the per-role effort table; first-principles reviewer on Fable 5 day one (advisory-only). Per-role Fable arms stay post-suite experiments.

## What this run does NOT touch

- **Consumer repos** (Khan/webapp, Khan/frontend): no PRs, ever. Consumer-named work becomes interface guarantees on the shared workflow (severity declarations stay authoritative, `correctness-checks.md` extension point keeps working, trigger overrides preserved, drift-guard hash surface exposed).
- **Anything #194 already shipped** (pinned models, severity labels, mechanical verdict, hunk-signature re-review, redundant-approval skip, per-run JSON artifacts, skip label, correctness-checks import).

## Simplifier guardrails (folded into the analysis; nothing blocks)

1. Fix a stale pipeline id in the draft; drop the now-redundant revision header.
2. Exactly 11 lenses — no discretionary security-lens split; if implementation truly needs it, it comes back to you as a HITL question.
3. One eval harness: the smoke set is a tagged subset of the full suite, not a second corpus.
4. One version surface: the drift guard reuses the eval suite's version stamp, no new mechanism.
5. The determinism boundary stays plumbing-only; code creeping into judgment gets rejected in review.
6. One budget rule (tier-scaled) plus one floor for misrouted PRs; no per-lens knobs.

## Decisions that stay yours (HITL, not guessed)

- Graduation bar for automatic mode (we deliver the metrics/adversarial set that make it settable).
- The policy line for what earns a blocking verdict.
- Vendor-vs-consume long-term (this run lands in the shared workflow with extension points either way).
- Who owns the reviewer going forward (until then, counters/dismissal-learning/suite upkeep are at-risk).

## Main risks

gh-aw single-session limits shape how the determinism boundary lands (incrementally: schema → verdict → rendering); the 20-min/$10 caps conflict with 11 lenses + investigation tooling — the router's tier-scaled budget is the mitigation, and any cap change is surfaced to you, not assumed. Full-suite runs cost real inference budget: smoke set is the CI gate, full suite is scheduled.
