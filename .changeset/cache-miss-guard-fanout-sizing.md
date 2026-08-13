---
"review": patch
---

Size the AWF api-proxy cache-miss guard for the parallel sub-agent fan-out:
`max-turn-cache-misses: 25` (the compiled default of 5 was smaller than the
fan-out's worst-case burst of cold-session first requests, which are all
guaranteed prompt-cache misses; the PR #328 re-run lost that ordering race,
the proxy 403'd every remaining lens, and the run reviewed nothing). A
genuinely broken cache, the guard's real target, still trips quickly: it
misses on every response of a several-hundred-request run.
