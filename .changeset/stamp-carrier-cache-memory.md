---
"review": patch
---

review: the re-review fingerprint anchors on cache memory; the body stamp never survives gh-aw ingest

gh-aw's safe-output sanitizer strips all XML/HTML comments (`removeXmlComments`), so the hidden fingerprint stamp a review body carries never reaches the PR: every production re-review planned `no-prior-fingerprint` and silently escalated to full depth, making the `re-review` ROUTING dial (scoped/flip-gated/fast) inert. The plan CLI now falls back to the Step 9 cache-memory record (`verdict`, `stampHunks`/`reviewedHunks`, `wasDraft`) when no prior-review body carries a stamp, and records which carrier anchored the plan as `stampSource` in `rereview-plan.json`. Step 9 gains a `stampHunks` field copied verbatim from the plan CLI's own hash computation so hash regimes are never mixed. Cache eviction still degrades to a full review, never a cheaper one.
