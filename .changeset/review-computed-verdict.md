---
"review": minor
---

Make the review verdict a deterministic computation instead of a model judgment: structured findings flow through a computed verdict (severity/confidence truth table, with a hold-for-human outcome for policy conflicts), templated comment rendering, and a missing-dimension gate that refuses to conclude when a required review dimension produced no findings and no explicit all-clear. The model authors findings; code decides the verdict and renders the comments.
