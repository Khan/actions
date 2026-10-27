# fix-workflows

## 4.0.1

### Patch Changes

-   7fc40d7: fix-workflows: don't write `${{ … }}` in an input description

    The `config-file` input's description spelled out the default allowlist entry,
    `${{ vars.USE_GITHUB_RUNNERS == … }}`. The runner parses `${{` in an input's
    description as an expression when it loads the action, and `vars` isn't one of
    the contexts available there, so every job using v4.0.0 failed at "Set up job"
    with "Unrecognized named-value: 'vars'". The description now states the default
    in words, as the `USE_GITHUB_RUNNERS` toggle that picks `ubuntu-latest` or
    `ephemeral-runner`. A repo-wide test now fails if any action's description
    contains `${{`, whatever context it uses, since which contexts each description
    field allows isn't documented.

## 4.0.0

### Major Changes

-   484735d: fix-workflows: fix `runs-on` against an allowlist in the calling repo instead of a regex

    With `fix-runs-on: true` (CLI: `--fix-runs-on`), still off by default, every
    `runs-on` must exactly match a value in the `allowed-runs-on` list of the calling
    repo's config file, `.github/fix-workflows.yml` by default (override with the new
    `config-file` input, or `--config-file` on the CLI). Entries are copied as they
    appear in the workflows, `${{ … }}` and all:

    ```yaml
    # .github/fix-workflows.yml
    allowed-runs-on:
        - ubuntu-latest
        - ${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}
        - ${{ contains(fromJSON(vars.ARC_PREVIEW_USERS || '[]'), github.triggering_actor) && 'arc-foo' || 'ubuntu-latest' }}
    ```

    A value not on the list is replaced with the list's first entry, so one run (or
    one local CLI run) brings a whole repo into line. List the runner you want unlisted
    jobs moved to first. Before v4, the fix kept each job's runner name and wrapped it
    in the `USE_GITHUB_RUNNERS` / `ephemeral-runner` toggle (`ubuntu-latest-l` became
    the `ubuntu-latest-l` toggle); now every disallowed value gets the same
    replacement, and the regex behind the old rule is gone.

    It is a file rather than an action input because GitHub evaluates any `${{ … }}` in
    a `with:` value before the action runs, so an expression passed inline would arrive
    already resolved. Matching is exact on the parsed YAML string: whether a value is
    quoted doesn't matter, but spacing inside an expression does. Unknown keys, and
    entries that aren't non-empty strings, fail the run before any file is changed, so
    a typo can't fall back to the default list.

    With no config file, or no `allowed-runs-on` entries, the only allowed value, and
    the replacement, is the `ubuntu-latest` form of the toggle,
    `${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}`.
    The run warns, with a count, when that default rewrote anything, and otherwise just
    logs that it used it. The pre-v4 regex accepted that toggle with any runner name, so
    a repo that uses it with another runner (such as `'ubuntu-latest-l'`) has to list
    that form in the config. A `config-file` given explicitly must exist.
    With `fix-runs-on` off, the config is neither read nor validated, so a mistake in it
    can't fail the run; if it exists, the run warns that it isn't being used.

    Only string `runs-on` values are checked. A label array (`[self-hosted, linux]`)
    or a `group:` map is left alone, as before.

    `fixRunsOn` and `checkRunsOn` now take the allowed set (and `fixRunsOn` the
    replacement). `processJob` takes `runsOnPolicy: {allowed, replacement, onFix?}` in
    place of `shouldFixRunsOn`, and `checkJob` no longer takes `shouldFixRunsOn`.

    `setup-action` now reaches the fixer's script through the environment instead of
    being pasted into its source. The CLI now rejects an unknown argument or a flag
    missing its value instead of ignoring it.

    Unchanged: the checkout-followed-by-setup autofix, the `macos-` runner exemption,
    `# fix-workflows-ignore` directives (`runs-on` scope included), and skipping
    generated workflows.

    **Migrating:** a repo with `fix-runs-on: true` keeps it. If every `runs-on` is the
    `ubuntu-latest` toggle above, nothing else is needed. Otherwise add
    `.github/fix-workflows.yml` listing every `runs-on` its workflows use, with the one
    to fix others to first; without it, the next run rewrites every other value
    (including other runner names in the toggle) to the `ubuntu-latest` toggle. A repo
    with `fix-runs-on: false` or no `fix-runs-on` is unaffected.

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
