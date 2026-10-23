---
"fix-workflows": major
---

fix-workflows: fix `runs-on` against an allowlist in the calling repo instead of a regex

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
