---
"review": patch
---

Docs only: stop recommending `gh aw update` anywhere in this repo. The review-consumer-bump skill (Khan/actions#357) documents it failing twice against this repo's tag scheme, observed live on 2026-08-20: it treats `review-v<version>` as a branch and repins to main's head SHA, and its 3-way merge emptied a consumer's installed `review.md` to 0 bytes (gh-aw v0.85.4). The consumer-facing README recommended it in 4 places and the review-onboarding skill in another 4; all 8 now describe the maintainer-driven bump flow (a manual `git merge-file` 3-way merge, one PR per consumer) and the README names the failure modes plus the condition for revisiting the ban (neither failure is filed upstream yet). The shipped `review.md` changes only in a frontmatter comment (the observability local-edit note no longer names `gh aw update` as the merger); no behavior change.
