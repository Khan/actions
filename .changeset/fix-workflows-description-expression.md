---
"fix-workflows": patch
---

fix-workflows: don't write `${{ … }}` in an input description

The `config-file` input's description spelled out the default allowlist entry,
`${{ vars.USE_GITHUB_RUNNERS == … }}`. The runner parses `${{` in an input's
description as an expression when it loads the action, and `vars` isn't one of
the contexts available there, so every job using v4.0.0 failed at "Set up job"
with "Unrecognized named-value: 'vars'". The description now gives the
expression without its braces and points to the 4.0.0 entry in this CHANGELOG
for a copy to paste into the config with them. A repo-wide test now fails if any
action's description contains `${{`, whatever context it uses, since which
contexts each description field allows isn't documented.
