---
"review": patch
---

Eval reports for identical-arm runs (`--force-arms`: the weekly drift watch and manual wobble controls) no longer read as an A/B. The single-run, multi-repeat, and aggregate renderers retitle themselves "Review wobble control (identical arms)", relabel the Baseline/Candidate columns to Arm A/Arm B, state up front that between-arm deltas are run-to-run wobble, and the aggregate leads with the noise-floor bands (on an identical-arm pool the bands are the product; the per-case table is the raw material). Motivated by the first scheduled drift report (PR #265), whose baseline-vs-candidate framing over one prompt invited reading noise as a result. Also raises the drift workflow's default budget from $85 to $120: the 2026-07-20 run spent $84.33 of the $85 cap and budget-skipped cases, which contaminates the noise-floor bands with case-mix variance (the corpus has roughly doubled in cost since the cap was sized). README cost figures updated to match.
