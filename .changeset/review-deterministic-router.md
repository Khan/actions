---
"review": minor
---

Add the deterministic review router (`workflows/review/lib/router.ts`): pure TypeScript that classifies changed files (generated vs source via .gitattributes), selects which specialist lenses to spawn by touched paths, maps owning teams from REVIEWERS rules (subsuming the old reviewer-mapper sub-agent), assigns per-file risk tiers, and computes one run budget scaled by the highest touched tier with a misrouted-PR floor. Diff-direction-dependent tiers are deferred to a single small-model call instead of guessed.
