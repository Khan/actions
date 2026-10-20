# Review Bot — Architecture

Part 1 explains the bot in plain terms. Part 2 maps each idea to the files and
scripts that implement it. Part 3 covers the eval system. The end collects known
problems (each with a possible solution) and options for moving off gh-aw.

# Part 1 — Overview

## 1.1 What it does

On every push to a pull request, the bot reviews the change and responds the way a
human reviewer would: inline comments, then either an approval or a request for changes.

```mermaid
flowchart LR
  A([Developer pushes to a PR]) --> B[Review bot]
  B --> C[Inline comments]
  B --> D[Approve or request changes]
  B --> E[On approval: risk summary<br/>and team reviewers requested]
```

## 1.2 The core idea: a script runs the review, AI finds the bugs

Most of the bot is ordinary code that follows fixed rules. AI is used only where
judgment is needed: reading code and spotting problems. The **orchestrator** (the
agent gh-aw runs, prompted by `review.md`) coordinates the run, but in practice it
mostly runs the scripts in order and passes their results along. The reviewers
are **sub-agents**: separate AI agents that the scripts start.

```mermaid
flowchart LR
  subgraph Code["Ordinary code (predictable)"]
    P[Prepare] --> R[Decide who reviews]
    V[Pick the verdict] --> W[Write the review]
  end
  subgraph AI["AI (judgment)"]
    F[Sub-agent reviewers<br/>look for problems]
  end
  R --> F --> V
```

## 1.3 One review, start to finish

```mermaid
flowchart TD
  A[Gather the PR: diff, prior reviews,<br/>open discussions] --> B[Decide which reviewers<br/>this change needs]
  B --> C[Reviewers look for problems<br/>in parallel]
  C --> D[Clean up the findings:<br/>merge duplicates, drop noise,<br/>double-check each claim]
  D --> E[Decide approve or<br/>request changes]
  E --> F[Post to GitHub]
  F --> G[Remember what was reviewed]
```

## 1.4 Who reviews what

A change only gets the specialists it needs. Each repo writes its own rules
for which files need which specialists and how risky each area is.

```mermaid
flowchart LR
  Change[Changed files] --> Rules{Repo's routing rules}
  Rules --> Always[Always: correctness,<br/>best-practice skills]
  Rules --> Some[Only if relevant:<br/>security, data migrations,<br/>caching, concurrency, …]
  Rules --> Teams[Owning teams<br/>to request as reviewers]
```

## 1.5 Safety: the orchestrator cannot post directly

The orchestrator never has permission to write to GitHub. It can only *queue* actions.
A separate check compares that queue with what the code decided, and a separate
job holding the GitHub permissions does the posting.

```mermaid
flowchart LR
  AI[Orchestrator] -->|queues actions| Q[(Queue)]
  Q --> Check{Matches what<br/>the code decided?}
  Check -->|yes| Post[Separate job posts to GitHub]
  Check -->|no| Block[Nothing is posted,<br/>run fails]
```

## 1.6 Later pushes are reviewed more cheaply

The bot remembers what it has already reviewed. By default every push gets a full
review; a repo can opt in to cheaper modes that look at only the new parts. Either
way, it checks whether its earlier comments have been addressed.

```mermaid
flowchart LR
  Push[New push] --> Mode{Repo opted in to<br/>a cheaper mode?}
  Mode -->|no, default| Full[Full review]
  Mode -->|yes| Partial[Review only new parts]
  Full --> Old[Resolve earlier comments<br/>that are now fixed]
  Partial --> Old
```

## 1.7 Where things live

| Piece | Where |
|---|---|
| Instructions for the orchestrator and the sub-agents | `review.md` (copied into each repo) |
| The code that runs the review | `lib/` in this repo, fetched at run time |
| Per-repo rules (routing, teams, skills, extra specialist rules) | the repo using the bot, mostly under `.github/aw/review/` |
| Testing and measuring the bot's quality | `eval/` (never runs during a real review) |

---

# Part 2 — Mechanisms

## 2.1 One review, mapped to files

The steps in 1.3 run as scripts in `lib/`, in three phases: setup steps before the
orchestrator starts, scripts the orchestrator runs (as instructed by `review.md`), and checks
after it finishes. The scripts pass work along as files on disk (under
`/tmp/gh-aw/review/`). The one direct call is `stage-pr.ts` running the router's
first pass.

