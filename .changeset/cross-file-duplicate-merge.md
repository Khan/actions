---
"review": minor
---

review: merge one source's identical finding across files into a single pattern-level comment

Both dedup tiers require the same path and different sources by design: they
merge agreement between reviewers, not repetition by one reviewer. Measured on
Khan/webapp#41440, one source posted byte-identical documentation suggestions
on two sibling eval files as two comments (inline comments 3764122555 and
3764122558), and no existing rule could reach the pair.

A new pass (`dedup-crossfile.ts`) runs after the cross-source tiers settle:
findings from the same source with the same label on different files merge
when their text is identical, or near-identical above the strict
different-line similarity floor (equal line numbers in different files never
buy the laxer exact-anchor tier). The survivor is the first occurrence in
diff order; its discussion gains one trailing line naming the other
occurrences (path, and line where known); merged copies skip validation and
posting and are recorded in the run artifact under `crossFileMerges`. Label
equality keeps the verdict arithmetic unchanged: a merged blocking group
keeps one blocking claim and floors the verdict exactly once. Any doubt in
similarity posts separately; a missed merge costs a duplicate comment, a
wrong one drops a finding.
