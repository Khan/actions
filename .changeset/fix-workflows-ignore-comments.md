---
"fix-workflows": minor
---

Support inline `# fix-workflows-ignore` comments to opt a job or checkout step out of a fix.

Some jobs legitimately need a specific runner (e.g. `runs-on: ubuntu-latest-m`) or intentionally skip the secure-network setup step, but the fixer previously rewrote them unconditionally. You can now annotate the exact line to opt out:

- On a `runs-on:` line (trailing, or as the job's leading comment) to skip the runs-on rewrite:
  `runs-on: ubuntu-latest-m # fix-workflows-ignore`
- On a checkout step (trailing on its `uses:` line, or as the step's leading comment) to skip inserting the setup step after it:
  `uses: actions/checkout@v4 # fix-workflows-ignore`

An unscoped directive skips every rule for the annotated line; a scoped directive names which rules to skip (`# fix-workflows-ignore: runs-on`, `# fix-workflows-ignore: setup`, or both). `# lintignore` is accepted as an alias.
