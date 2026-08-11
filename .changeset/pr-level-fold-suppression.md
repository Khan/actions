---
"review": patch
---

review: pr-level claims respect open-thread suppression, and a long pr-level fold collapses instead of walling the body

Measured on webapp#41290 review 4867627688: a reviewer re-found the data race
that two open blocking threads (r3721196429, r3721196434) already tracked,
anchored it `pr`-level (the race spans three files), and the review body
carried the full ~2,600-char finding as one unformatted paragraph, directly
under the accountability section listing those same two threads as "still
unaddressed". Two independent defects compounded there:

1. **Open-thread suppression had a pr-level hole.** `suppressOpenThreadDuplicates`
   matched on `path`, and a pathless claim was passed through unconditionally,
   so a pr-anchored duplicate of an open thread could never be suppressed (and
   cross-source dedup requires path equality too, so its anchored siblings could
   not absorb it either). A pathless claim now compares against every open
   thread and pays for the missing anchor with a stricter floor, one tier above
   the same-path rate (`PR_LEVEL_FLOOR`: 0.2 jaccard / 0.35 overlap / 8 shared
   bigrams). Calibrated on that run's real texts: the two true counterparts
   score 0.342/0.558/40 and 0.329/0.643/23 while the six unrelated open threads
   top out at 0.051/0.180/1, so the floor clears both real duplicates with wide
   margin and sits far above every non-duplicate. `dedup-pr-level.test.ts`
   carries the run's texts as fixtures, including a tier-boundary case proving
   the same text suppresses with an anchor and posts without one at 7 shared
   bigrams. `ThreadSuppression.path` becomes optional to carry the pathless
   record; a suppressed pr-level blocking candidate floors the verdict exactly
   as an anchored one does.

2. **The body fold rendered the discussion verbatim, whatever its length.**
   A pr-level claim that survives suppression still folds into the review body
   (the inline-comment safe output needs a path and line), but past a
   short-paragraph cap (`MAX_VERBATIM_FOLD_CHARS`, 400) the fold now carries
   the claim's subject line with the full discussion in a `<details>` block,
   so a genuinely new cross-file finding stays readable without burying the
   accountability section and note lines around it. Short folds are unchanged
   byte for byte, and the dispatch-conformance gate's plan-match rule is
   unaffected because the plan and the queued body change together.

Both changes degrade safely: a missed suppression posts a duplicate comment
(the pre-existing behavior), never drops a finding, and the fold never loses
content, only collapses it.
