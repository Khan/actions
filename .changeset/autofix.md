---
"autofix": minor
---

Add the `autofix` workflow: opt-in, one-shot fixing of the PR reviewer's own feedback.

Arm a PR with an `autofix: blocking` / `autofix: nits` label or an `/autofix [scope]` comment; the run fixes the reviewer's open threads in that scope, pushes one commit, replies in each thread, and removes the label. Both arming surfaces are peers resolving through one shared token vocabulary, and the trigger decides which is read, so a stale label cannot widen an explicit command.

Everything except the code edit is deterministic. `lib/stage.ts` runs as a pre-agent step and fetches the inputs before the agent starts; `lib/plan.ts` then resolves scope, checks review currency, builds the work list, and renders the commit trailer. The plan is final: the prompt may execute it or stop, never widen it.

Guards fail closed. Currency is checked per file so one unrelated push doesn't refuse the whole run; unparseable labels, outdated anchors, threads a human opened, an unreadable diff, and a head that moves mid-run are all excluded. Refusal is reserved for a PR with no review at all.

The reviewer's `skip-ai-review` label does not disarm autofix. It stops the reviewer's next run without withdrawing a review already posted, so a labelled PR can still carry current findings, and an explicit `autofix:` label or `/autofix` from someone with write access is the authorisation to act on them. A PR with no review is still refused, by the guard that checks for one.

The push uses `KHAN_ACTIONS_BOT_TOKEN`, because GitHub creates no workflow runs for `GITHUB_TOKEN`-triggered events and the re-review of the autofix commit is the only verification a fix gets. Ships with a documented workaround for gh-aw's unbounded PR-branch fetch, which is otherwise fatal on large monorepos.