Scripts are boxes; files are rounded. Only the main files are shown, and two
smaller after-agent scripts (`cost-report-cli.ts`, `dismiss-review.ts`) are left out.

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 400}}}%%
flowchart TD
  GH[(GitHub API)] --> A
  Repo[(".github/aw/review/ROUTING<br/>.github/REVIEWERS<br/>.gitattributes")] --> B
  Cache[("cache-memory/pr-N.json")] --> A

  subgraph Before["Before the orchestrator (setup steps)"]
    A["stage-pr.ts"]
    B["router.ts"]
  end
  A --> F1(["pr-context.json<br/>files.json<br/>full.diff<br/>threads.json<br/>prior-reviews.json<br/>diff-facts.json"])
  F1 --> B
  B --> F2(["routing.json"])
  F2 --> A
  A --> F3(["provenance.json<br/>full-stripped.diff<br/>full-stripped-annotated.diff<br/>rereview-plan.json"])

  subgraph During["Run by the orchestrator"]
    C["dispatch.ts"]
    D["submission.ts"]
    E["review.md"]
    R["cache-record.ts"]
  end
  F1 & F2 & F3 --> C
  C --> F4(["dispatch-result.json<br/>out/#lt;agent#gt;.json"])
  F4 --> D
  Cache --> D
  D --> F5(["submission-plan.json"])
  F5 --> E
  E --> Q(["agent_output.json"])
  F1 & Q & F4 & F5 --> R
  R --> Cache

  subgraph After["After the orchestrator (checks)"]
    H["dispatch-gate.ts"]
  end
  Q & F5 --> H
  H -->|queue matches plan| Post[safe_outputs job<br/>posts to GitHub]
  H -->|mismatch| Strip[queue emptied,<br/>run fails]
```

### File details

Files are under `/tmp/gh-aw/review/` unless noted. Shapes are abbreviated (`…` = more fields).

**Scripts: what each reads and writes**

| Script | Reads | Writes |
|---|---|---|
| `stage-pr.ts` | GitHub API, cache memory | `pr-context.json`, `files.json`, `full.diff`, `threads.json`, `prior-reviews.json`, `provenance.json`, `rereview-plan.json`, … |
| `router.ts` | `files.json`, repo's `ROUTING` / `REVIEWERS` / `.gitattributes` | `routing.json` |
| `dispatch.ts` | `routing.json`, `rereview-plan.json`, diffs, `provenance.json`, threads | `dispatch-result.json`, `out/<agent>.json` |
| `submission.ts` | `dispatch-result.json`, `routing.json`, `rereview-plan.json`, `prior-reviews.json`, cache memory | `submission-plan.json` |
| `dispatch-gate.ts` | `agent_output.json` (queue), `submission-plan.json`, `out/` | pass, or strips the queue and fails |
| `cache-record.ts` | `agent_output.json`, `submission-plan.json`, `dispatch-result.json`, `diff-facts.json`, `pr-context.json` | `cache-memory/pr-N.json` |

**Staged before the orchestrator starts (`stage-pr.ts`, `router.ts`)**

| File | Stores | Shape |
|---|---|---|
| `pr-context.json` | PR metadata (title/description are untrusted author text) | `{number, title, description, author, baseBranch, headSha, isDraft, repo, …}` |
| `files.json` | changed files | `[{path, status, hasPatch}]` |
| `full.diff` | whole PR diff, rebuilt from the GitHub API | unified diff text |
| `threads.json` | this bot's open review threads, with full reply chains | `[{thread_id, path, line, url, comments: [{author, body}]}]` |
| `prior-reviews.json` | this bot's earlier reviews | `[{id, state, body}]` |
| `diff-facts.json` | fingerprints of the diff, used to tell what's been reviewed | `{diffFingerprint, hunkSignature}` |
| `routing.json` | suggested reviewers, owning teams, risk tiers, budget | `{lensesToSpawn, enabledReviewers, teams, perFileTier, generatedFiles, runBudget, pendingRiskQuestions, routingConfig}` |
| `provenance.json` | which lines each file's diff touches | per file `{added, removedAdjacent, removed}`, plus `snap`, `warnings` |
| `full-stripped.diff` | diff minus generated files | unified diff text |
| `full-stripped-annotated.diff` | same, with real line numbers printed (for AI eyes only) | annotated diff text |
| `rereview-plan.json` | how deep this round reviews, and why | `{depth: full\|scoped\|flip-gated\|fast, reasons, …}` |

**Written during the review**

| File | Written by | Stores | Shape |
|---|---|---|---|
| `out/<agent>.json` | `dispatch.ts` | each reviewer's raw output | per agent |
| `dispatch-result.json` | `dispatch.ts` | final findings plus a record of the run | `{depth, dispatched, shed, claims, merges, reconciliation, riskFiles, patterns, perAgent, totalUsd, …}` |
| … each `claims[]` entry | | one finding | `{id, source, path, line, label, subject, discussion, failure_scenario, confidence, …}` |
| `submission-plan.json` | `submission.ts` | exactly what to post | `{event, body, skipSubmission, comments, resolve, reasons, notes}` |
| `/tmp/gh-aw/agent_output.json` | gh-aw, from the orchestrator | the queued GitHub actions | gh-aw safe-output queue |
| `/tmp/gh-aw/cache-memory/pr-N.json` | `cache-record.ts` | memory of this PR across runs | `{timestamp, commitSha, verdict, filesReviewed, issuesFlagged, diffFingerprint, reviewedHunks, wasDraft, …}` |

## 2.2 How reviewers are prompted

Each sub-agent's prompt is a `## agent: <name>` section in `review.md`. Lines like
`{{#runtime-import …}}` pull the using repo's own files into those sections.
gh-aw puts each section in `.claude/agents/`, and `dispatch.ts` (`loadAgents`)
reads and runs it.

