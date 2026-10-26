---
"fix-workflows": patch
---

fix-workflows: don't write `${{ … }}` in an input description

The `config-file` input's description spelled out the default allowlist entry,
`${{ vars.USE_GITHUB_RUNNERS == … }}`. The runner parses `${{` in an action's
descriptions as an expression when it loads the action, and `vars` isn't
available there, so every job using v4.0.0 failed at "Set up job" with
"Unrecognized named-value: 'vars'". The description now gives the expression
without its braces, and a test fails if any description contains `${{`.
