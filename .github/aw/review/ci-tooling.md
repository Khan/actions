<!--
Khan/actions-specific list of issues the CI/tooling already catches, so the reviewer
doesn't flag them. Injected into the shared workflow (workflows/review/review.md in
this repo) at runtime. Keep this plain Markdown with no GitHub Actions template
expressions.

CI here is `node-ci.yml` (every PR) plus `check-for-changeset`. The reviewer's value
is what none of this sees: shell/template injection in action.yml files, publish/tag
integrity, gh-aw frontmatter security surfaces, and semver-as-behavior-contract
judgment (see risk-classification.md "What to verify").
-->

- **Formatting / lint**: `eslint` with `@khanacademy/eslint-config` +
  `eslint-plugin-prettier` (Prettier runs as a lint rule). Never comment on
  formatting, import order, or style eslint enforces.
- **Type errors**: `pnpm typecheck` (`tsc --noEmit`) and `pnpm build`
  (`tsc -p actions/tsconfig.json`). If it wouldn't typecheck or compile, CI fails.
- **Unit tests**: `pnpm test --run` (vitest) runs the full suite, including the
  reviewer lib tests under `workflows/review/lib/` and the eval smoke test.
- **Action wiring**: `utils/check-action-dependencies.ts` verifies intra-repo
  `uses:` references between actions; `node-ci.yml` also functionally smoke-tests
  `filter-files`, `get-changed-files`, and `json-args` against fixed inputs.
- **Changeset presence**: `check-for-changeset` fails a PR that changes published
  action code without a changeset (`.github/`, `utils`, and lint configs are
  excluded). Don't flag a *missing* changeset; DO review whether the changeset's
  semver level matches the change; CI can't judge that (see risk-classification.md).

### Don't raise these false alarms

- `action.yml` files are not covered by eslint/tsc; but don't flag YAML syntax or
  schema errors speculatively; a broken action.yml fails its smoke test or the
  consumer's first use. Focus on injection and logic, not syntax.
- `.lock.yml` workflow files are compiled output; don't review their contents
  line-by-line; verify the source `.md` changed with them (pairing check).
- Vitest tests here import from `node:` builtins and use `memfs`; that's the
  established pattern, not a smell.
