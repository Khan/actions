<!--
Khan/actions-specific risk-tier file patterns AND the deep-checks for the PR-reviewer
workflow. Injected into the shared workflow (workflows/review/review.md in this repo)
at runtime. Keep this plain Markdown with no GitHub Actions template expressions;
gh-aw rejects those inside imported files.

The blast radius in this repo is supply-chain shaped: the composite actions under
`actions/` and the shared agentic workflows under `workflows/` execute inside OTHER
Khan repos' CI, with those repos' tokens and secrets, pinned by release tag. The most
severe changes here don't break this repo; they break or compromise every consumer
on its next version bump.
-->

### Generated files are automatically Trivial

- `pnpm-lock.yaml` (marked `linguist-generated` in `.gitattributes`).
- `.github/workflows/*.lock.yml`; compiled by `gh aw compile` from the sibling
  `.md` agentic workflow. Don't deep-review compiled lock contents; instead verify
  the pairing (see "What to verify"). A `.lock.yml` edited **without** a matching
  `.md` change is a red flag; classify by the manual edit.
- `actions/*/index.js` bundles produced by the build. A compiled bundle edited
  without a source change is a red flag.

### High Risk

Runs in consuming repos' CI (with their credentials), or controls what gets
published to them:

- **Shipped composite actions**: `actions/*/action.yml` and the code they invoke.
  These execute in webapp/frontend/perseus/etc. CI with those repos' `GITHUB_TOKEN`
  (and sometimes admin/bot tokens passed as inputs). Injection via untrusted
  interpolation, a new outbound network call, loosened token handling, or a subtly
  wrong filter (e.g. `filter-files` matching too much/little gates other repos' CI
  decisions) all propagate on the next release.
- **The publish pipeline**: `utils/run-publish.ts`, `utils/check-action-dependencies.ts`,
  `.github/workflows/release.yml`. Cuts and force-moves the release tags every
  consumer pins (`<action>-vX`, `review-vX`). A bug can publish the wrong tree to a
  tag or rewrite a moving major tag out from under consumers.
- **This repo's workflow files**: `.github/workflows/**`: `permissions:` blocks,
  secret usage, event triggers, action pinning. The compiled agentic locks
  (`*.lock.yml`) are generated, but their frontmatter sources (`review.md` here and
  in `workflows/review/`) define real permission/secret/network surfaces.
- **The shared PR reviewer**: `workflows/review/review.md` (the prompt IS the
  reviewer's behavior in every consuming repo; its frontmatter carries security
  surfaces: `safe-outputs` caps, `allowed-domains`, `network.allowed`, `roles`,
  `permissions`) and `workflows/review/lib/**` (the deterministic enforcement
  layer: finding schema, change-provenance gate, verdict computation,
  investigation cap, routing parser; a bug here silently changes what gets
  blocked or posted on every consumer PR).

### Medium Risk

- **The eval suite**: `workflows/review/eval/*.ts` (judge, gates, metrics,
  runner). Dev-only, but it decides which reviewers/lenses "earn their line" in
  consumer ROUTING files; a wrong judge or gate corrupts those decisions.
- **Build/lint/type configuration**: `config/`, `types/`, `tsconfig.json`,
  `.eslintrc.js`, `pnpm-workspace.yaml`: shapes the compiled output of shipped
  actions.
- **Staged workflows**: `.github-staging/**` (not yet active, but will be
  promoted verbatim).

### Low Risk

- Test files (`**/*.test.ts`) and eval corpus fixtures
  (`workflows/review/eval/corpus/**`).
- Internal refactors with test coverage; logging/output-formatting tweaks in
  utils.

### Trivial Risk

- Generated files (above); Markdown docs and READMEs (except
  `workflows/review/review.md`, which is executable prompt, not docs);
  `.changeset/*.md` entries; comments/naming/formatting-only changes.

### Disambiguation

- Highest applicable level wins.
- **Diff direction matters**: read the hunk, not just the path. In gh-aw
  frontmatter, widening (`allowed-domains` additions, a raised safe-output `max`,
  a new secret, a permission upgrade, loosening `roles:` or the fork guard) is the
  risky direction; tightening is usually safe. In an action's `action.yml`, a new
  input interpolated into a `run:` block is riskier than a removed one.
- If the PR description justifies a risky change (evaluated against the eval
  suite, security-reviewed frontmatter, a documented rollback), you may lower the
  risk one tier but note the justification.

---

## What to verify (CI cannot catch these)

CI here runs eslint/prettier, `tsc`, vitest, a build, changeset presence, and smoke
tests of a few actions. It has no actionlint/shellcheck, no security scanning, and
no check that compiled artifacts match their sources. Findings here are candidates
for **blocking** comments:

**Template injection in composite actions.** Any dollar-brace GitHub Actions
expression over `inputs.*`, `github.event.*`, or another attacker-influenceable
value, interpolated directly into a `run:` script or `github-script` body, is a
command/JS injection in the CONSUMING repo's CI. Require env-var indirection
(`env:` + `"$VAR"`) for untrusted values. Same check applies to workflow files in
this repo. (Spelled without the literal expression syntax here because gh-aw
rejects runtime imports containing it; see this file's header.)

**Action pinning.** Every new or changed `uses:` of a third-party action must be
pinned to a full commit SHA (with a version comment), not a tag or branch.
Intra-repo `uses:` references are rewritten at publish; verify a new one is known
to `utils/check-action-dependencies.ts` conventions.

**Publish/tag integrity.** For `utils/run-publish.ts` and `release.yml` changes:
verify the tag-rewriting logic still publishes exactly the action's subtree, that
moving major tags advance only on release, and that a dry-run path stays dry.

**gh-aw frontmatter security surfaces.** For `review.md` (shared or installed):
treat a widened `allowed-domains` list, a raised safe-output `max`, a new
`network.allowed` entry, a new secret reference, added `permissions:`, or a
weakened trigger guard (`if:` fork/branch exclusions, `roles:`) as a security
regression needing explicit justification in the PR description. This repo is
public: the fork-PR guard in the installed `.github/workflows/review.md` must not
be loosened.

**Compiled-artifact pairing.** A change to an agentic `.md` workflow must ship the
recompiled `.lock.yml` (and vice versa); a change to reviewer `lib/` code that the
prompt's pinned `gh-aw-review-lib` checkout ref doesn't cover only takes effect on
the next release; flag a PR that claims immediate effect for a lib change without
a release/pin bump.

**Reviewer behavior contract.** Semver on the `review` package is a behavior
contract (see `workflows/review/README.md`): a release that changes reviewer
behavior must bump the major version. Flag a behavior-changing `workflows/review/`
change whose changeset is patch/minor, and any change to `lib/finding-schema.ts`'s
`FINDING_SCHEMA_VERSION` semantics without the version bump.
