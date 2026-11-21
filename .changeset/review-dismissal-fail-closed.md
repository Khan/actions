---
"review": patch
---

A reduced-depth round no longer dismisses a standing request-changes review unless the thread-reconciler resolved every staged blocking thread. Until now the dismissal only checked that no blocking thread was kept. That check passed when the reconciler produced no usable output, or left a blocking thread out of both its `resolve` and `keep` lists, and the block was dismissed with nothing reconciled. `rereview.json` now records `unresolvedBlockingCount`, and the clearance requires it to be zero. When it isn't, the block stands and the plan notes why.
