# Design note: a roster-wide non-blocking cap for first reviews

Status: design only. The cap is a posting-surface change with a real recall
cost if done wrong, so it ships opt-in via `ROUTING` (the way `enable` lines
and `re-review` modes do) and only after the live A/B has priced it.

## The measured problem

Khan/webapp#41440 drew 15 inline comments in a single first review: 2
blocking, 13 non-blocking. The non-blocking set contained overlap clusters
the in-run clusterer (#312) did not merge: an exact duplicate body posted on
two sibling eval files (r3764122555 and r3764122558, which the path-keyed
clusterer cannot group), a note plus a question on the same VisualJudge
default change, and four comments circling one decision-tree interaction
(the YES-table/Q3 bypass). The author engaged with all of it, but 15 threads
on one push is the attention failure mode the documentation reviewer's
volume policy already names: the marginal thread costs reviewer attention
that the marginal finding does not repay.

Re-reviews already have a lever (`blocking-only`, #329). First reviews have
none: every validated finding posts inline, however many there are.

## Prior art to build on

- **The documentation reviewer's caps** (one finding per comment, two per
  file, five per review) with ranked clause shedding: the policy's clauses
  are ordered and the tail drops from the bottom. This is the shape to
  generalize: a cap plus an explicit ranking, so what sheds is chosen, not
  arbitrary.
- **The `blocking-only` modifier's collapse rendering** (#329): validated
  non-blocking findings render as one line each inside a `<details>` block in
  the review body instead of posting inline. The rendering path exists; a
  first-review cap can reuse it for the tail rather than dropping findings.
- **Recap damping** (#334): the same principle (full text once, label plus
  link after) applied to the accountability section.

## Design questions

1. **Ranking signal.** Candidates: severity label (blocking always posts and
   never counts against the cap; then suggestion over note over question over
   nitpick over thought), validator confidence if the validator can be made
   to emit one, finding source (correctness findings over advisory
   reviewers'), risk tier of the anchored file. Unknown: whether the
   validator's confidence is meaningful enough to rank on; nothing measures
   it today.
2. **Cap value and grain.** The documentation reviewer uses 5 per review and
   2 per file. A roster-wide cap has more sources feeding it; whether the
   right number is 8, 10, or per-file-only needs the A/B, not intuition.
   41440's 15 would have been over any plausible value.
3. **Collapse versus drop.** The tail should collapse into the review body's
   `<details>` block (the #329 rendering), not drop: the finding was
   validated, the author may want it, and a collapsed line costs near-zero
   attention. Dropping is only defensible if the A/B shows collapsed tails go
   unread anyway.
4. **Interaction with clustering.** The cap counts post-dedup, post-cluster
   findings; otherwise it double-punishes the clusterer's misses. The 41440
   sibling-file duplicate argues for fixing cross-file clustering first, so
   the cap does not paper over a dedup gap.

## Invariants

- **The verdict floor is untouched.** The verdict stays computed from every
  validated claim; the cap moves findings off the inline surface, never out
  of the verdict. This is the same rule `blocking-only` already follows, and
  it is what keeps the cap from ever flipping an outcome.
- **Blocking findings never collapse.** Same as #329 and #334.
- **The shed is disclosed.** The review body says how many findings
  collapsed and why (cap), the way budget sheds and skipped dimensions are
  disclosed today; a silent cap is indistinguishable from lost coverage.
- **The dispatch gate extends naturally**: a queued inline comment set larger
  than the staged plan's capped set is a conformance violation like any
  other plan deviation.

## Measurement before default

Price the cap with the live A/B: arms identical except a `ROUTING` line
(spelling to be decided; a `first-review` counterpart to the `re-review`
line, or a modifier on it). Score comment volume, must-catch recall (a
capped run must not collapse a must-catch into the tail), and the judge's
quality read, with the usual caveat that recall against labeled specs is the
load-bearing metric. Ship as opt-in; a default change needs its own measured
argument, the way `re-review` modes earn theirs.
