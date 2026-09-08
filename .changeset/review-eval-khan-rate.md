---
"review": patch
---

review eval: price the A/B report at Khan's rate beside list, from tokens

Every cost the eval has ever reported is provider list price (the runner's
`total_cost_usd`), because the `models.providers` overlay that halves
Anthropic's rate for production applies inside the awf api-proxy, which the
eval never crosses. So a claude arm's cost row read at 2x what production
meters, and a cross-provider A/B at list skewed against any model with no
overlay entry. The runner now records per-model token counts (the SDK
result's `modelUsage`) beside the dollars, and one module, `pricing.ts`,
turns tokens into dollars at either rate: Khan's, read off review.md's
overlay at render time, or list, from the one table the eval keeps, which
the report checks against the runner's meter on every run. The A/B table
carries "Cost (Khan rate)" beside "Cost (list price)", prices the judge and
match arbiter from their tokens (they were previously uncounted), totals the
run, and reads cost per tool call, the clusterer's price, gate-retry spend,
and the repeats aggregate's pooled cost in both currencies. The recorded
`usd` is unchanged, so prior artifacts stay comparable and render n/a on the
new rows.
