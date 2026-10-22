---
"fix-workflows": major
---

fix-workflows: check `runs-on` against an allowlist in the calling repo instead of a regex

The `fix-runs-on` input (CLI: `--fix-runs-on`) is renamed `check-runs-on` (CLI:
`--check-runs-on`), since it no longer fixes anything. It is still off by default.
`fix-runs-on` stays as a deprecated alias: setting it to `true` still turns the
check on, and GitHub prints its deprecation warning.

When on, every `runs-on` must exactly match a value in the `allowed-runs-on` list of
the calling repo's config file, `.github/fix-workflows.yml` by default (override
with the new `config-file` input, or `--config-file` on the CLI). Entries are copied
as they appear in the workflows, `${{ … }}` and all:

```yaml
# .github/fix-workflows.yml
allowed-runs-on:
    - ubuntu-latest
    - ${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}
    - ${{ contains(fromJSON(vars.ARC_PREVIEW_USERS || '[]'), github.triggering_actor) && 'arc-foo' || 'ubuntu-latest' }}
```

It is a file rather than an action input because GitHub evaluates any `${{ … }}` in
a `with:` value before the action runs, so an expression passed inline would arrive
already resolved. Matching is exact on the parsed YAML string: whether a value is
quoted doesn't matter, but spacing inside an expression does. Unknown keys, and
entries that aren't non-empty strings, fail the run so a typo can't fall back to the
default list.

With no config file, or no `allowed-runs-on` entries, the only allowed value is the
toggle fix-workflows required before v4,
`${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}`,
and the run logs that it is using it. With the check on, a `config-file` given
explicitly must exist. With the check off, the config is neither read nor
validated, so a mistake in it can't fail the run; if it exists, the run warns
that it isn't being used.

A value not on the list is reported, not rewritten. fix-workflows annotates the
`runs-on` line (as committed, before the setup autofix shifts any lines) with the
allowed values and fails. The formatting and fix-instructions steps still run after
that failure (but not after a crash), so setup-step fixes in the same run still get
their hint. The `USE_GITHUB_RUNNERS` / `ephemeral-runner` regex and the autofix that
wrapped plain runner names in it are gone, along with the exported `fixRunsOn`.
`checkRunsOn` now takes the allowed set, and `processJob` / `checkJob` no longer
take `shouldFixRunsOn`.

`setup-action` now reaches the fixer's script through the environment instead of
being pasted into its source.

Unchanged: the checkout-followed-by-setup autofix, the `macos-` runner exemption,
`# fix-workflows-ignore` directives (`runs-on` scope included), and skipping
generated workflows.

**Migrating:** when bumping to v4, a repo with `fix-runs-on: true` renames it to
`check-runs-on: true` (until it does, the alias keeps the check on and warns). If
every `runs-on` is the `ubuntu-latest` toggle above, nothing else is needed;
otherwise add `.github/fix-workflows.yml` listing every `runs-on` its workflows use.
A repo with `fix-runs-on: false` or no `fix-runs-on` is unaffected.
