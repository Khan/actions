---
"review": patch
---

review: emit fix sketches only under fix-proposing labels

Measured on Khan/webapp (2026-08-11/12): 31 of 57 posted inline comments
carried an "A sketch, not a committable replacement" block, including
question and thought comments that propose no fix; there the sketch restates
the prose and adds length (mean body 874 chars) without information.

Two layers. The renderer now appends a sketch only when the claim's base
label token is `issue`, `todo`, or `suggestion` (every variant counts:
`suggestion (non-blocking, documentation)` is a suggestion); a sketch under
`question`/`thought`/`note`/`nitpick` is dropped at render time. And the
finder prompts (correctness-reviewer, holistic, completeness, test-adequacy,
first-principles, conventions) now ask for `suggestion` only on
fix-proposing findings, so the payload is not authored in the first place.

Committable drop-in `suggestion` fences are unchanged, as are rule quotes
and the prose itself; an empty or unparseable label stays sketch-eligible
(fail toward more information).
