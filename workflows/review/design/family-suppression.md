# Design note: mechanism-level (cross-file) suppression

Follow-up to Khan/actions#332 (adjudicated suppression corpus). Status: design
only; no code should land before the eval plan at the bottom has corpus cases
and a measured precision/recall baseline.

## The measured problem

Khan/webapp#41290 carries five bot threads on one mechanism: the tmv2 CEDAR
mode-change event publishing from inside a pre-flight modifier, which the PR's
in-parallel arm lets fire on flagged turns.

- Pre-deploy (before the 2026-08-11 reviewer deploy): r3756443933 and
  r3756443949, both anchored on `chat/modifiers/v2/tmv2.go`.
- Post-deploy: r3767202100 and r3767482526, anchored on two different lines of
  `moderation/spec/SPEC.md`.
- r3761098824 (`SPEC.md`), a provider-transmission variant of the same
  side-effects-on-flagged-turns concern, which the author downvoted; the
  thumbs sweep's "why?" follow-up got the closed-vocabulary answer
  `duplicate` 92 seconds later.

Each thread is individually defensible: different anchor, different wording,
a genuinely distinct consequence of the one mechanism. Together they read as
the bot re-arguing a concern the author has already engaged with, and they
are the post-#312 remainder of the "keeps flagging the same things" report:
in-run clustering and the #332 corpus both key on path, so a variant that
moves to a different file always posts.

## Why #332 misses it

The adjudicated corpus filter reuses the open-thread suppression matcher:
same path (no line window), then the #245 similarity floors over the claim
text. That path key is deliberate; it is what keeps the matcher's
false-suppression risk low enough to run pre-validation with no model call.
A cross-file variant fails the path key before similarity is ever computed,
so the corpus cannot suppress it however similar the prose is.

## Candidate designs

Three candidates, ordered by how much judgment they add. Each keeps the #332
fail-closed rules (below); the question each must answer is what its
false-suppression rate is on findings that merely share vocabulary with an
adjudicated thread.

### (a) Reconciler judgment pass

Extend the `thread-reconciler` sub-agent's mandate: alongside its
keep/resolve decisions over the bot's open threads, it reads the adjudicated
corpus and marks each new non-blocking candidate as re-deriving a settled
mechanism or not. Matching becomes a model judgment with the full thread
reply chains as context.

- For: the reply chains are exactly the signal a mechanism match needs (the
  author's "we accept this side effect" settles every variant of it), and the
  reconciler already reads them.
- Against: a model judgment can suppress a finding for reasons no one can
  audit; the suppression records would need to carry the reconciler's stated
  rationale, and the dispatch gate would need to verify every suppression is
  backed by a staged reconciler decision (the same pattern the thread
  resolutions use today). Adds model spend on every re-review with a
  non-empty corpus.

### (b) Cross-file similarity

Drop the path key for the adjudicated corpus only (open-thread suppression
keeps it): a non-blocking candidate is suppressed when its claim text clears
the similarity floors against any adjudicated thread, whatever the paths.

- For: pure code, no new model call, smallest diff.
- Against: the similarity floors were tuned with the path key in front of
  them. Without it, two findings that share domain vocabulary ("flagged
  turns", "pre-flight modifier") but describe different defects are the
  obvious false-suppression case. The floors would need re-tuning against a
  corpus that contains hard negatives, and the 41290 family itself shows the
  wording of true variants diverges a lot (a spec-caveat suggestion versus a
  telemetry-leak note), so recall may stay low even after tuning. This
  candidate is cheap to evaluate and plausibly not good enough.

### (c) Mechanism fingerprints minted by finders

Add an optional `mechanism` field to the finding schema: a short, code-like
identifier for the underlying mechanism (for the family above, something like
`tmv2-cedar-publish-on-flagged-turn`), minted by the finder sub-agents and
carried through staging into the corpora. Matching is then exact or
near-exact string comparison in code.

- For: matching stays deterministic and auditable; no new model pass at
  suppression time.
- Against: the fingerprint is only as stable as the models' naming. Two runs
  can mint two names for one mechanism (splitting the family), or one name
  for two mechanisms (merging them, the false-suppression case). Needs a
  schema version bump, prompt changes in every finder, and a measured
  name-stability rate before it can be trusted. Unknown today: whether
  name stability across runs and across finder roles is anywhere near high
  enough; nothing in the current corpus measures it.

## Fail-closed rules that carry over unchanged

Whatever the matcher, the #332 asymmetries stay:

- A blocking candidate is never suppressed by the adjudicated corpus. A
  regression worth stopping the PR for re-presents at blocking severity and
  posts.
- A thread the bot resolved never joins the corpus; membership requires a
  human `resolvedBy` (or, with #333, a downvoted opener).
- Absent, malformed, or unmatchable data reads as no adjudication: every
  guard fails toward posting a duplicate, never toward dropping a finding.
- A candidate matching both corpora is attributed to the open thread, so the
  verdict floor keeps reading the open thread's blocking state.

## Eval plan (before any code)

1. Build corpus cases from the 41290 family: the real threads and reply
   chains as the adjudicated corpus, plus candidate findings in three
   classes: true variants (the five threads above, re-derived), hard
   negatives (findings on the same files sharing vocabulary but describing
   different defects), and unrelated controls.
2. Score each candidate design as a classifier over those cases: suppression
   precision (hard negatives must post) and recall (true variants must be
   suppressed). Candidate (b) can be scored offline from the existing
   matcher; (a) and (c) need producer support to dispatch the judgment pass
   or mint fingerprints.
3. Set the acceptance bar before running: a false suppression is worse than
   a duplicate post, so precision gates and recall ranks. A candidate that
   cannot beat the do-nothing baseline's annoyance cost (measured duplicate
   rate) does not land.
4. Whatever lands, add the suppression records to the run artifact with the
   match basis (path, similarity score, reconciler rationale, or
   fingerprint), so a wrong suppression is diagnosable from the artifact
   alone.