A prompt is built from these pieces:

```mermaid
flowchart LR
  subgraph Bot["Written by the bot's authors (review.md)"]
    D["Shared ground rules<br/>(written once, to disciplines.md)"]
    R["Each specialist's own rules<br/>and checklist"]
  end
  subgraph Repo["Written by the using repo (.github/aw/review/)"]
    S["skills.md: list of the repo's<br/>best-practice docs"]
    L["lenses/#lt;name#gt;.md: extra rules<br/>for one specialist"]
    O["risk-classification.md,<br/>ci-tooling.md, …"]
  end
  D --> P[Specialist prompts]
  R --> P
  S --> P
  L --> P
  O --> C[Correctness and other<br/>whole-PR reviewer prompts]
  S --> C
```

The code calls specialists "lenses", and the checklist items "hunts".

### Three kinds of rules

| | Specialist rules | Repo lens files | Repo skills |
|---|---|---|---|
| Written by | bot authors | repo team | repo team |
| Lives in | `review.md` | `lenses/<name>.md` | skill files listed in `skills.md` |
| How it reaches the prompt | always there | pasted in if the file exists | the reviewer reads the list, then opens the relevant files |
| How strictly applied | reviewer's judgment | reviewer's judgment | only counts if the reviewer quotes the exact rule and the exact line breaking it |
| Who decides severity | reviewer | reviewer | the skill file (`must` / `should`) |
| Checked by | that specialist | that specialist | the matching specialist if it's running, otherwise `skill-auditor` |

The strictness and severity rows are instructions in the prompts, not checks in
code. `lens-payloads.ts` warns about lens files no reviewer will ever load.

## 2.3 Inside `dispatch.ts`: the sub-agent pipeline

`dispatch.ts` runs the sub-agents and filters what they find. There are 23
sub-agents, in four roles:

| Role | Sub-agents | Job |
|---|---|---|
| **Triage** | `pattern-triage` | spots changes repeated across many files, and picks the files that need a real review |
| **Finders** | always: `correctness-reviewer`, `skill-auditor`<br/>when routing picks them: 11 specialists (`security-auth`, `data-migrations`, …)<br/>when the repo turns them on: `holistic`, `completeness`, `test-adequacy`, `first-principles`, `conventions`, `documentation` | look for problems |
| **Follow-up** | `thread-reconciler` | decides which of the bot's earlier comments the new code has fixed (only when it has open comments) |
| **Clean-up** | `claim-clusterer`, `claim-validator` | spot findings about the same problem; double-check each finding against the code |

```mermaid
flowchart TD
  T["pattern-triage"] --> W
  subgraph W["In parallel, 4 at a time"]
    F["finders"]
    RC["thread-reconciler"]
  end
  F --> PG["drop findings on lines<br/>the PR didn't change"]
  PG --> SF["drop findings on code<br/>already reviewed"]
  SF --> CL["claim-clusterer, then code<br/>merges duplicates"]
  CL --> SU["drop findings an open comment<br/>already covers, or a human dismissed"]
  SU --> V["claim-validator"]
  V --> OUT(["dispatch-result.json"])
  RC --> OUT
  classDef agent fill:#dbeafe,stroke:#3b82f6
  class T,F,RC,CL,V agent
```

