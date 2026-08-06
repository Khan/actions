---
"review": minor
---

review: enforce the run's spend ceiling in code, in real dollars

Dispatch now carries a budget ledger. Work may start while the run's spend is
under a dispatch budget of `CEILING_USD - LANDING_RESERVE_USD`; crossing it
refuses further dispatches, aborts the agents already in flight, and discloses
every shed as a note line rather than as a silently missing dimension.

Why in code rather than at the proxy. The only ceiling today is gh-aw's
api-proxy credit cap (`maxAiCredits: 2500` in the compiled lock), which is
denominated in list-price credits rather than the dollars Khan pays, cannot shed
gracefully (it fails the run), and disappears with the proxy when the migration
completes. This supersedes the intent of #314, which tried to fix the
denomination at the proxy and was blocked on a gh-aw version; the proxy cap
stays as a coarse list-price backstop while it exists.

The numbers are derived, not chosen, and a test pins them so a change to live
spend behaviour is a review conversation: **$12.50** ceiling, from the lock's
2500-credit allowance minus the detection pass's measured ~$0.27 which this
ledger does not govern, against a measured ~$0.50 for a full case's sub-agents;
**$1.50** landing reserve, from the validator dispatch's measured ~$0.30 plus
the reconciler. The reserve is the part that is easy to omit and expensive to
miss: a ceiling with nothing held back turns an over-budget run into a wasted
one, because the run can no longer validate or post what it already paid to
find. Each consumer compiles its own lock, so a consumer with a different
allowance wants a different ceiling.

Enforcement is per turn where it can be. The runner asks the ledger at each turn
boundary whether the agent may continue, so a single heavy reviewer cannot
outspend a whole wave before anyone notices, and stopping happens at a turn
boundary rather than by throwing: an agent stopped for budget has usually
already found something worth keeping. The ledger has exactly one writer (the
dispatcher, once per completed attempt, so retries and refusal fallbacks each
pay), and the per-turn check is a read-only probe against it, which is what
keeps the accounting from double counting. Concurrency is approximated the way
the investigation cap approximates it: an in-flight agent cannot see its
siblings' unsettled spend, so a wave can overshoot by at most the number of
agents running at once, and `overshootUsd` measures that rather than assuming it
away.

`REVIEW_SPEND_ENFORCEMENT=proxy-only` is the rollback, and it measures without
enforcing: the record still reports `crossed`, still lists the sheds, and the
notice is loud, so a rolled-back run is not a blind run. The record names which
enforcement was in force, per the standing rule that where enforcement changes
over time the artifact says which one produced it.

The record itself (`DispatchResult.spend`: ceiling, reserve, spend, overshoot,
sheds, enforcement) is the run/cost/outcome telemetry shape, staged in both
`dispatch-result.json` and the `out/` copy the artifact upload carries. It is
deliberately a schema rather than an ad-hoc log line, because the same shape is
what a second consumer would need.

One property this does NOT restore, recorded in the module rather than implied:
awf's cap is un-weakenable because it lives in a container image no Khan repo
can edit, and this ceiling lives in a repo whose PRs this reviewer reviews. The
provider-side workspace limit that would have replaced that property is not
available, so CODEOWNERS on the ledger (naming two owners, since one stalls when
away and none enforces nothing) plus required review is the whole mitigation.
