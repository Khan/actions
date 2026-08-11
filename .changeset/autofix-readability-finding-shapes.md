---
"autofix": minor
---

The fixer learns the documentation reviewer's two new readability finding
shapes (review's prose-readability release: metaphor in place of the
mechanism, says-the-same-thing-twice, undefined coinage).

Three rule changes in `autofix.md` Step 4, no code changes:

- **Batched instances are in scope.** The reviewer caps readability at one
  thread per review and enumerates up to three further instances, verbatim, in
  that thread's body. The do-not-touch-other-files rule gains a second
  exception for them: each *quoted* instance is part of the finding wherever
  it lives, while an instance merely alluded to without a quote is not.
  Without this, the fixer could only ever fix the anchored instance, the
  thread could never fully resolve, and the batching (which exists to spare
  the author five separate threads) would trade author attention for fixer
  blindness.
- **Readability rewrites are applied verbatim.** A readability finding carries
  its plain rewrite, and that rewrite passed claim validation, which checked
  it preserves the original sentence's meaning. The fixer's improvised
  paraphrase passed nothing, so improvising is now off the table: apply the
  reviewer's words, or (when the file has drifted and the quote no longer
  fits) leave the item unfixed and say so.
- **Duplicate paragraphs are deleted, never re-worded.** The existing
  rewrite-before-delete bias is calibrated for a restated comment sitting on
  unexplained code. Applied to a says-the-same-thing-twice finding it would
  produce a third phrasing of content that already exists twice, which is the
  defect the finding names. Deletion of the quoted copy is the fix.

The README documents the one shape that stays out of reach by design: a PR
title/description readability finding folds into the review body and never
becomes a thread, so the thread-driven worklist cannot see it. The description
is the author's voice; the review body already offers them the rewrite.
