---
# Khan/actions-specific reviewer configuration, merged into the shared review workflow
# (workflows/review/review.md in this repo) at COMPILE time via its `imports:` field.
#
# Only the frontmatter below is merged; this file's markdown body is ignored by
# `imports:`. This file owns the `add-reviewer` safe output; the repo-specific
# `allowed-team-reviewers` allowlist and the bot token used to request teams. It is
# defined ONLY here (never in review.md): gh-aw lets the main workflow override an
# imported safe-output of the same type, so defining it there would drop the allowlist.
#
# This repo also requests reviewers via Gerald (`.github/REVIEWERS`), which routes
# everything to @Khan/github-actions. This `add-reviewer` runs in addition to Gerald;
# the shared workflow's Step 8 dedups against teams already requested or reviewed.
safe-outputs:
  add-reviewer:
    target: "triggering"
    max: 2
    allowed-team-reviewers:
      - github-actions
    github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}
---

<!--
This file is a compile-time frontmatter import for the shared PR-reviewer workflow.
Its body is intentionally empty: `imports:` merges frontmatter only.
-->