Blue boxes are sub-agents; the rest is code. Triage only runs on full and
scoped reviews. Cheaper follow-up reviews run fewer finders, or none.

---

# Part 3 — Evaluation (`eval/`)

The eval system tests changes to the bot before they ship. It never runs during
a real review. The detailed guide is `eval/README.md`.

## 3.1 Three kinds of test

| Test | What it checks | AI model calls | Entry point | When |
|---|---|---|---|---|
| **Replay** | the pipeline code, fed saved sub-agent answers | none | the unit tests (`*.test.ts`) | every push |
| **Live A/B** | a change to `review.md`: real sub-agents run from the old and new versions, and both are scored | sub-agents, plus two small Haiku helpers (below) | `live-ab.ts` | PRs that change the bot, plus manual and weekly runs |
| **Judged replay** | how well-written the comments are: saved answers again, with an AI judge grading the comments | judge only | `live-judge.ts` | weekly, or the `live-judge` label |

In the live A/B, each version's run is called an "arm".

Two smaller tools reuse the live pieces: `rereview-sweep.ts` compares the cost and
results of each follow-up review mode, and `lifecycle/` replays scenarios
spanning several pushes (`lifecycle.test.ts`).

## 3.2 The test cases

A test case is one PR plus a description of the right review. There are 62, in
`corpus/`, read by `corpus/loader.ts`. A case is either one `<id>.json` file, or a
folder with `case.json` and a `tree/` folder holding the code the PR touches.

The diagram shows where each part of a case goes. Left: what's in the case.
Right: the eval code that uses it.

```mermaid
flowchart LR
  subgraph Case["case.json"]
    direction TB
    Sel["tags, category"]
    PR["changedFiles, diff,<br/>routerConfig, dimensions"]
    Rec["findings, validation"]
    Exp["expected"]
    LiveIn["live.prContext,<br/>live.rereview, tree/"]
    Specs["live.mustCatchSpecs,<br/>live.mayFlagSpecs"]
  end
  Sel --> Pick["loader.ts / live-ab.ts<br/>choose which cases run"]
  Sel --> Score
  PR --> Run["runner.ts<br/>runs the pipeline code"]
  Rec -->|replay only| Run
  LiveIn --> Stage["live-stage.ts<br/>sets up files for live sub-agents"]
  Stage --> Run
  Run --> Score["metrics.ts, gates.ts<br/>(replay scoring)"]
  Exp --> Score
  Run --> Match["live-match.ts<br/>(live scoring)"]
  Specs --> Match
```

| Field | Used by | Contents |
|---|---|---|
| `tags` | `loader.ts`, `live-ab.ts` | `smoke`: a quick 24-case subset run on every PR. `live`: 41 cases that can run with real sub-agents |
| `category` | `metrics.ts`, `gates.ts` | where the case comes from: real production bugs (19), correct changes (16), real human review comments (12), hand-planted bugs (12), PRs that try to trick the reviewer (3) |
| `changedFiles`, `routerConfig` | `runner.ts` | the PR's files, and the routing rules to apply |
| `diff` | `runner.ts`, `live-stage.ts` | the PR's changes |
| `dimensions` | `runner.ts` | which review passes ran (affects the verdict) |
| `findings` | `runner.ts`, replay only | saved sub-agent findings |
| `validation` | `runner.ts`, replay only | saved claim-validator decisions (21 cases) |
| `expected` | `metrics.ts` | the right verdict and comment count, and which findings must or must not be posted |
| `live.prContext`, `tree/` | `live-stage.ts` | the PR title and description, and the code sub-agents read |
| `live.rereview` | `live-stage.ts` | an earlier review and push, for follow-up review cases (3) |
| `live.mustCatchSpecs` | `live-match.ts` | bugs the review must find: file, line range, and patterns for how a correct comment would describe it |
| `live.mayFlagSpecs` | `live-match.ts` | other real bugs in the code; commenting on them isn't penalised |

## 3.3 How a case is fed in

