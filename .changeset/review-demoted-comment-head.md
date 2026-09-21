---
"review": patch
---

The COMMENT head stops claiming findings on a run that had none.

One canned head served both populations that reach the middle verdict: a run whose medium-importance findings earned it, and a reduced-depth run whose would-be approval the clearance demoted for want of a full roster (`submission-clearance.ts`'s `approveDemoted`). The second population has zero findings, so the head sent the author looking for unresolved mediums that were never posted — Khan/webapp#41639 is the observed case: a fast-depth reconcile-only round with every thread already resolved, nothing posted inline, and a body reading "medium-importance findings found; nothing blocks." A demoted approval now renders "**💬 Commented** — no new findings; approval requires a full review round." — or, in place of "no new findings", "see inline comments" when advisory comments posted, or "see the observations below" when a reduced posting surface collapsed the findings into the body's fold — which says the true reason the run is not an approval; the genuine medium COMMENT keeps its existing head. `renderReviewBody` takes the flag as a new optional `approveDemoted` input and `submission.ts` passes the value it already destructures off the clearance. Nothing parses the head, so no gate, skip predicate, or dispatch-gate comparison keys on the string.

Expected output-shape effect: on a reduced-depth run whose would-be approval was demoted, the body's first line changes wording — about +6 characters when nothing posted, +10 when inline comments posted, and +17 when findings collapsed into the observations fold; every other run is byte-identical, and inline comment counts are unchanged.
