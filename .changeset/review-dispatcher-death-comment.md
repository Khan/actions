---
"review": patch
---

Make a dispatcher death visible on the PR. When the dispatcher's Bash call dies without writing `dispatch-result.json` (killed at the engine ceiling, or crashed), the orchestrator now posts one standalone PR comment saying the review died mid-dispatch and posted no review, with a link to the run, instead of only writing an incomplete report. Run 32418662895 (Khan/actions#362) hit exactly this: the run stayed green, the incomplete report tried to file an issue on a repo with issues disabled, and the PR showed nothing.
