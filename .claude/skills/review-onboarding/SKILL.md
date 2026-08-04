---
name: review-onboarding
description: Onboard a repo onto Khan's shared AI PR reviewer (`Khan/actions` `workflows/review`): install the workflow at a pinned tag, author the five consumer config files against that repo's own blast radius, validate the install with the consumer-config checker, and open the disclosure PR. Use when a repo should start getting automated PR reviews, when refreshing or auditing an existing install, or when a review is misbehaving in a way that smells like config. Invoke with the target repo.
---

# Onboard a repo onto the shared PR reviewer

Produce **one PR** that turns the shared reviewer on in a consuming repo, with
config written for that repo rather than copied from another one.

The template is [`Khan/kore-marketplace#3`](https://github.com/Khan/kore-marketplace/pull/3);
the contract it satisfies is `workflows/review/README.md` in `Khan/actions`
(sections *Consumer configuration*, *The `ROUTING` file*, *Required secrets /
variables*). Read those before writing anything; this skill choreographs the
work and carries the judgment calls, it does not restate the format spec.

## What stays human

Confirm all of these with the operator before writing config. Do not infer them
from the repo and do not carry them over from another consumer:

1. **The `add-reviewer` team allowlist**: which team owns this repo — or whether any
   does. "No reviewer requests" is a legitimate answer, and for a repo with no
   single owning team it is usually the right one. Do not invent an inert team to
   fill the field: leave `allowed-team-reviewers` empty, add no `.github/REVIEWERS`,
   and the checker reports `reviewer-requests-inert` rather than an error. Ownership
   comes from `.github/REVIEWERS` and nowhere else, so without it Step 8 requests
   nobody whatever the allowlist says — the two are inert alone and only work
   together.
2. **The `enable` roster and `re-review` mode.** Policy is that an opt-in
   reviewer earns its line through the eval suite. The defensible default is to
   mirror an existing consumer's eval-justified set and say in the PR that that
   is what you did; anything else is the operator's call.
3. **Anything that needs a repo admin or a secret value**: adding
   `ANTHROPIC_API_KEY`, granting a team repo access, creating the opt-out label.
   Inventory them, put them in the PR body as ordered blockers, and say which one
   is hard.

   **Never handle the key's value.** Do not read it out of Keeper, another repo,
   the environment, or the operator's chat, and never echo it into a command you
   run. Print the command for the operator to run themselves and stop:

   ```sh
   gh secret set ANTHROPIC_API_KEY -R <owner>/<repo>     # prompts for the value
   gh api -X PUT /orgs/Khan/teams/<team>/repos/Khan/<repo> -f permission=push
   gh label create skip-ai-review -R <owner>/<repo> -d "Opt this PR out of AI review"
   ```

   Afterwards confirm by name only (`gh secret list -R <repo>`), never by value.

   **You cannot copy the key from a repo that already has it, so do not try.**
   Actions secrets are write-only: values are encrypted against the repo's public
   key on write and decrypted only into a runner at job time. `GET
   /repos/{owner}/{repo}/actions/secrets/{name}` returns the name and timestamps
   with no value field, there is no `gh secret get`, and `gh secret list` is names
   only. "Pull it from webapp" is not a step that exists.

   **Prefer an org secret over a per-repo paste.** A repo-level
   `ANTHROPIC_API_KEY` makes every onboarding wait on someone handling key
   material. An organisation secret with *selected repositories* visibility turns
   that into an admin adding one repo to a list, with no value moving and nothing
   for this skill to touch. Check what the target repo can already see:

   ```sh
   gh api /repos/<owner>/<repo>/actions/organization-secrets --jq '.secrets[].name'
   ```

   If `ANTHROPIC_API_KEY` is there, it is already provisioned and there is no
   blocker. If an org secret exists but this repo is not in its selected list,
   the blocker is "add this repo to it" (org-admin, no key material) rather than
   `gh secret set`, and the PR body should say so. Raise the org-secret route with
   the operator when a repo-level paste is the only option left.

You *do* own the risk prose, the tiers, and the CI-tooling list, but derive them
from **this** repo (its CI workflows, its test setup, its docs, its actual blast
radius), never from another repo's file. A `ci-tooling.md` that names a lint rule
this repo doesn't run teaches the reviewer to stay silent about real defects.

## Step 0: preflight

Gather, and record for the PR body:

- The `gh aw` extension, and its version (the compiled lock is version-specific,
  and the PR body should name the version that produced it):

  ```sh
  gh extension install github/gh-aw   # or: gh extension upgrade gh-aw
  gh aw version
  ```
- The tag to pin: the newest `review-v<major>.<minor>.<patch>` in `Khan/actions`
  (`git tag --list 'review-v*' | sort -V | tail`). Pin the full semver, not the
  moving major, so the install is reproducible.
- Secrets: `gh secret list -R <repo>` plus
  `gh api /repos/<owner>/<repo>/actions/organization-secrets --jq '.secrets[].name'`.
  You need `ANTHROPIC_API_KEY` (repo-level at Khan) and `KHAN_ACTIONS_BOT_TOKEN`
  (usually an org secret). `GH_AW_OTEL_SENTRY_ENDPOINT` /
  `GH_AW_OTEL_SENTRY_AUTHORIZATION` decide Step 2's observability edit.
- Public or private (`gh repo view --json isPrivate`), which decides the fork guard.
- What CI already exists: every workflow in `.github/workflows/`, the lint/format
  config, the test runner and whether a suite actually runs on PRs. This *is*
  `ci-tooling.md`; read it now, not later.
- Ownership and convention surfaces: `.github/REVIEWERS` (Gerald),
  `.github/NOTIFIED`, `.claude/skills/`, `AGENTS.md`/`CLAUDE.md`, `REVIEW.md`,
  READMEs that state contracts. These are the raw material for `skills.md`.
- **Write down the blast radius in one sentence**: what breaks, and for whom,
  when code in this repo is wrong. Every tier and deep-check decision below
  descends from it. The three known answers differ completely, which is the point:
  webapp = product runtime for learners; `Khan/actions` = CI supply chain running
  in other repos with their tokens; `kore-marketplace` = agent supply chain
  running on engineers' laptops as them.

## Step 1: install the workflow

Work on a branch in the consumer repo from the start; never on its default
branch.

```sh
cd <consumer-repo> && git switch -c enable-shared-pr-reviewer
gh aw add Khan/actions/workflows/review/review.md@review-v<major>.<minor>.<patch>
gh aw compile
```

This writes `.github/workflows/review.md` (verbatim from the tag, with a
`source:` field), compiles `review.lock.yml`, and may also emit
`.github/aw/actions-lock.json` and `agentics-maintenance.yml` (gh-aw scaffolding
for `cache-memory`; keep it, and explain it in the PR body). Commit all of them.

If `gh aw add` fails with *failed to inspect repository initialization state*, look
for a zero-byte non-directory sitting where it wants a directory (`.vscode`,
`.idea`): some sandbox setups create read-only placeholder files to block those
paths. Do the install in a clean `git worktree` rather than deleting them.

Three cleanups:

- **Remove the Copilot scaffolding** `gh aw` writes on first init in a repo
  (`.github/mcp.json`, `.github/agents/`, `.github/skills/`,
  `.github/workflows/copilot-setup-steps.yml`) unless the repo actually uses
  Copilot Agent. No Khan consumer carries it.
- **`.gitattributes`**: mark **both** generated workflows, or the reviewer
  line-reviews its own compiler output:

  ```
  .github/workflows/*.lock.yml linguist-generated=true merge=ours
  .github/workflows/agentics-maintenance.yml linguist-generated=true merge=ours
  ```

  The second is easy to miss because its name is not `*.lock.yml`, but it is
  `gh aw compile` output all the same (~600 lines, regenerated unconditionally — 
  deleting it does not stick). Do **not** mark `review.md`: that is the
  hand-editable source your Step 2 local edits live in. The checker flags either
  omission. If the repo's `.gitattributes` has a machine-managed block (a generator
  that owns part of the file, as in `Khan/agent-settings`), put these lines
  **outside** it and verify they round-trip before trusting them.
