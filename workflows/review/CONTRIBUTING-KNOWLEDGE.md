# Teaching the review bot about your code

This guide is for engineers who want the PR review bot to know something about
their code: a convention, a risk, a trap that has bitten the team before. Most
of that knowledge lives in the repo being reviewed, not in this one, so adding
it is an ordinary PR in your own repo.

For how the bot works internally, see [`SPEC.md`](SPEC.md). For installing it
in a new repo, see the [README](README.md#install).

## TL;DR

- The bot reads a handful of **files in your repo** at review time. Each file
  feeds a different part of the review, and picking the right one is most of
  the work.
- **Conventions** that should be enforced by quoting a rule go in a **skill**,
  listed in `.github/aw/review/skills.md`.
- **What matters versus what's a nit** in one part of the tree goes in a
  **`REVIEW.md`** next to that code.
- **Domain-specific checks** (auth, migrations, caching, …) go in a **lens
  payload**, `.github/aw/review/lenses/<lens>.md`, and the paths that need
  them get a `lens=` line in `ROUTING`.
- **Bug patterns to hunt for on every PR** go in `lenses/correctness.md`.
- **Which files are risky** goes in `ROUTING` (machine-read tiers) and
  `risk-classification.md` (the prose the reviewer reads).
- **Anything CI already catches** goes in `ci-tooling.md`, so the bot stops
  flagging it.
- **On a single PR**, reply to, resolve, or 👎 the bot's comment. A resolve
  or 👎 stops the bot from re-raising the same non-blocking point later.

Everything you add can only make the review stricter or better aimed. None of
these files can tell the bot to ignore a defect or lower its evidence bar.

## Where should I start?

| If you want to… | Go to |
| --- | --- |
| Get a written convention enforced ("always use X", "never call Y") | [Skills](#skills-skillsmd) |
| Tell the bot what's important in your package or service | [Per-directory `REVIEW.md`](#per-directory-reviewmd) |
| Make the bot look for a specific bug pattern on every PR | [Lens payloads](#lens-payloads-lenseslensmd), `correctness` |
| Add checks for one domain (auth, data migrations, payments, …) | [Lens payloads](#lens-payloads-lenseslensmd) and [`ROUTING`](#routing) |
| Mark a directory as high-risk so it gets a bigger review | [`ROUTING`](#routing) and [Risk classification](#risk-classification-risk-classificationmd) |
| Stop the bot flagging something lint or tests already catch | [CI tooling](#ci-tooling-ci-toolingmd) |
| Stop the bot reviewing generated files | [Generated files](#generated-files-gitattributes) |
| Get your team requested as reviewer on risky changes | [Ownership and notifications](#ownership-and-notifications) |
| Get pinged when certain files change | [Ownership and notifications](#ownership-and-notifications) |
| Turn on an extra reviewer (tests, docs, completeness, …) | [`ROUTING`](#routing) `enable` |
| Tell the bot it got something wrong on your PR | [Feedback on a PR](#feedback-on-a-pr) |
| Change how the bot reviews *every* repo | [Changing the shared reviewer](#changing-the-shared-reviewer) |

## How a review works, in brief

These terms are used throughout the guide.

On every push to a PR, a GitHub workflow runs the bot. Before any model runs,
deterministic code **stages** everything the review needs on disk: the diff,
the PR description, prior review threads, and a **routing** decision made from
your repo's `ROUTING` file. Then a set of model **finders** review the change
in parallel, each from one angle:

- **Always-on finders.** These run on every review:
  - `correctness-reviewer` looks for bugs. It also reads your
    `REVIEW.md` files and `lenses/correctness.md`.
  - `skill-auditor` checks the diff against your skills.
- **Opt-in reviewers.** These run when `ROUTING` enables them:
  `holistic`, `completeness`, `test-adequacy`, `first-principles`,
  `conventions`, `documentation`.
- **Specialist lenses.** Eleven domain experts (`security-auth`,
  `data-migrations`, `money-payments`, …). Each runs only when a changed file
  matches a `lens=` rule in `ROUTING`.

Each finder emits **findings**. A finding is a claim tied to a changed line,
with a concrete **failure scenario** (these inputs → this wrong outcome) and a
**severity**:

- **blocking** means changes are requested;
- **medium** means it should be fixed before merge but doesn't block;
- **advisory** is a suggestion.

Next, the **claim-validator** tries to disprove each finding against the actual
code and drops what it can't confirm. Code then decides the **verdict**
(approve, comment, or request changes), and the bot posts the findings as
inline comments and a review body.

What this means for you as a contributor:

- **Your text is read by models, and the validator re-checks every claim.**
  Write rules precise enough to quote and check. A vague rule produces vague
  findings that the validator then drops.
- **Findings only land on changed lines.** Your rules shape how new changes
  are reviewed. They won't trigger a sweep of existing code.
- **Your files are additive.** The shared rules in Khan/actions always win a
  conflict.

## The knowledge files

All paths are relative to the root of the repo being reviewed. Webapp has
real examples of each; they're linked as you go.

### Skills (`skills.md`)

**Feeds:** `skill-auditor`, and the specialist lens that owns the skill's
domain. `claim-validator` checks every skill finding against the skill file.

**Use it for:** written conventions with a right and wrong answer, such as
"resolvers must call a `//ka:permission-check` helper" or "use `tracegroup`,
not `errgroup`".

**How it works.** `.github/aw/review/skills.md` is a catalog. Each entry names
a skill file and says when it applies:

```markdown
### concurrency — `.claude/skills/concurrency/SKILL.md`

**Evaluate when:** a new goroutine / `go func`, `tracegroup`, `generic.SyncMap`,
`ctx.Detach`, a dataloader, or background work.
```

On each review, `skill-auditor` reads the catalog and decides which entries
match the changed files. For each match it opens the skill file and checks
the diff against it.

**The rule that matters most: quote the rule, quote the line.** A skill
finding is only reported when the bot can quote the exact rule text from the
skill file and the exact violating line from the diff. There's no "spirit of
the doc" inference. The posted comment shows the rule verbatim, so the author
sees your words rather than a paraphrase. In practice:

- **State each rule as a sentence that can be quoted**, such as "Never import
  `errgroup` outside `pkg/` and `cmd/`." A rule that exists only in an example
  or between the lines won't be enforced.
- **Mark severity** if you want control over it. Phrases like `must`, `never`,
  or `blocking` on a rule make it blocking; `should` or `advisory` make it a
  suggestion. You can also set one default for the whole skill. Without a
  marking, the bot judges by impact and leans toward advisory.
- **Keep "Evaluate when" concrete**: paths, symbols, file types. This line is
  what keeps the skill from running on every PR.
- **Optionally hand a skill to a lens.** Add `lens: <lens-id>` to the entry and
  the specialist lens audits it on PRs where that lens runs. `skill-auditor`
  then skips it, so the rule isn't checked twice. Use this when the rule needs
  the lens's domain depth.

Skills here are the same files your coding agents use (webapp's live in
`.claude/skills/`). Improving a skill improves both the code agents write and
the review of it.

**Example:** webapp's catalog,
[`.github/aw/review/skills.md`](https://github.com/Khan/webapp/blob/master/.github/aw/review/skills.md).

### Per-directory `REVIEW.md`

**Feeds:** `correctness-reviewer` (finding severity, and the wording of its
risk notes) and `claim-validator` (calibrating each claim it checks). The
`documentation` reviewer also uses them to calibrate.

**Use it for:** what tends to be important versus a nit in one part of the
tree, and what a review there owes. This file adjusts the reviewer's
judgment; it isn't for rules to enforce verbatim (use a skill for those).

**How it works.** These aren't config files. They live in the tree next to the
code. On each review the bot reads the repo-root `REVIEW.md`, plus the nearest
`REVIEW.md` above each changed file. A `REVIEW.md` in your package applies to
every change under that package unless a deeper one exists.

A good `REVIEW.md` has three parts:

- **What "Important" means here.** For example: the boundaries that must
  hold, the changes that look trivial but aren't, the downstream consumers
  a change can break. Say why each one matters; the reviewer uses the
  reason to judge new cases.
- **What's a nit here.** Things the bot should keep quiet about in this
  sub-tree.
- **Pointers** to the contracts or skills a reviewer should check against.

Limits:

- A `REVIEW.md` can change emphasis. It can't tell the bot to skip a check,
  whitelist a defect, or lower the evidence bar.
- It's read from the PR branch, so a PR that edits a `REVIEW.md` is reviewed
  against the edited version, and the edit itself gets reviewed.

**Example:**
[`services/ai-guide/REVIEW.md`](https://github.com/Khan/webapp/blob/master/services/ai-guide/REVIEW.md)
in webapp. Its bullets name a boundary ("model calls stay behind
`ai_interface/`"), say why it matters ("tests cannot mock the call and the
trace exporter cannot observe it"), and say what doesn't count ("a plain
`openai-go` import is not a finding").

### Lens payloads (`lenses/<lens>.md`)

**Feeds:** one finder, the lens the file is named after.

**Use it for:** checks specific to your repo within one domain, such as
"identity headers must be stripped at the Fastly boundary" for
`security-auth`, or bug hunts you want on every PR via `correctness`.

**How it works.** `.github/aw/review/lenses/<lens>.md` is pasted into that
lens's prompt as "repo-specific rules and hunts". Valid names:

- `correctness`, which feeds `correctness-reviewer`, so it runs on every
  review;
- the eleven specialist lenses: `security-auth`, `ai-safety-moderation`,
  `mass-comms-coppa`, `caching-resource`, `data-migrations`,
  `concurrency-async`, `api-federation-compat`, `cross-deploy-serialization`,
  `deploy-infra-config`, `money-payments`, `content-i18n`.

**A specialist payload only matters if the lens runs.** It runs only on PRs
that touch a path with a matching `lens=` rule in `ROUTING`. If you add a
payload with no routing, the bot warns on the next review that it's inert.

Writing a good payload:

- **Name the real files and symbols.** "A new read of an `X-Ka-*` header in
  `pkg/web/user_identity.go` must show the value can't be client-forged" gives
  the lens something to check. "Be careful with headers" doesn't.
- **Say what failure looks like.** The lens must produce a concrete failure
  scenario for every finding, and your rule should make that easy.
- **Cite the incident when there is one.** "Two CSP policies on one response
  intersect; a blanket `frame-ancestors` broke `/computer-programming/exec/*`
  (#37668)" teaches the lens the mechanism and shows the rule is real.
- **Additive only.** A payload extends the lens and never relaxes it; the
  shared rules win any conflict.

Not sure which to use? A rule that fits one domain is a payload. A house
convention with a sanctioned fix is a skill. A general "what's important here"
belongs in a `REVIEW.md`.

**Example:** webapp's
[`lenses/security-auth.md`](https://github.com/Khan/webapp/blob/master/.github/aw/review/lenses/security-auth.md).

### `ROUTING`

**Feeds:** the router, which is deterministic code, not a model. It decides
which lenses run, how big the review budget is, and which opt-in reviewers
are on.

**Use it for:**

- sending paths to a lens: `pkg/auth/** lens=security-auth`;
- marking paths' risk tier: `services/**/migrations/** tier=high`;
- turning on reviewers: `enable holistic,test-adequacy`.

The file also carries dials that set how repeat reviews behave
(`re-review …`, `non-blocking-budget …`). Those change cost and noise for
the whole repo, so leave them to whoever owns the reviewer in your repo.

**How it works.** It has one rule per line. Lenses add up across matching
rules, while for tiers the last matching rule wins (as in CODEOWNERS):

```
services/**                  tier=medium
services/**/testdata/**      tier=trivial
pkg/auth/**                  tier=high direction-dependent lens=security-auth
```

The highest tier among a PR's changed files sets its budget: how many finders
run and how deep each may dig. `direction-dependent` means the tier depends on
which way the change goes (tightening a check versus loosening one). The bot
asks a small model about those files instead of guessing.

**Check your rules** with the consumer-config checker, run from a checkout of
Khan/actions:

```sh
npx -y tsx workflows/review/lib/check-consumer-config.ts --repo <your-repo> --explain <path>
```

It shows every rule matching `<path>` and the tier that wins.

The full grammar is in the README:
[The `ROUTING` file](README.md#the-routing-file).

### Risk classification (`risk-classification.md`)

**Feeds:** `correctness-reviewer`, which assigns each changed file a risk
level. Those levels decide which owning teams are requested as reviewers and
what goes in the risk summary comment posted on approval.

**Use it for:** prose about what makes a file risky by its contents. `ROUTING`
tiers are path globs; this file can say "a schema change that removes a field
breaks shipped mobile apps", which a glob can't express.

Webapp's version also carries a "What to verify" list: CI-blind bug hunts that
have no skill of their own. It's one of the most heavily used files.

**Example:** webapp's
[`risk-classification.md`](https://github.com/Khan/webapp/blob/master/.github/aw/review/risk-classification.md).

### CI tooling (`ci-tooling.md`)

**Feeds:** `correctness-reviewer`, which doesn't flag what's listed, and
`claim-validator`, which drops any claim that does.

**Use it for:** anything your lint, type checker, tests, or codegen checks
already catch. When the bot keeps commenting on something CI enforces, add it
here, ideally naming the specific linter, so the bot knows the boundary of
what's covered. For example, `ka-log` catches `fmt.Sprintf` in a log message
but not logging a secret's value.

### Generated files (`.gitattributes`)

Files marked `linguist-generated` are stripped from what the finders read,
counted as trivial risk, and left out of re-review fingerprints. If the bot is
line-reviewing generated output, mark it here.

### Ownership and notifications

- **`.github/REVIEWERS`** maps paths to owning teams. When the bot approves or
  comments, it requests the teams owning the risky files. Those teams must also
  be in the `allowed-team-reviewers` list in `.github/aw/review/config.md`.
- **`.github/NOTIFIED`** lists people or teams to ping when matching files
  change, using the same format as Gerald. The bot @-mentions them in its risk
  summary comment, and only on approval.

Both files are read from the base branch, so changes take effect once merged.

## Feedback on a PR

The files above teach the bot ahead of time. You can also correct it on a
single PR, and that correction persists for the rest of the PR:

| Action | What the bot does with it |
| --- | --- |
| **Reply** to its thread | It reads the reply on the next run. A reply alone doesn't close the thread; the thread is resolved when the *code* changes to address it. |
| **Resolve** the thread | "Settled." Later runs won't re-raise the same non-blocking point, even in different wording or on another line. A blocking finding can still come back, because regressions must stay visible. |
| **👎** the bot's opening comment | Same effect as resolving. 😕 and reactions on replies don't count. |
| **Hide** the comment | Nothing. The bot can't see hidden state. |

If you keep correcting the same thing across PRs, fix it in a file instead:
add the missing rule to a skill or `REVIEW.md`, or add the CI check to
`ci-tooling.md`.

## When does my change take effect?

| File | Takes effect |
| --- | --- |
| skill files, `REVIEW.md`, `ROUTING`, `.github/aw/review/*.md` (other than `config.md`) | On the PR that changes them. Open the PR and the bot reviews it with your new text. |
| `.github/REVIEWERS`, `.github/NOTIFIED` | After merge. They're read from the base branch, so a PR can't grant itself reviewers or notifications. |
| `.github/aw/review/config.md` | After the workflow is recompiled (`gh aw compile`), because it's compiled into the workflow. |

Because most files take effect on their own PR, you can check a change cheaply:
include a small example of the code your rule targets in the PR, and see
whether the bot flags it.

## Changing the shared reviewer

Everything above is per-repo. Some changes affect how the bot reviews every
repo: a lens's built-in rules, a new finder, the output format, or verdict
logic. Those are made in Khan/actions (`workflows/review/review.md` and
`lib/`) and go through the eval suite:

- A reviewer prompt change is measured by a live A/B against the current
  release on the PR that makes it ([`eval/README.md`](eval/README.md)).
- A real incident the bot missed is worth adding as an eval corpus case, so
  every future change is checked against it
  ([`eval/README.md` — The corpus](eval/README.md#the-corpus)).
- Opt-in reviewers and lenses earn their `ROUTING` lines through these evals,
  not by default.

If you're unsure whether something belongs in your repo or in the shared
reviewer, ask whether it holds for every consumer on every stack. If it's
specific to your code, it belongs in your repo.
