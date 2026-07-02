---
"review": patch
---

Stop the reviewer from re-commenting on code a previous review already covered. Each run now records a content-based "hunk signature" (a hash per hunk over its added lines only) in cache memory, and scopes new inline comments to hunks whose content is new since the last review. Because the signature keys on added-line content — not commit SHAs or line numbers — it survives force-pushes, rebases, squashes, and base-branch merges: a rebase with no real edits produces zero re-review. Risk classification, patterns, and reviewer routing still consider the whole PR. A narrow exception keeps genuine `issue (blocking)` correctness findings even on unchanged code; nits, suggestions, and all skill violations are scoped strictly to newly-changed code.
