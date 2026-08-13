---
"review": patch
---

review: retitle the risks/patterns comment "Guidance for reviewers" and add a one-line byline naming its audience

"Review Guidance" parsed two ways on the PR timeline: guidance for reviewers,
or guidance from the bot's review. Sitting directly above the author-directed
finding threads, it read like the latter. The new title parses one way, and a
single italic byline under it ("Triage notes for reviewers: risky files by
owning team, repeated changes, and files excluded from review.") states the
audience and contents in the comment itself.

Nothing keys off the heading text: comment identity is the
`<!-- pr-reviewer:risks-and-patterns -->` marker, and the repost-dedup key is
content-based (risk files, owning teams, pattern file sets, excluded set,
NOTIFIED signature). The rename posts nothing and pings no one; existing
comments keep the old title until the next substantive change posts a new one.
