---
"autofix": minor
---

Add `docs` to the scope axis: `autofix: docs` / `/autofix docs` fixes only the `documentation` reviewer's threads, selected by the label that reviewer mints (`suggestion (non-blocking, documentation)`).

It is a **subset of `nits`, not a peer of it**. Documentation findings are non-blocking, so `nits` already covers them and arming both is the same as arming `nits`; the containment runs one way only, and `docs` exists because arming `nits` to clear three stale comments also invites the fixer into every other cosmetic thread on the PR. The flat token namespace cannot express that, so `scope.ts` and the README both say it. `findingLabelsForScope` becomes an exhaustive switch rather than a blocking/non-blocking ternary, and the tests pin the containment and the absence of any blocking label from docs scope.

`docs` is **not loop-eligible**, which is worth stating because it looks like the exception to "nits never loop" and is only half one: its deletion half converges (a comment that restates the code is either gone or not), while the documentation reviewer's *missing explanation* findings are answered with prose, and prose can always be wanted better. Ineligible until something measures which half dominates.

One prompt rule comes with it: a documentation item changes text, never code. Deleting a redundant comment is the expected fix (and such findings often carry no suggestion block, since a deletion cannot be expressed as one), but if the honest fix would touch an executable line the item is left unfixed and reported rather than becoming a code change wearing a documentation label. That property — edits that cannot alter behavior — makes `docs` the safest scope to trial first in a repo new to autofix.

Note the version coupling: autofix selects threads by parsing the label off each posted comment, so this scope finds threads only in repos whose **installed** `review` release mints the documentation label. Against an older reviewer it is not broken, just always empty.
