---
"review": minor
---

Cap the `documentation` reviewer's volume, and stop it duplicating the docstring half of code defects.

The reviewer's failure mode is not precision, it is attention: on a 70-line fixture it returned seven findings, several of them the docstring half of a blocking finding whose code fix resolved the observation anyway, and one the *fourth* separate thread on a single comment. Its definition now carries volume as policy rather than taste: one finding per comment (a comment failing several clauses is still one finding), at most two per file and five per review, with an explicit ranking so the tail drops from the bottom — falsified-by-this-diff first, restatement cleanups last and first to go.

It also refuses a new class outright: when a comment and the code disagree and the *code* is the broken one, that is a correctness finding owned by the reviewers who block, and their fix settles the observation. Flagging it too spends a finding to say the same thing one severity lower and puts two threads on one line. A comment/code disagreement is only a documentation finding when the code is right and the prose is stale.

This composes with `dedup.ts` in the direction worth knowing: a cross-source merge keeps the highest-severity copy, so a documentation finding merged into a blocking one loses the `documentation` label and with it its eligibility for `autofix: docs`. That is the correct outcome — the code fix settles both — and it means tightening dedup narrows the docs autofix worklist toward standalone comment defects rather than reducing review coverage.