```mermaid
flowchart TD
  Case([case]) --> R{which test}
  R -->|replay| RF["saved findings stand in<br/>for the sub-agents"]
  R -->|live| ST["live-stage.ts: writes the case out<br/>as the same files production uses"]
  ST --> EX["agent-extract.ts: pulls the<br/>sub-agent prompts from each review.md"]
  EX --> LP["live-producer.ts, live-runner.ts:<br/>run the sub-agents on the case"]
  RF --> PIPE["runner.ts: the same filtering,<br/>verdict and comment code as production"]
  LP --> PIPE
```

Live runs differ from production in a few documented ways:

| Difference | Reason given |
|---|---|
| no `thread-reconciler` | cases have no earlier comments |
| no `pattern-triage` | every changed file in a case is worth reviewing |
| sub-agents can only read and search files, and can't read outside the case (`read-scope.ts`) | the test answers sit on the same machine, and a reviewer once read them |
| the repo's config files come from the case's `tree/` | there's no real repo in a test |

Some of these have costs; see "Eval" under Problems.

## 3.4 How results are scored

**Replay** (`metrics.ts`, `gates.ts`, no AI):

| Measure | Question it answers |
|---|---|
| Must-catch rate | Of the bugs the case says must be found, how many were posted? |
| Precision on human-reviewed cases | Of the comments posted, how many match something a human reviewer flagged? |
| False blocks on correct changes | How often did the bot request changes on a PR with nothing wrong? |
| Noise | How many posted comments did the case say should not be posted? |
| Confidence accuracy | When a finding says it's 80% sure, is it right about 80% of the time? |
| Overfitting check | Does the bot do as well on cases kept aside from tuning as on the rest? |
| Trick-PR gate | Did any PR that tries to trick the reviewer succeed? Any failure fails the check. |

**Live A/B** (`live-match.ts`): a comment counts as finding a must-catch bug when
it's on the right file and lines and its wording matches one of the case's
patterns. If no comment matches that way, a Haiku helper (`match-arbiter.ts`) is
asked yes or no for comments on the same file, and its matches are marked for
review. Comments that match nothing count as noise, unless they're about one of
the other real bugs. A second comment about an already-found bug also counts as
noise.

**Comment quality** (`judge.ts`, live A/B and judged replay): a Haiku judge grades
each posted comment.

The live A/B only reports; it fails the PR's check in one case: if the new version
falls for a trick PR (after three tries). Results swing between runs, so
`aggregate.ts` combines repeated runs, and the README warns that a single run's
difference usually means nothing.

## 3.5 How the tests run

| Workflow | Trigger | Runs |
|---|---|---|
| `review-eval-ab.yml` | PRs that change the bot (`smoke` cases; the `full-eval` label runs all `live` cases); manually for repeated runs | `live-ab.ts` |
| `review-eval-drift.yml` | weekly; manually | `live-ab.ts`, both arms on main, every live case three times |
| `review-eval-full.yml` | weekly; `live-judge` label | `live-judge.ts` |
| `review-rereview-sweep.yml` | `rereview-sweep` label; manually | `rereview-sweep.ts` |

Every live run first checks that sub-agents really can't read outside their case
(`live-runner.ts --probe-read-scope`). Each run has a spending limit (`--max-usd`).

---

# Problems and possible solutions

Each problem is checked against the code; solutions are directions, not designs.

## Rules reach reviewers in too many ways (see 2.2)

**Lens files hold codebase knowledge only the reviewer can see.** They are
pasted into one specialist's prompt, but their content is useful to anyone
writing code. Webapp's only lens file, `lenses/security-auth.md`, lists
trust-boundary rules with file pointers (which request headers may be
trusted, how task-only routes must be gated).
*Solution:* move lens content into the repo's real skills and retire lens files.
Note this makes the rules stricter: skill rules must be quoted exactly to count.

**The skills index duplicates the skills.** `skills.md` repeats each skill's path and adds
bot-only "evaluate when" triggers; the skills themselves (webapp's
`.claude/skills/`, also linked as `.agents/skills`) already describe when they apply.
*Solution:* pick skills from each skill file's own description and drop the index.

**Built-in specialist rules use a different format from skills.**
*Solution:* ship them as built-in skills, so there is one format, one way of
loading rules, and one level of strictness.

## The prompt file is large and repetitive

**All instructions live in one ~3,800-line `review.md`.** The 11 specialist
sections (~840 lines) all follow the same layout (rules, checklist, repo add-ons, output format).
*Solution:* generate specialist sections from data.