- **Normalise `source:` to the tag.** `gh aw add ...@review-v1.11.0` records the
  *resolved commit SHA*, not the tag you asked for. Rewrite it to
  `@review-v<major>.<minor>.<patch>`; that is what webapp and `Khan/actions` carry,
  it is what makes the pin legible in a diff, and the checker compares against it
  (a SHA reads as `source-ref-mismatch`).

Never hand-edit `review.lock.yml`; regenerate with `gh aw compile`.

`gh aw compile` may also stop with *safe update mode detected unapproved changes*,
listing the secrets the workflow references. Review each one before passing
`--approve`, and put that review in the PR body — Step 7 has a section for it.

## Step 2: local edits to the installed `review.md`

`gh aw update` preserves local edits via 3-way merge, so these survive upgrades.
Label each one with a `<REPO> LOCAL OVERRIDE:` comment saying *why*, so the next
reader and the next merge conflict both have the reasoning.

| Edit | When | Why |
| --- | --- | --- |
| `max-ai-credits: 2500` **and** the `REVIEW_MAX_AI_CREDITS: "2500"` env mirror | Any repo where paths route to `tier=high` | The shipped 1000 sits below a full-depth full-roster run: observed runs died at 1001-1024 metered credits *after* computing a verdict but before posting it. A ceiling, not a spend. |
| Comment out the `observability:` block | No `GH_AW_OTEL_SENTRY_*` secrets | While the block is present both secrets are hard-required: a missing one makes the agent job die at startup rather than skip trace export. Restore verbatim once they exist. |
| Fork guard in the `if:` (`head.repo.full_name == github.repository`) | Public repos | The shipped `roles: all` disables gh-aw's own actor gate, so this `if:` is what keeps untrusted fork heads from triggering runs. Private repos need nothing. |
| `REVIEW_BOT_LOGIN` | Only if the repo posts reviews under its own GitHub App | Getting it wrong files the bot's own threads as human ones, which puts their lines in `skipLines` and **drops** fresh findings there. |

