---
"fix-workflows": patch
---

fix-workflows: don't write `${{ … }}` in an input description

The `config-file` input's description spelled out the default allowlist entry,
`${{ vars.USE_GITHUB_RUNNERS == … }}`. The runner parses `${{` in an input's
description as an expression when it loads the action, and `vars` isn't one of
the contexts available there, so every job using v4.0.0 failed at "Set up job"
with "Unrecognized named-value: 'vars'". The description now describes the
default in words, as the `ubuntu-latest` form of the `USE_GITHUB_RUNNERS` /
`ephemeral-runner` toggle, and notes that the run's log prints it in full when
it's used. A repo-wide test now fails if any action's description contains
`${{`, whatever context it uses, since which contexts each description field
allows isn't documented.
