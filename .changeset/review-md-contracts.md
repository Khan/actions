---
"review": minor
---

Read per-directory `REVIEW.md` review contracts from the consuming repo. When the checkout carries them (a root `REVIEW.md` plus per-directory ones, as in webapp's agent-doc surface), the `correctness-reviewer` reads the root contract plus the nearest `REVIEW.md` above each reviewed file to calibrate what is Important versus a nit in that sub-tree, and the `claim-validator` uses the same contracts to calibrate claim labels (never `verification`, which stays code-evidence-only). Contract text can adjust emphasis but never overrides the workflow's rules, and since these files are read from the PR head, an edited `REVIEW.md` is itself reviewed on its merits. Repos without `REVIEW.md` files are unaffected.