Do **not** add `add-reviewer` here. gh-aw lets the main workflow override an
imported safe output of the same type, so defining it here silently discards the
consumer's team allowlist.

## Step 3: the five config files (`.github/aw/review/`)

Author all five. Four are required; `ROUTING` is nominally optional but a repo
without it gets no specialist lens, a floored budget, and a missing-config note
on every review. Keep every file plain Markdown with **no `${{ }}` expressions**
(gh-aw rejects those inside imports). `config.md` is the sole exception, because
it is a frontmatter import and carries the bot token.

Head each file with an HTML comment saying which repo it belongs to, which
sub-agent consumes it, and when it is read (compile vs. runtime). That comment is
how the next person knows what editing it changes.

- **`config.md`**: frontmatter only; the body is ignored. Owns `add-reviewer`:
  `allowed-team-reviewers` (bare team slugs) and
  `github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}` (the default
  `GITHUB_TOKEN` cannot request an org team). Note in the comment whether Gerald
  also requests reviewers here, and that GitHub silently drops a team reviewer
  request when the team lacks repo access. Still required even when this repo
  requests no reviewers (see *What stays human*): it is the compile-time
  `imports:` target, so `gh aw compile` fails without it. In that case leave the
  allowlist empty and say in the comment *why* requests are off and what would turn
  them on, because nothing else on the PR makes that visible.
- **`risk-classification.md`**: the model-facing prose about file *contents*.
  Assign High/Medium/Low/Trivial using real paths from this repo, then add a
  "what to verify that CI cannot" section. This is where the blast-radius
  sentence pays off; write the deep-checks that follow from it (for
  `kore-marketplace`: pre-authorization creep in `allowed-tools:`, shell
  injection in plugin scripts, credential flow, manifest agreement). Also state
  which files are generated, and that a generated file edited *without* its
  source changing is a red flag.
- **`ci-tooling.md`**: what CI already catches, so the reviewer doesn't spend
  comments on it; every claim must name a real command or job. Then a
  "don't raise these false alarms" section for this repo's established patterns.
  **Invert it when the repo has no CI**: say so explicitly and set the bar for
  what is worth a comment anyway (don't nitpick unenforced formatting; don't
  treat missing tests as a finding in a repo with no test infrastructure).
- **`skills.md`**: the catalog `skill-auditor` audits against. Each entry is a
  `### <name> - <path>` heading (path in backticks) followed by an
  **Evaluate when:** clause. The agent reads each path off its checked-out
  workspace, so every path must exist. A repo with no `.claude/skills/` catalog points
  at the READMEs that actually state its conventions. Say the quiet part in the
  header comment: a convention not written in one of these files is not
  auditable, so don't flag from memory or from another Khan repo.
- **`ROUTING`**: see Step 4.

