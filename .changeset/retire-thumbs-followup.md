---
"review": minor
---

Retire the thumbs sweep's "why?" follow-up; the sweep is now read-only. The 2026-08-20 version audit measured 2 reason replies across the 31 follow-ups ever posted, 26 of them landing as bursts on one PR, and GitHub wraps each posted reply in an implicit empty COMMENTED review event that pollutes run counts and the PR timeline. A bare thumbs-down has adjudicated the finding directly since v1.17.0, so the ask carried no remaining purpose; authors who want to say why reply in the thread, which reaches the maintainer via the weekly feedback report. The sweep keeps its read side (identity-filtered reaction tallies, resolved-thread counts) unchanged; `REVIEW_SWEEP_DRY_RUN` is gone (nothing to dry-run) and the consumer workflow's token scope can drop to `pull-requests: read`. Anyone counting review runs should key on the v1.14.0+ version footer rather than review events: the autofix workflow's thread replies still carry the implicit-review shape.
