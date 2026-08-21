---
"review": minor
---

Make a dispatcher death visible on the PR. When the dispatcher's Bash call dies without writing `dispatch-result.json` (killed at the engine ceiling, or crashed), the orchestrator now posts one standalone PR comment saying the review died mid-dispatch and posted no review, with a link to the run, instead of only writing an incomplete report. Run 32418662895 (Khan/actions#362) hit exactly this: the run stayed green, the incomplete report tried to file an issue on a repo with issues disabled, and the PR showed nothing.

The death comment collapses the standing risks/patterns guidance comment (`hide-older-comments`), exactly like a hold comment does, so the Step 9 cache CLI now recognizes the no-plan death shape (a queued `add_comment` with no submission plan staged) and drops `risksPatternsKey` from the prior record; the next run reposts the guidance, and fingerprints stand untouched so it reviews in full.
