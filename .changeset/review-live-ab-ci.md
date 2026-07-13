---
"review": patch
---

CI wiring for the live A/B (live A/B plan, phase 4): the `Review Eval A/B` workflow runs on every non-draft PR touching `workflows/review/**` (plus `workflow_dispatch`), executing the arm-to-arm live eval against the PR's merge-base and posting the delta report as a sticky PR comment, a job summary, and an artifact. Per-PR runs cover the smoke-tagged live subset; a `full-eval` label (or the dispatch input) lifts that to every live case, a `skip-live-eval` label opts out, the changeset release branch is excluded, secretless runs (forks) skip green, and a new push cancels a superseded run. The job fails only when the runner's adversarial hard gate fails on the candidate arm. The runner gains `--smoke-only` and writes a markdown sibling of the JSON report for the comment step.
