---
"review": patch
---

Add three live-enabled eval corpus cases porting the Khan/webapp#40678 seeded-defect trial into the review-workflow corpus. All three are sanitized structural rewrites: fresh Go code around a generic "notes retention" feature that reproduces the trial's defect mechanisms, carrying no webapp code, paths, or identifiers.

- `trial-retention-deletion` (incident-repro): the deletion-path seeds; a flag-gated compliance deletion, a query-default limit of 1, a reimplemented deletion helper, an env-interface widening flagged in both files, and a swallowed prune error.
- `trial-retention-prune-tests` (incident-repro): the prune-and-tests seeds; an off-by-one retention cap, a vacuous cap test that passes for a no-op prune, a suite-wide flag-ON mock hiding the flag-off path, and a full-entity fetch where keys-only suffices.
- `trial-batch-delete-wrapper` (clean): the trial's deliberate non-defect as a must-not-flag trap; a large single DeleteMulti call that looks over the datastore's 500-entity cap but is chunked internally by the (unchanged, in-tree) datastore wrapper. The recorded false block is refuted by validation and the case must approve.
