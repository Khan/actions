---
"review": patch
---

check-consumer-config: fail loudly when `--repo` names a path that does not exist. The flag takes a path to the consumer checkout, but an `owner/name` argument parses fine and resolves as a relative path, so every check reported missing and the report read as a catastrophically broken install instead of a typo (hit live during the 2026-08-20 rollout; the review-consumer-bump skill documents the footgun). The checker now throws naming the bad path. Also deduplicates parseArgs's twice-declared inline arg type into one `CliArgs` alias to stay under the max-lines cap the file already sits at.
