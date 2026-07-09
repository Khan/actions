---
"get-changed-files": patch
---

Fix a crash (`core.warn is not a function`) on push events when the pushed commit is associated with more than one open PR, as happens with stacked PRs. The github-script `core` API method is `core.warning`, not `core.warn`.
