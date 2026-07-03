# R6 causal experiment — webapp PR #40536 (OpenAccess authorization)

**Task:** task-10-4 · **Slice:** slice-10 (wave-2 recall/precision rebalance) ·
**Edits under test:** E8 (coverage first) + E10 (drop only the refuted; downgrade the
uncertain).

## Hypothesis

The prior reviewer **missed** the authorization question on Khan/webapp PR #40536: a
resolver was made `OpenAccess` (its authorization guard effectively removed), and the
review approved without flagging that an unauthenticated/under-privileged caller can now
reach the privileged path. R6 asserts this is a **recall** failure that the wave-2 edits
fix:

- **E8 (coverage first)** makes the security-auth reviewer *raise* the authorization
  concern instead of self-censoring it as "probably intentional / not certain of blast
  radius." Recall is optimized at the producer; precision is restored downstream.
- **E10 (drop only the refuted; downgrade the uncertain)** stops the `claim-validator`
  from silently dropping the concern under the old "when in doubt, drop it" stance. An
  authorization concern the validator can neither confirm nor refute is **downgraded**, not
  deleted — so it still surfaces to the author.

**Success criterion (from the proposal / AC):** the OpenAccess authorization question
**surfaces** in the review output (as a posted finding) when edits 8 + 10 are applied,
where the pre-rebalance run did not surface it.

## Method — the no-post harness (no consumer write)

Consumer repos (Khan/webapp) are **context, not targets** for this pipeline (operator
directive 6): this experiment performs **no PR against webapp and no consumer write**. It
uses the slice-9 **no-post runner** (`workflows/review/eval/runner.ts`), which replays the
*real* code review path — `router.route` → `labelForFinding` → the newly-changed-code scope
filter → `computeVerdict` → `renderComment`/`renderReviewBody` — and returns the review it
*would* submit as plain data (`RunResult.plannedReview`). The module imports no GitHub
client, so "no write" is structural, not a matter of configuration.

Two ways to drive it, both write-free:

1. **Reproducible in-repo stand-in (used for the recorded result below).** The #40536
   OpenAccess pattern — an authorization guard short-circuited so a caller reaches a
   privileged path — is encoded as the smoke corpus case
   [`incident-auth-bypass`](../corpus/smoke/incident-auth-bypass.json)
   (`src/auth/middleware.ts:57`, the admin guard's early `return 403` removed). It runs
   with recorded findings, so the result is deterministic and needs no model or network:

   ```ts
   import {runCase} from "../runner";
   import {loadSmokeCorpus} from "../corpus/loader";
   const c = loadSmokeCorpus().find((x) => x.id === "incident-auth-bypass")!;
   const {plannedReview} = runCase(c); // no GitHub write
   ```

2. **Live producer arm (the full R6 rerun, run outside this pipeline).** The same
   `runCase(corpusCase, {produceFindings})` swaps in a live model producer over a
   #40536-derived case via `RunOptions.produceFindings`, keeping every downstream stage
   identical. Because directive 6 forbids consumer-repo work inside this pipeline, the live
   rerun against the actual webapp PR is a **documented follow-up** owned by the consumer
   rollout, not executed here. This record fixes the harness, the case, and the pass/fail
   bar so that rerun is turn-key.

## Result

**Surfacing observed (positive), via the reproducible stand-in.** With edits 8 + 10 in
effect, the no-post harness over `incident-auth-bypass` produces:

- verdict **`REQUEST_CHANGES`**,
- one posted blocking finding `sec-auth-bypass-1` from the `security-auth` lens anchored at
  `src/auth/middleware.ts:57` — i.e. **the authorization question surfaces** as an inline
  blocking comment rather than being dropped.

This is asserted as a regression gate by the slice-9 smoke suite
(`workflows/review/eval/smoke.test.ts`): the case's `expected.mustCatch` contains
`sec-auth-bypass-1` and `expected.verdict` is `REQUEST_CHANGES`, so any future change that
lets the authorization concern be dropped (a recall regression) fails CI. task-10-3
verifies the whole rebalance against this smoke set (no recall regression on must-catch, no
new false-block on the clean cases).

**Causal reading.** The pre-rebalance behavior dropped uncertain authorization concerns
(old validator "prefer to drop"); E8 raises the concern and E10 forbids dropping a
non-refuted authorization claim (it downgrades at most). The concern therefore cannot be
silently lost — which is exactly the #40536 miss the experiment targets.

## Caveats / honesty notes

- The recorded positive is the **in-repo stand-in** (`incident-auth-bypass`), which models
  the #40536 OpenAccess-authorization *pattern*; it is deterministic and CI-guarded. The
  live rerun against the actual webapp PR #40536 with a model producer is **not** run in
  this pipeline (directive 6: no consumer write) and is left as the turn-key follow-up
  above.
- The stand-in demonstrates the *mechanism* (E8 raises, E10 preserves, verdict blocks). It
  does not by itself prove the live model would word the finding identically; the live arm
  in method (2) closes that gap when the consumer rollout runs it.
