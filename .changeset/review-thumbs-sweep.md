---
"review": minor
---

Add the thumbs feedback sweep (`workflows/review/lib/thumbs-sweep.ts`): deterministic code that detects new thumbs-down reactions on reviewer comments at both grains (inline and summary), posts exactly one structured follow-up per downvoted comment (fixed reason vocabulary plus free text), and never re-pings thanks to durable HTML markers. All GitHub access sits behind an injected port; the sweep is config-driven so any consumer repo can run it.
