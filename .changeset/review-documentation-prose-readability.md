---
"review": minor
---

The documentation reviewer gains a readability half, and its scope grows to the
PR title and description.

The motivating problem is the slop register: technical prose (often
model-drafted) built from metaphorical verbs ("the round-trip has to survive an
input holding a config"), paragraphs that restate the previous paragraph in
different words, and shorthand a document coins and never defines. Readers
reported this as a real comprehension tax in docs and PR descriptions, and
nothing in the pipeline checked for it: the documentation policy was entirely
about information content (restates the code, narrates the change, falsified by
the diff, missing why), and the PR description was explicitly out of scope.

Three new clauses, framed as translation cost rather than taste so the reviewer
does not become a tone patrol:

- **Metaphor in place of the mechanism.** The test is whether the reader can
  recover the concrete operation from the sentence alone. Domain terms of art
  (a functional `fold`, "landing" a PR, a lock that is "held") pass, and quoted
  text is never flaggable.
- **Says the same thing twice.** The prose-doc form of restating the code: a
  paragraph recoverable from an earlier one. Both get quoted; the fix is
  deleting one.
- **Undefined coinage.** Shorthand invented and never defined; a term defined
  at first use passes.

These are the cheapest findings to produce, so they rank below every content
clause and carry their own sub-cap: at most one line-anchored readability
finding per review (batched, worst instance anchored) plus at most one PR-level
finding, both counting toward the existing five-per-review cap and dropped
first when it binds.

The PR title and description become reviewable prose under exactly these three
clauses. Intent-versus-implementation stays with `completeness`, and the
"narrates the change" clause never applies to a description (narrating the
change is what a description is for). Mechanically this rides plumbing that
already existed end to end but had no deliberate producer: a finding that omits
`path`/`line` becomes a `{type: "pr"}` anchor (`dispatch-contracts.ts`), passes
the provenance gate and scope filter unconditionally, and `submission.ts` folds
it into the review body as a `**label:** prose` line. The claim-validator's
documentation section now covers both readability claims (refute when the
flagged phrase is a term of art, or when the rewrite loses information) and
PR-level claims (verified against `pr-context.json`).

Eval support: `LiveDefectSpec` gains `prLevel: true` for defects that live in
the PR metadata rather than a changed file (no path or line window; only a
pr-anchored candidate can satisfy the spec, so a line-anchored comment never
claims it). Three new corpus cases exercise the clauses: a golden readability
case (metaphor sentence + restated paragraph, with term-of-art and quoted-error
traps), a golden PR-description case (one PR-level finding, with the
well-commented constant as a must-not-flag trap), and a clean precision guard
where every vivid word is doing real work and the run must post nothing.
