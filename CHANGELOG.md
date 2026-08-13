# fix-workflows

## 3.4.0

### Minor Changes

-   132b633: fix-workflows: stop reformatting generated workflows

    The YAML fixer already skipped `*.lock.yml`, but the separate `oxfmt` step in
    `action.yml` (and its `cli.ts` equivalent) globbed `.github/workflows/**/*.yml`
    with no exclusions, so it reformatted the compiled agentic workflows the fixer had
    deliberately left alone. The "this file needs updating" annotation that follows
    then points a maintainer at compiler output, and applying it desyncs a committed
    lock from `gh aw compile`.

    Both invocations now exclude the generator-owned workflows via negated globs. One
    list (`GENERATED_WORKFLOWS`) drives all three sites: the fixer calls
    `isGeneratedWorkflow`, `cli.ts` derives its globs from
    `generatedWorkflowSkipGlobs()`, and `action.yml`, whose bash step cannot import
    either, has its hand-copied literals pinned to that function by a test. The
    negations are recursive, matching the positive glob they subtract from.

    `agentics-maintenance.yml` joins `*.lock.yml` in that set: gh-aw regenerates it
    unconditionally and it is not named `*.lock.yml`, so nothing was skipping it; it
    took 6 checkout-followed-by-setup violations and 12 `runs-on` rewrites on a file no
    human can fix.

    Negated globs rather than `ignorePatterns` in `.oxfmtrc.json`, because that config
    lives in the action's own directory rather than the repo being formatted and its
    patterns do not resolve against the working directory (verified: the lock was still
    rewritten).

    Observed on Khan/agent-settings#48, which is the first repo to run this action over
    a directory containing compiled agentic workflows.

## 3.3.0

### Minor Changes

-   f7a2657: Support inline `# fix-workflows-ignore` comments to opt a job or checkout step out of a fix.

    Some jobs legitimately need a specific runner (e.g. `runs-on: ubuntu-latest-m`) or intentionally skip the secure-network setup step, but the fixer previously rewrote them unconditionally. You can now annotate the exact line to opt out:

    -   On a `runs-on:` line (trailing, or as the job's leading comment) to skip the runs-on rewrite:
        `runs-on: ubuntu-latest-m # fix-workflows-ignore`
    -   On a checkout step (trailing on its `uses:` line, or as the step's leading comment) to skip inserting the setup step after it:
        `uses: actions/checkout@v4 # fix-workflows-ignore`

    An unscoped directive skips every rule for the annotated line; a scoped directive names which rules to skip (`# fix-workflows-ignore: runs-on`, `# fix-workflows-ignore: setup`, or both). `# lintignore` is accepted as an alias.

## 3.2.0

### Minor Changes

-   7cd1d10: Stop auto-committing fixed workflow files; instead print the commands the developer needs to run locally to fix lint violations and format their workflow files. Add a CLI entrypoint (`fix-workflows`) so devs can run the fixer via `npx`. Skip `*.lock.yml` files during processing.

## 3.1.0

### Minor Changes

-   d68907b: Make the 'runs-on' check more permissive, only checking a suffix instead of the whole line

## 3.0.1

### Patch Changes

-   71916cc: Exclude fixing up macos runners.

## 3.0.0

### Major Changes

-   8bd6e3c: Actually commit the changes if there were any from fix-workflows and only update stuff in .github/workflows.

## 2.0.0

### Major Changes

-   6db8098: Create the fix-workflows action.

## 1.0.0

### Major Changes

-   Initial release: validates and auto-fixes GitHub Actions workflow YAML files, then formats them with oxfmt.