## Step 4: `ROUTING`

Format spec is in the README; the judgment is in the ordering and the tiers.
`ROUTING` is the only config file whose effect is fully mechanical, so it is the
only one you can be *sure* about before the first PR. Get it right by derivation
and then by checking, not by analogy to another repo's file.

**Derive the tiers.** Enumerate what the repo actually contains
(`git ls-files | cut -d/ -f1 | sort -u` for the top level, then descend into
anything large), and for each group ask the Step 0 blast-radius question: *when
this file is wrong, who is harmed and how far does it reach?* Ship code that
executes elsewhere (in another repo's CI, on an engineer's machine, in
production) is `high`. Repo-local dev surfaces (tests, fixtures, eval harnesses)
are `low`. Docs are `trivial`. Anything that decides what gets published, or that
steers an agent, is `high` regardless of file extension.

Then write the rules in this order:

1. **Broad rules first, exceptions after.** Last matching rule wins
   (gitignore-style), so `**/*.md tier=trivial` goes above the re-raises.
2. **Re-raise executable prose.** `SKILL.md`, agentic-workflow `.md`, and prompt
   imports are programs that happen to be Markdown; the broad docs rule would
   route them `trivial`. Then drop READMEs and changelogs back down.
3. **Tier the reviewer's own config `high`** (`.github/aw/review/**`,
   `.github/workflows/*.md`). A PR that tampers with the reviewer must not be
   reviewed at the trivial or default budget. The checker warns when it isn't.
4. **`direction-dependent`** (only ever with `tier=`) for a path whose risk
   depends on which way the diff moves, such as a permissions or allowlist file
   where widening is dangerous and tightening is not. The router then asks rather
   than guesses, and it applies only when its own rule is the winning one for the
   path. Use it sparingly; it costs a model call.
5. **`enable` and `re-review`** are the operator's decisions from *What stays
   human*. Whatever you write, justify it in a comment above the line.

**The glob dialect has one real trap.** A pattern with **no `/` matches the
basename in any directory**: `README.md` also matches `docs/sub/README.md`.
Prefix `/` to anchor to the repo root (`/README.md`). Otherwise: `**` crosses
directories, `*` and `?` never do (`plugins/*/skills/*/SKILL.md` will not match
`plugins/a/b/c/SKILL.md`), and a trailing `/` matches a directory and everything
beneath it.

**Then check it, per path, until nothing surprises you.** A malformed line is
skipped with a warning and a typo'd pattern parses perfectly while routing
nothing, so neither is visible in the file itself:

