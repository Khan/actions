---
"review": patch
---

Split the Step 3 roster concern out of `dispatch.ts` into `dispatch-roster.ts` (`DEFAULT_FINDERS`, `SHED_RANKING`, `Roster`, `RosterShed`, `computeRoster`), re-exported from `dispatch.ts` so callers and tests keep one import surface. No behaviour change: the moved code is byte-identical and every existing test passes unmodified.

The trigger was a lint failure on main that neither contributing PR could see. `@khanacademy/eslint-config` caps a file at 1000 lines; #302 took `dispatch.ts` to exactly 1000, and the one line #299 added to the shed ranking took it to 1001. Both were green against their own bases, so the collision existed only in the merge. `dispatch.ts` is now 920 lines, and the split follows the precedent `dispatch-contracts.ts` already set for the same budget.