**The same text is pasted in many places.** The skills index is imported into
13 prompts, and whole-change reviewers (e.g. `skill-auditor`) carry their own
edited copies of the shared ground rules.
*Solution:* write each to a file once, as `disciplines.md` already does for the ground rules.

**Some rule-based steps are still prose for the orchestrator.** The early-exit
check (Step 2) and choosing team reviewers (Step 8: risky files → owning teams,
minus teams already requested or already reviewed) are fixed rules the
orchestrator is asked to follow, unlike the steps already moved into scripts.
*Solution:* move them into code (see Option A).

## Stale and misleading text

**Comments describe a removed `task` dispatch mode** (the old Task-tool path,
e.g. `dispatch.ts`, `router.ts`, `dispatch-runner.ts`). Only `scripted` exists
in code.
*Solution:* delete the references.

**Code comments mostly record history and past incidents** rather than the
current design.
*Solution:* move history to the changelog; keep comments about current behaviour.

## Code structure

**Shared files have no shared types.** Scripts hand off through JSON files, and
the writer usually exports a type (`RoutingJson` in `router.ts`,
`DispatchResult` in `dispatch.ts`), but no other script imports it. Each
reader instead casts the file to its own partial shape, inline. For example,
`submission.ts`, `version-footer.ts` and `cache-record.ts` each declare their own
fragment of `dispatch-result.json`. A writer can rename a field without the
compiler noticing any reader.
*Solution:* one module per shared file that owns its path, type and reading
code; every script imports it.

**Every script rebuilds the same file-handling code.** `/tmp/gh-aw/review` is defined
separately in 16 files, `readJson` in 5, and each CLI has its own filesystem type
(`DispatchFs`, `SubmissionFs`, `StagePrFs`, …).
*Solution:* one shared file-access module.

**Files are opened far from the step that owns them.** `routing.json` is opened
by path in 9 modules, `rereview-plan.json` in 8, `dispatch-result.json` in 8,
including helpers like `version-footer.ts` and `investigation-cap.ts`. So any
module can quietly depend on any step's output.
*Solution:* read each file once per script and pass the values down as arguments.

**The review depth has two sources of truth.** `rereview-plan.json` holds it, but
`dispatch.ts` can rewrite that plan (upgrading a cheap review to a full one) and also records the depth in
`dispatch-result.json`. Later modules read it from one or the other, e.g.
`version-footer.ts` reads it from `dispatch-result.json`.
*Solution:* make one file authoritative and have every reader use it.

**Helpers live in whichever module needed them first.** Comment-label parsing
(`isBlockingLabel` in `render-comment.ts`, `parseLeadingLabel` in `rereview.ts`)
is imported by `dispatch-gate.ts` and `dispatch-escalation.ts`. The risks comment's
signature (`computeRisksPatternsKey`) lives in `cache-record.ts` but is computed
by `submission.ts`.
*Solution:* move shared helpers into small modules named for what they do.

**Module boundaries follow a line-count rule, not responsibilities.** The five
largest files sit at 992–999 lines, just under a 1,000-line lint cap, and many
modules say in their header that they were split out to stay under it
(`dispatch-agents.ts`, `forwarded-warnings.ts`, `stage-pr-cli.ts`, …).
*Solution:* split by responsibility (e.g. per pipeline stage), then let size follow.

## Eval

**The eval doesn't run the production pipeline.** Neither tier calls
`runDispatch` or `runSubmissionCli`. `runner.ts` recombines lib functions itself,
and live runs use their own sub-agent runner (`live-runner.ts`, separate from
`dispatch-runner.ts`) and their own code for pulling prompts out of `review.md` (`agent-extract.ts`).
Changes to how `dispatch.ts` or `submission.ts` wire things together go
untested, and the copies drift: `live-producer.ts` redefines `DEFAULT_FINDERS`
instead of importing it from `dispatch-roster.ts`.
*Solution:* make `runDispatch` and `runSubmissionCli` the eval's entry points,
with the model runner and file paths injected.

**Live sub-agents run under different tools than production.** Production allows
Read/Grep/Glob/LS/Bash; the eval allows Read/Grep/Glob, so `investigation-cap.ts`
can't run, and the tests measure what sub-agents do without a cap.
*Solution:* share one tool policy (and one cap hook) between both runners.

