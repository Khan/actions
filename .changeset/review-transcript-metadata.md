---
"review": patch
---

Keep token/cache usage and dispatch outcomes in eval transcripts. Each attempt
records completion status, wall time, available stop/error detail, and the SDK
result's cost, turns, and per-model token totals. Failed attempts keep the
metadata received before the failure. Messages retain ids, models, and raw
usage snapshots without summing repeated snapshots or inferring reasoning
tokens. Missing result totals stay absent rather than reading as zero spend.
