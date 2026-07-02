---
"review": patch
---

Let a `skip-ai-review` label opt a PR out of automated review. The label is checked in the workflow's job-level `if:` condition, so a labeled PR never starts the agent (zero AI credits) and posts nothing. It gates each trigger event going forward; it does not retroactively dismiss a review already left before the label was added.