**Stale header in `judge.ts`.** It describes an "Opus-4.8 judge"; the pinned model
is `claude-haiku-4-5-20251001`.
*Solution:* fix the comment.

## Possible bugs

**Config warnings may never reach the PR.** Lens-file and ROUTING warnings land
in `routing.json`, and the prompt tells the orchestrator to show them. But
`submission.ts` (which writes the review body the orchestrator must post
exactly) doesn't read them.
*Solution:* confirm, then have `submission.ts` render them.

**The investigation cap depends on the sub-agent asking.** Each sub-agent is
told to run `investigation-cap.ts request <id>` before every investigation tool
call; the code only refuses when asked. A sub-agent that skips the call is
never capped. `dispatch-runner.ts` already uses an SDK hook to force
`submit_result`.
*Solution:* enforce the cap the same way, with a hook on each tool call.

---

# Options beyond gh-aw

High-level options, not plans. Today gh-aw provides five things the bot relies on:
it runs the orchestrator from `review.md`, posts through a separate job holding
the write token, meters and caps AI spend, keeps cache memory between runs, and
assembles prompts from the repo's config files. Consumers install the bot by
importing `review.md`.

## Option A: a deterministic pipeline with no orchestrator

The orchestrator already does little beyond running scripts in order. What it
still does:

| Orchestrator task | Kind of work | Without an orchestrator |
|---|---|---|
| Early-exit check (Step 2: merge commit with an unchanged diff) | fixed rules, written as prose | code |
| Run `dispatch.ts`, `submission.ts`, `notified.ts`, `cache-record.ts` | sequencing | code |
| Queue GitHub actions exactly as `submission-plan.json` says | copying | code calls the GitHub API |
| Decide whether a change to a sensitive area tightens or loosens it (`pendingRiskQuestions`) | judgment | one small sub-agent call |
| Note where the PR author disputed a bot comment (`author-disputes.json`) | judgment | one small sub-agent call |
| Risks comment and team reviewers (Steps 7–8) | mostly rules in prose | code |

```mermaid
flowchart LR
  subgraph Today
    direction TB
    S1[setup scripts] --> O[orchestrator<br/>runs scripts, copies plan<br/>into a queue]
    O --> G[dispatch-gate.ts<br/>checks the copy]
    G --> P1[posting job]
  end
  subgraph OptionA["Option A"]
    direction TB
    S2[setup scripts] --> D2[dispatch.ts<br/>+ two small judgment calls]
    D2 --> SUB[submission.ts]
    SUB --> P2[post with a<br/>narrowly scoped token]
  end
```

**What could be deleted**, because it exists only to manage the orchestrator:
- `dispatch-gate.ts` and `dispatch-gate-plan.ts` (about 1,300 lines), which check
  the orchestrator copied the plan faithfully.
- The 60-minute Bash ceiling and the one-blocking-call rule for `dispatch.ts`.
- The "died mid-dispatch" fallback comment, and `cache-record.ts` reading the
  queue to detect that case.
- The out-of-reach copy of `lib/` for post-agent steps.
- Most of the orchestrator half of `review.md` (Steps 1–9).

**What would need replacing:** a posting step that keeps write access away from
the AI steps, a spend cap, storage for PR memory, loading the repo's config
files into prompts, and a way for consumers to install it (e.g. a reusable
workflow).

## Option B: run sub-agents on pi instead of the Claude Agent SDK

Sub-agents already run outside gh-aw: `dispatch-runner.ts` starts each one with
the Claude Agent SDK, adds a custom `submit_result` tool, and uses a hook to force
it to be called. pi's SDK covers the same ground, plus:
- **Extensions with tool-call hooks** that can block a call, so limits like the
  investigation cap run inside the agent instead of relying on it asking.
- **Many model providers** through one interface.

**Durable sessions (`@earendil-works/pi-durable`, experimental).** It saves every
turn and tool call to storage and resumes after the process dies. That targets a
real failure: runs killed at the time limit during claim validation posted
nothing (run 32418662895), and `dispatch.ts` writes each sub-agent's output to
`out/` but never reuses it on a rerun. Checkpoints would only help if they
outlive the job, though (all run state lives in `/tmp` on the runner).
A cheaper first step is reusing finished `out/` results on retry.

# Next sections (to be written)

Each will go one level deeper into Part 1: preparing the PR, routing,
the review pipeline, verdict rules, follow-up reviews, and safety checks.
