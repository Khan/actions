---
"autofix": patch
---

Two fixes from the first live trial run (Khan/webapp#41130), both of which stopped autofix working at all.

**The plan CLI was never executable.** The `bash:` allowlist used gh-aw's documented `"npx *"` form, which its schema describes as "command with any args" but which compiles to the Claude Code permission `Bash(npx)` — matching only a bare `npx` with no arguments. So `npx -y tsx workflows/autofix/lib/plan.ts` was denied and the run fell back to reconstructing the plan by reading the library source, which is exactly what the determinism boundary exists to prevent. Switched to `"npx:*"`, which compiles to `Bash(npx:*)`, the form gh-aw's own defaults use. The prompt now also treats a non-executable CLI as a hard stop rather than something to work around.

Worth knowing: declaring a `bash:` list at all narrows the agent. A workflow with no `bash:` key (the reviewer) compiles to unrestricted `Bash`.

**The currency guard refused on any unstamped review.** `assessReviewCurrency` collapsed "no reviews at all" with "reviews exist but none carry a fingerprint", so a PR with real blocking feedback was reported as "no reviewer feedback has been posted on this PR". That is what happened on the trial PR, where the reviewer posted a correct blocking finding under a body of exactly `Changes requested — see inline comments.` and no stamp.

These are now distinct states, and the unstamped one **degrades instead of refusing**: the per-thread anchor check still runs (GitHub marks a review comment outdated when its hunk changes, which is the signal that actually covers "the author edited the flagged code"), and the summary carries a note saying the file-level check could not run. `hunks=overflow` degrades the same way. Only a PR with no reviews at all still refuses.
