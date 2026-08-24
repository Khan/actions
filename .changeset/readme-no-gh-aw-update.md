---
"review": patch
---

Docs only, following up on the `gh aw update` ban Khan/actions#357 landed. The consumer-facing README now names the gh-aw version both failures were observed on (v0.85.4) and the condition for revisiting the ban: neither failure is filed upstream yet, so re-test both on a scratch install before trusting a newer gh-aw release. The consumer-config checker's `source-missing` warning no longer frames `gh aw update` as the update mechanism; it now cites the reason `source:` still matters (the manual bump flow reads it to tell which release the install was copied from). The onboarding skill's update block gains an explicit stop comment between the merge instructions and `gh aw compile`, so a reader cannot run the block straight through and recompile an unmerged install. This repo's own installed `review.md` changes only in a frontmatter comment (the observability local-edit note no longer names `gh aw update` as the merger; lock recompiled); no behavior change.
