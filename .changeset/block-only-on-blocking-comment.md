---
"review": patch
---

Only ever request changes when at least one posted comment is actually blocking. The verdict is now a mechanical function of the labels on the comments that will be posted: REQUEST_CHANGES if and only if the final comment set contains a blocking label (`issue (blocking)`, `issue (blocking, best-practice)`, or `todo (blocking)`), otherwise APPROVE. Previously the verdict was a category judgment that could land on REQUEST_CHANGES even when every posted comment was non-blocking.
