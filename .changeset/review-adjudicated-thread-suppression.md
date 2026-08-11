---
"review": minor
---

Resolving a bot thread now means "settled", not "open season for a rephrase". The staging collects the bot's threads a HUMAN resolved into a new adjudicated corpus (`adjudicated-threads.json`), and the dispatcher suppresses any non-blocking candidate that re-derives a defect that corpus already settled (same defect-identity match as open-thread suppression). Previously, resolution removed the thread from the only suppression corpus, so the next run could re-post the same concern with fresh wording as a brand-new thread, which every later accountability recap then reported as "still unaddressed" (webapp#41290: six resolved variants of one concern, then a seventh). Two safety asymmetries: a thread the BOT resolved (the reconciler, after a fix) never joins the corpus, and a BLOCKING candidate is never suppressed by it, so a fixed-then-regressed defect worth stopping the PR for always posts.
