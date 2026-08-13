---
"review": minor
---

review: name the producing reviewer on every posted finding, in footers collapsed by default

Every inline review comment and pr-level body fold now ends with a collapsed
`<details>` attribution footer (summary chip `review details`) naming the
reviewer that produced the finding and, when cross-source dedup merged
duplicates into it, each other reviewer that flagged the same defect, with its
differing anchor line and (for clusterer-merged copies) its own subject.
Collapsed one-liners (the low-confidence section, a hold comment's claim list)
carry a short trailing `<sub>(<source>)</sub>` tag instead.

The dedup merge record moves from a prose note appended to the survivor's
`discussion` to a structured `also_flagged_by` field on the claim, rendered at
the posting surface (`submission.ts`): the claim-validator's
`corrected.discussion` rewrite could previously drop the note silently, and
the old "Also flagged by" wording never named the surviving reviewer at all.

The version/config footer on review bodies and the guidance comment is wrapped
in the same collapsed block (`details`/`summary`/`sub` are all on the ingest
sanitizer's allowed-tag list, so the block survives posting). Text-similarity
comparisons against previously posted bodies (open-thread suppression, the
adjudicated corpus) strip the footers first, so boilerplate shared by every
bot comment cannot inflate similarity between unrelated findings.
