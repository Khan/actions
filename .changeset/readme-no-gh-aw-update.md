---
"review": patch
---

Docs only: stop recommending `gh aw update` in the consumer-facing README. The review-consumer-bump skill (Khan/actions#357) documents it failing twice against this repo's tag scheme, observed live on 2026-08-20: it treats `review-v<version>` as a branch and repins to main's head SHA, and its 3-way merge emptied a consumer's installed `review.md` to 0 bytes (gh-aw v0.85.4). The README told consumers to run it in 4 places; all 4 now describe the maintainer-driven bump flow (a manual `git merge-file` 3-way merge, one PR per consumer) and name the failure modes. No change to the shipped review workflow.
