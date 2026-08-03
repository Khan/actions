---
"review": minor
---

review: an onboarding playbook and a consumer-config checker for new consumer repos

Onboarding a repo (`Khan/kore-marketplace#3` is the current template) is five
hand-written config files, two local edits to the installed `review.md`, and a
handful of admin blockers only a repo admin can clear. Every mistake in that set
fails late and quietly, which is the problem both halves of this change address.

`lib/check-consumer-config.ts` validates an install through the **production**
parsers rather than a reimplementation: tiers, lenses, generated-file
classification and the budget come from `route()`, `ROUTING` from
`parseRoutingConfig`, `.gitattributes` from `parseGitattributesGenerated`. A
release that changes those semantics changes the checker's answers for free,
which is why it ships in `lib/` and is run from the tag the consumer pins (a
mismatch between the two is itself one of its warnings). It reports, as errors:
a missing or empty required config, a `${{ }}` expression inside a runtime
import or lens payload (gh-aw rejects those), `add-reviewer` defined in
`review.md` as well as `config.md` (the main workflow wins, silently discarding
the consumer's allowlist), a dropped `imports:` line, an empty
`allowed-team-reviewers` **in a repo that has a `.github/REVIEWERS` ownership
map**, and a missing `.lock.yml`. And as warnings: an unpinned or stale
`source:`, a live `observability:` block (both `GH_AW_OTEL_SENTRY_*` secrets are
hard-required while it is present, and a missing one kills the agent job at
startup), the shipped 1000-credit ceiling that `tier=high` runs have died at,
`ROUTING` parse warnings, inert lens payloads, a lock not marked
`linguist-generated`, an unmarked `agentics-maintenance.yml`, leftover `gh aw`
Copilot scaffolding, and reviewer config that does not itself route to `high`.

Two of those checks are deliberately shaped by what the router can actually do.
`.github/REVIEWERS` is its only source of team ownership, so in a repo without
one, Step 8 requests nobody no matter what `add-reviewer` allows: an empty
allowlist there is an accurate "this repo does not request reviewers" rather than
a dropped request, and it reports `reviewer-requests-inert` instead of failing.
Erroring would only get an inert team invented to satisfy the check. Separately,
`agentics-maintenance.yml` is `gh aw compile` output whose name is *not*
`*.lock.yml`, so the `.gitattributes` marker consumers were told to add misses it
and ~600 generated lines get line-reviewed until it gets its own.

Two views answer the question a tier map actually raises. `--files-from`
(`git ls-files | …`) prints the resolved tier of every tracked file with
per-tier samples and names the files no `tier=` rule matches at all, and
`--explain <path>` lists every matching rule in file order so last-match-wins
ordering is visible instead of inferred. That replaces the hand-verification
`kore-marketplace#3` did by importing the parser ad hoc.

`lib/frontmatter.ts` is the minimal structural frontmatter reader the checker
needs (indentation, `key:`, `- item`; no YAML dependency in `lib/`). One
behaviour is load-bearing: comment lines are dropped, so a commented-out block
reads as absent, which is exactly what disabling `observability:` means.

The judgment half is `.claude/skills/review-onboarding/SKILL.md`: what stays the
operator's call (the team allowlist, the `enable` roster and `re-review` mode,
every admin blocker), the preflight inventory that becomes `ci-tooling.md` and
`skills.md`, the two local edits and when each applies, how to derive risk prose
and tiers from the repo's own blast radius rather than another consumer's file
(the three known consumers' radii differ completely), and the PR-body structure
that separates what is generated from what was decided, including what the author
did not verify.

No change to the shipped review workflow: `review.md`, the dispatcher, and every
routing default are untouched.
