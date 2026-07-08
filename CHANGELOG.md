# fix-workflows

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
