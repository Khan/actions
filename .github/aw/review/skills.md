<!--
Khan/actions-specific best-practice catalog for the PR-reviewer workflow. Injected at
runtime into the shared workflow's `skill-auditor` sub-agent (workflows/review/
review.md in this repo). That agent has no GitHub API access; it reads each entry's
file directly from its checked-out workspace on disk, so the paths here must match
real files. Keep this plain Markdown with no GitHub Actions template expressions.

This repo has no `.claude/skills/` catalog; its documented conventions live in two
READMEs. Audit against those only. A deviation is *blocking* only when it is itself
a correctness, security, or breaking-change issue; a merely non-idiomatic deviation
is a non-blocking suggestion. A convention not written in one of the files below is
not auditable; do not flag from memory or from other Khan repos' conventions.
-->

### release-and-versioning - `README.md` (repo root)

**Evaluate when:** anything under `actions/` changes, or `utils/run-publish.ts` /
`.github/workflows/release.yml` change. Covers the monorepo publish model (bare
tags per action), the changeset flow (a code change to a published action needs a
changeset; never hand-edit an action's `package.json` version or `CHANGELOG.md`),
and the dry-run testing convention for the publish pipeline.

### review-workflow-contract - `workflows/review/README.md`

**Evaluate when:** anything under `workflows/review/` changes. Covers the consumer
configuration contract (which files a consuming repo must provide, and that
`add-reviewer` lives only in the consumer's `config.md`), the `ROUTING` file format
and its last-match-wins tier semantics, the model/effort-per-role table, the
versioning policy (semver as behavior contract; the `pr-reviewer:version` marker),
and the policy that opt-in reviewers and lenses earn their `ROUTING` line through
the eval suite.
