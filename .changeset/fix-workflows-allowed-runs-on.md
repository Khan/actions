---
"fix-workflows": major
---

fix-workflows: check `runs-on` against an `allowed-runs-on` list instead of a regex

The `fix-runs-on` input (CLI: `--fix-runs-on`) is renamed `check-runs-on` (CLI:
`--check-runs-on`), since it no longer fixes anything. It is still off by default.
`fix-runs-on` stays as a deprecated alias: setting it to `true` still turns the
check on, and GitHub prints its deprecation warning.
When on, every `runs-on` must exactly match a value in the new
`allowed-runs-on` input (CLI: `--allowed-runs-on <value>`, repeatable). The input
is a YAML list; since an action input can only be a string, write it as a block
scalar with one `- <value>` entry per line, so each entry reads like the `runs-on`
it matches. Anything other than a list of non-empty strings fails the run. With no
values, the only allowed one is the toggle fix-workflows required before v4:

```
${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}
```

GitHub evaluates any `${{ … }}` in a `with:` value before the action runs, so a
toggle expression written there as-is arrives already resolved (as
`ephemeral-runner`, say). To list one, escape its opener, or pass a variable whose
value holds the expression text (GitHub doesn't evaluate a variable's value again):

```yaml
with:
    allowed-runs-on: |
        - ubuntu-latest
        - ${{ '${{' }} vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}
        - ${{ vars.FIX_WORKFLOWS_EXTRA_RUNS_ON }}
```

Matching is exact on the parsed YAML string: whether the workflow quotes the value
doesn't matter, but spacing inside an expression does.

A value not on the list is reported, not rewritten. fix-workflows annotates the
`runs-on` line with the allowed values and fails. The `USE_GITHUB_RUNNERS` /
`ephemeral-runner` regex and the autofix that wrapped plain runner names in it are
gone, along with the exported `fixRunsOn`. `checkRunsOn` now takes the allowed set,
and `processJob` / `checkJob` no longer take `shouldFixRunsOn`.

Unchanged: the checkout-followed-by-setup autofix, the `macos-` runner exemption,
`# fix-workflows-ignore` directives (`runs-on` scope included), and skipping
generated workflows.

**Migrating:** when bumping to v4, a repo with `fix-runs-on: true` renames it to
`check-runs-on: true` (until it does, the alias keeps the check on and warns). If
every `runs-on` is the `ubuntu-latest` toggle above, nothing else is needed;
otherwise set `allowed-runs-on` to every `runs-on` its workflows use. A repo with
`fix-runs-on: false` or no `fix-runs-on` is unaffected.
