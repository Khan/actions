---
"fix-workflows": minor
---

fix-workflows: accept a plain `ubuntu-latest` runs-on

With `fix-runs-on` enabled, every plain `runs-on` was wrapped in the
`USE_GITHUB_RUNNERS`/`ephemeral-runner` conditional, so a job could not be moved
to a GitHub-hosted runner without a `fix-workflows-ignore` comment. A plain
`ubuntu-latest` is now treated as compliant and left as-is; other plain runner
names (larger-runner labels, pinned Ubuntu versions) are still wrapped. The
checkout-followed-by-setup rule still applies to `ubuntu-latest` jobs.
