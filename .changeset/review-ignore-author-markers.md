---
"review": patch
---

The reviewer no longer comments on a gap the author already marked with a `STOPSHIP` or `TODO` in the diff (AICODE-6). `correctness-reviewer` and `completeness` skip them, and `claim-validator` refutes any restatement that slips through. A `TODO` deferring a security or data-loss hole is still reported, since a `TODO` doesn't block merge.
