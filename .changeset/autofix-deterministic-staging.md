---
"autofix": minor
---

Move staging out of the prompt and into a deterministic pre-agent step.

`lib/stage.ts` now fetches everything the plan needs (labels, the reviewer's unresolved threads with their full reply chains, prior reviews, the diff, commit messages, the head SHA, and the `/autofix` comment body) and writes it to `/tmp/gh-aw/autofix/` as a `pre-agent-steps:` step, before the agent starts. Step 1 of the prompt is now a table describing what is already on disk. This follows the reviewer's own orchestrator slice 1 (#280): anything that never needed model output belongs in a pre-agent step, and a staging failure fails before any AI credits are spent.

The motivation was measured, not assumed. The first live run spent 131 assistant turns and 460 AI credits ($4.61) on a six-line fix while moving only ~93 KB of tool output across the whole run. Turns are the cost: each re-reads the accumulated context, so 131 turns over a ~43k-token context read 5.6M cached tokens, and cache reads were 61% of the bill (output 20%, cache writes 19%, uncached input 0.0%). Caching was already near-optimal at a 40.7:1 read-to-write ratio, so the fix had to be fewer turns rather than better caching. Staging alone accounted for roughly fifteen: seven creating a directory, five hand-assembling JSON through repeated `node -e` scripts, three reading this workflow's own library source to work out what the plan would decide.

Correctness improves too. The old prose asked the agent to stage each comment body "verbatim as the tool returned it", because a reformatted body breaks the `**label:**` parse that decides whether a finding is in scope. That was a hope; code copying a string is a guarantee.

Two findings from Khan/actions#287 are now recorded where they matter. gh-aw's safe-output ingest strips every XML/HTML comment before posting (`removeXmlComments`), which means the reviewer's fingerprint stamp has never reached a posted review, so autofix's `unverifiable` currency path is the normal path rather than an edge case; the reviewer's new cache-memory carrier is not reachable from here, because cache memory is scoped per workflow. The same sanitiser silently deleted this workflow's own `<!-- pr-autofixer:summary -->` marker from every summary comment, so the prompt no longer asks for one.
