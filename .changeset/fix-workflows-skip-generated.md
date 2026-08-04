---
"fix-workflows": minor
---

fix-workflows: stop reformatting generated workflows

The YAML fixer already skipped `*.lock.yml`, but the separate `oxfmt` step in
`action.yml` (and its `cli.ts` equivalent) globbed `.github/workflows/**/*.yml`
with no exclusions, so it reformatted the compiled agentic workflows the fixer had
deliberately left alone. The "this file needs updating" annotation that follows
then points a maintainer at compiler output, and applying it desyncs a committed
lock from `gh aw compile`.

Both invocations now exclude the generator-owned workflows via negated globs, and
the fixer's own skip list is a named, tested predicate (`isGeneratedWorkflow`) so
the three call sites cannot drift apart again. `agentics-maintenance.yml` joins
`*.lock.yml` in that set: gh-aw regenerates it unconditionally and it is not named
`*.lock.yml`, so nothing was skipping it — it took 6 checkout-followed-by-setup
violations and 12 `runs-on` rewrites on a file no human can fix.

Negated globs rather than `ignorePatterns` in `.oxfmtrc.json`, because that config
lives in the action's own directory rather than the repo being formatted and its
patterns do not resolve against the working directory (verified: the lock was still
rewritten).

Observed on Khan/agent-settings#48, which is the first repo to run this action over
a directory containing compiled agentic workflows.
