---
"fix-workflows": minor
---

fix-workflows: add an `allow-ubuntu-latest` input

With `fix-runs-on` enabled, every plain `runs-on` is wrapped in the
`USE_GITHUB_RUNNERS`/`ephemeral-runner` conditional, so a job could not be moved
to a GitHub-hosted runner without a `fix-workflows-ignore` comment. Some repos
are moving jobs to GitHub-hosted runners because the ephemeral-runner pool lacks
the capacity for their CI load. The new `allow-ubuntu-latest` input (CLI:
`--allow-ubuntu-latest`) lets those repos leave a plain `ubuntu-latest` as-is.
Other plain runner names (larger-runner labels, pinned Ubuntu versions) are
still wrapped, and the checkout-followed-by-setup rule still applies to
`ubuntu-latest` jobs. The input is off by default, so repos that don't set it
see no change.