- `--files-from` gives the resolved tier of every tracked file, names every file
  no rule matched (those fall to the router's default `low`), and names every
  pattern that matches nothing at all.
- `--explain <path>` lists every rule matching that path in file order, so you
  can see which one won instead of assuming.

Run both before the PR, and treat "a file I expected to be `high` came out
`low`" as a rule bug, not a rounding error.

**Lenses are opt-in and mostly won't apply.** The eleven specialist lenses target
webapp's backend domains. Enable one only when a real path here maps to it; a
lens with no matching path is inert, and a payload with no routing rule is
silently inert (the checker warns). "None maps here, and why" is a legitimate
outcome to record in the header comment.

## Step 5: validate

Run the checker **from a checkout of the tag the repo pins**, so the semantics
you validate are the ones its reviews will run. Get one (skip the clone if you
are already working inside a `Khan/actions` checkout at that tag):

```sh
git clone --depth 1 --branch review-v<major>.<minor>.<patch> \
    https://github.com/Khan/actions.git /tmp/review-checker
cd /tmp/review-checker

# Stage the new config first: git ls-files lists TRACKED files, so an unstaged
# .github/aw/review/ reads as absent and every rule pointing at it is reported as
# matching nothing. `git add -A` in the consumer, or add the paths explicitly.
git -C <consumer> ls-files | npx -y tsx workflows/review/lib/check-consumer-config.ts \
    --repo <consumer> --files-from -

# and, for any path whose tier you are unsure about:
npx -y tsx workflows/review/lib/check-consumer-config.ts \
    --repo <consumer> --explain <path>
```

Pass `<consumer>` as an absolute path, since the checker runs from the clone.

It asks the real router, `ROUTING` parser, and `.gitattributes` parser (not a
reimplementation), so it catches the whole class of mistakes that otherwise
surface as a red run on someone's PR: a missing runtime import, a `${{ }}` in an
import, `add-reviewer` defined in both places, a dropped `imports:` line, an
empty team allowlist, a missing lock, an unmarked lock, a live `observability:`
block, the default credit ceiling, `ROUTING` parse warnings, inert lens payloads,
under-tiered reviewer config, and every tracked file's resolved tier.

Errors must be zero. Every remaining warning is either fixed or **explained in
the PR body**; `--explain` output is the evidence that a tier is deliberate.

## Step 6: optional surfaces

Decide each explicitly and record the decision:

- **`lenses/<lens>.md` payloads**: only for lenses `ROUTING` actually spawns.
- **`REVIEW.md` contracts**: per-directory calibration of Important vs. nit,
  read from the PR head at run time. Cheap to add later.
- **`.github/NOTIFIED`**: honoured automatically if present; approval-time
  pings, not on-touch.
- **Thumbs sweep and live counters**: two small scheduled plain-Actions
  workflows that turn on the production feedback signal (see the README).
  Reasonable to defer to a follow-up PR; say so rather than leaving it silent.
- **The opt-out label** (`skip-ai-review`): the `if:` guard works without it,
  but the label must exist to be selectable in the UI.

## Step 7: the PR

The install is mostly generated files and mostly-invisible policy, so the body
carries the review. Reuse `kore-marketplace#3`'s structure:

1. **What this turns on**, in three sentences, with the pinned version and a link
   to the shared README.
2. **What's generated and what to actually read.** An install PR is a few
   thousand lines, and all but a few hundred are compiler output. A reviewer who
   is not told which is which either reviews the wrong file or skims the whole
   thing, so make the split explicit rather than implied.

   Give the generated files as a table — file, line count, what regenerates it,
   and that it must never be hand-edited:

   | File | Lines | Regenerated by |
   | --- | --- | --- |
   | `.github/workflows/review.md` | ~3000 | `gh aw update` (verbatim from the tag, except the local edits below) |
   | `.github/workflows/review.lock.yml` | ~1900 | `gh aw compile` — the workflow GitHub actually runs |
   | `.github/workflows/agentics-maintenance.yml` | ~600 | `gh aw compile` — gh-aw housekeeping |
   | `.github/aw/actions-lock.json` | ~15 | `gh aw compile` — third-party action SHA pins |

   Then say, in a sentence, **what is left**: the five files under
   `.github/aw/review/` plus the `.gitattributes` lines and the local edits to
   `review.md`. That is the human-written part and the whole of the review. Name
   where the judgment is concentrated (the tier map, the risk prose and its
   deep-checks, each local edit) and point at the section of the body that argues
   for each.

   Two things worth telling the reviewer explicitly, because both are
   counter-intuitive:

   - The `.gitattributes` markers make GitHub **collapse** the generated files in
     the diff, so "the diff looks small" is the marker working, not a small change.
   - `.github/aw/actions-lock.json` is generated but is deliberately **not** marked
     generated, and it is worth reading: it pins which third-party action code runs
     in this repo's CI.
3. **What's copied from an existing consumer**: name it, and say why each copied
   decision transfers (the roster, the re-review mode, the credit ceiling).
4. **What's specific to this repo**: the blast-radius sentence, then the tier
   and deep-check decisions that follow from it. This is the section a reviewer
   should actually argue with.
5. **Security review note**: which secrets the workflow references (and that
   they come from the pinned upstream, not from this PR), that the
   `permissions:` block is read-only with writes going through sanitized safe
   outputs, and whether third-party actions in the lock are SHA-pinned.
6. **What you did not verify.** State it plainly: e.g. reading the upstream
   frontmatter but not all ~3,400 lines of prompt body. A reviewer who knows
   where the gap is can cover it.
7. **Before this works**: ordered blockers, naming which are hard (a missing
   `ANTHROPIC_API_KEY` fails the agent job immediately; a team without repo
   access makes `add-reviewer` a no-op but breaks nothing else).

Apply the opt-out label to this PR only if you don't want it self-reviewed;
otherwise the PR is the install's own first test.

Commit everything the install touched in one commit, write the body to a file
rather than fighting shell quoting, and open the PR:

```sh
git add .github .gitattributes README.md
git commit -m "Enable the Khan shared AI PR reviewer"
git push -u origin enable-shared-pr-reviewer
gh pr create --title "Enable the Khan shared AI PR reviewer" --body-file <body.md>
```

Then report the PR URL back. Do not merge it: the install's blockers are the
operator's to clear, and the PR is also the first live test of the reviewer.

## Step 8: confirm the first run

Watch the run (`gh run watch`, then the job summary and the posted review):

- Did it post a verdict, and does the risks/patterns comment carry the
  `<!-- pr-reviewer:version v=review-v… -->` marker? That marker is the
  attribution and rollback handle.
- Metered credits vs. the cap. A run that dies at the ceiling emits nothing.
- Failure triage: `Runtime import file not found` → a missing required config;
  agent job dead at startup → a missing secret (or the live `observability:`
  block); reviewer request silently absent → team lacks repo access; verdict but
  no comments → check the change-provenance gate in the run artifact before
  assuming the reviewer had nothing to say.

Then hand back: the PR link, the first run's verdict and cost, the outstanding
admin blockers, and the deferred items from Step 6.

Two follow-ups worth naming, not doing now: pricing a cheaper `re-review` mode
for this repo, and (for an architecture-class question, or before graduating a
repo to automatic mode) a seeded-defect live trial
(`.claude/skills/review-trial/SKILL.md`).

## Updating an existing install

A repo that is already on the reviewer needs a different, much shorter flow: not
authoring config, but moving a pin and checking what moved with it. Use this when
bumping to a newer `review-v*`, and also as the audit path when a review is
misbehaving in a way that smells like config.

**Do it as its own PR**, never folded into unrelated work: the whole point is that
the diff shows what a version bump changed.

```sh
cd <consumer-repo> && git switch -c bump-shared-pr-reviewer
gh aw update                     # 3-way merge; preserves the Step 2 local edits
gh aw compile                    # --approve only after reviewing any new secret
```

Then, in this order, because each step can invalidate the next:

1. **Read the release notes between the two versions**
   (`workflows/review/CHANGELOG.md` in `Khan/actions`, from the pinned version to
   the new one). Semver is a behaviour contract here: a minor can change what gets
   reviewed, what a label means, or what the router does with an existing `ROUTING`
   line. This is the step that tells you what to look for in the rest.
2. **Confirm every local edit survived the merge.** `gh aw update` preserves them,
   but "preserved" is not "still correct", and a conflict resolved badly is silent.
   Diff the installed `review.md` against the new tag's copy and check that what
   differs is exactly the Step 2 list and nothing else:

   ```sh
   git -C <consumer> diff HEAD~1 -- .github/workflows/review.md
   ```

   Check `max-ai-credits` **and** its `REVIEW_MAX_AI_CREDITS` mirror together (a
   merge can update one), that a commented-out `observability:` block is still
   commented out, that a public repo's fork guard is still in the `if:`, and that
   `source:` names the new tag rather than a resolved SHA.
3. **Look for newly generated files.** A new gh-aw version can start emitting a
   file the old one did not, and an unmarked generated file gets line-reviewed.
   Check `git status` for additions under `.github/`, and that `.gitattributes`
   covers each one (this is exactly how `agentics-maintenance.yml` arrived).
4. **Re-run the checker from the NEW tag**, not the old one — the semantics you are
   validating are the ones the repo is about to run. Compare its tier preview to
   the previous run: a routing-semantics change can move files between tiers
   without any `ROUTING` edit, and that is worth knowing before the next review
   rather than after.
5. **Re-read `ci-tooling.md` and `skills.md` against the repo as it is now.** These
   rot silently and nothing else checks them: a lint rule the repo dropped, a test
   command that changed, a skill path that moved or was deleted. A `skills.md`
   entry pointing at a file that no longer exists degrades the `skill-auditor` on
   every review. This is the highest-value part of an audit and the easiest to skip.

The PR body is much smaller than an install's, but keep the same shape: old
version → new version, what the changelog says changed, that the local edits are
unchanged (or which moved and why), the checker's before/after tier counts, and
anything you did not verify. If the tier counts or enabled roster changed, say so
explicitly — that is the part a reviewer cannot see from the diff.

If the pinned version is far behind, bump one **minor** at a time rather than
jumping several: each step's changelog is then the explanation for that step's
diff, and a behaviour change that needs a config response is attributable.
