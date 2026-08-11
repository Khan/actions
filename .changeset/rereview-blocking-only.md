---
"review": minor
---

review: a `blocking-only` modifier on the ROUTING `re-review` line, so repeat reviews can surface only blockers

`re-review scoped blocking-only` keeps the configured depth's roster and
staging (the whole enabled roster over the new hunks, for `scoped`) but
changes the REPEAT review's posting surface: only blocking findings post
inline; validated non-blocking findings collapse to one line each in a
`Non-blocking observations` `<details>` block in the review body, with a
note line naming the count and the dial, and the depth note names the
modifier. The section always rides the body, never an inline comment: the
point of the dial is no non-blocking noise on inline threads.

This is the quadrant the existing modes could not reach. webapp ran
`flip-gated` (#40940) to quiet re-review chatter, then reverted to `scoped`
(#40968) because flip-gated silences the noise by not running the
whole-change reviewers at all, leaving post-review pushes seen only by the
correctness pass. `scoped blocking-only` keeps their blocking recall and
their observations (collapsed) while taking the non-blocking chatter off the
inline surface.

Semantics are deliberately narrow:

- It applies exactly when the run EXECUTES at a reduced depth. The first
  full review of a ready PR, a divergence-tripwire re-arm, and every guard
  that degrades to `full` still post everything; `re-review full
  blocking-only` warns at parse time that the modifier can never apply.
- The verdict is computed from every validated claim either way, so the
  modifier can never flip an outcome. A pr-level blocking claim still folds
  into the body; only non-blocking claims move. An all-clear blocking-only
  approval carrying the collapsed section is never the bare approve line,
  so the redundant-approval skip cannot swallow it.
- The modifier belongs to its line: with duplicate `re-review` lines the
  last line wins whole, modifier included. An unknown modifier warns and is
  ignored while the mode still applies (toward more review, never less).

Plumbing: `parseRoutingConfig` grows `reReviewBlockingOnly`, `routing.json`
carries it, and `submission.ts` applies it at the posting bar. Nothing
changes for any consumer until its ROUTING file adds the modifier, and the
line should be earned the way `re-review` modes are, through the live A/B.
