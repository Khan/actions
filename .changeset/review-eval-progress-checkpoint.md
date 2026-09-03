---
"review": patch
---

review eval: the live A/B prints progress and checkpoints its report after
every case

Run 33802457289 was cancelled 45 minutes in and left nothing: the actions log
went from the `tsx live-ab.ts` invocation straight to "The operation was
canceled", and no report file existed for the `always()` upload. The runner
now writes one stderr line per dispatch end (arm, case, agent, cost, tool
calls when the runner counts them) and one per case end (verdict against
expected, caught and missed keys, cost so far), and rewrites
`live-ab-report.json` plus the `.md` after every scored case, marked
`partial: true` in the JSON and `(partial)` in the markdown header until the
final write replaces it. `aggregate.ts` pools nothing from a partial
single-run report and only the finished repeats from a partial multi-run one.

The cancel itself came from a `skip-ai-review` label: the `labeled` event
fired the workflow, the per-PR concurrency group cancelled the live run, and
the new run then skipped every job. A `labeled` event for any label other than
`full-eval` now gets its own concurrency group, so a no-op event can't cancel
a live run.
