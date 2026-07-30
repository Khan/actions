# autofix

## 0.1.0

### Minor Changes

-   7d62a7a: Add `docs` to the scope axis: `autofix: docs` / `/autofix docs` fixes only the `documentation` reviewer's threads, selected by the label that reviewer mints (`suggestion (non-blocking, documentation)`).

    It is a **subset of `nits`, not a peer of it**. Documentation findings are non-blocking, so `nits` already covers them and arming both is the same as arming `nits`; the containment runs one way only, and `docs` exists because arming `nits` to clear three stale comments also invites the fixer into every other cosmetic thread on the PR. The flat token namespace cannot express that, so `scope.ts` and the README both say it. `findingLabelsForScope` becomes an exhaustive switch rather than a blocking/non-blocking ternary, and the tests pin the containment and the absence of any blocking label from docs scope.

    `docs` is **not loop-eligible**, which is worth stating because it looks like the exception to "nits never loop" and is only half one: its deletion half converges (a comment that restates the code is either gone or not), while the documentation reviewer's _missing explanation_ findings are answered with prose, and prose can always be wanted better. Ineligible until something measures which half dominates.

    One prompt rule comes with it: a documentation item changes text, never code. Deleting a redundant comment is the expected fix (and such findings often carry no suggestion block, since a deletion cannot be expressed as one), but if the honest fix would touch an executable line the item is left unfixed and reported rather than becoming a code change wearing a documentation label. That property — edits that cannot alter behavior — makes `docs` the safest scope to trial first in a repo new to autofix.

    Note the version coupling: autofix selects threads by parsing the label off each posted comment, so this scope finds threads only in repos whose **installed** `review` release mints the documentation label. Against an older reviewer it is not broken, just always empty.

-   486bb92: Add the `autofix` workflow: opt-in, one-shot fixing of the PR reviewer's own feedback.

    Arm a PR with an `autofix: blocking` / `autofix: nits` label or an `/autofix [scope]` comment; the run fixes the reviewer's open threads in that scope, pushes one commit, replies in each thread, and removes the label. Both arming surfaces are peers resolving through one shared token vocabulary, and the trigger decides which is read, so a stale label cannot widen an explicit command.

    Everything except the code edit is deterministic. `lib/stage.ts` runs as a pre-agent step and fetches the inputs before the agent starts; `lib/plan.ts` then resolves scope, checks review currency, builds the work list, and renders the commit trailer. The plan is final: the prompt may execute it or stop, never widen it.

    Guards fail closed. Currency is checked per file so one unrelated push doesn't refuse the whole run; unparseable labels, outdated anchors, threads a human opened, an unreadable diff, and a head that moves mid-run are all excluded. Refusal is reserved for a PR with no review at all, and for a thread fetch that fails: GitHub reports GraphQL rate limits and node-access failures as HTTP 200 with an `errors` array, so staging treats any `errors` entry or an unparseable body as fatal rather than as "this PR has no threads", which would clear the arming label while the findings it was armed for stayed open.

    The reviewer's `skip-ai-review` label does not disarm autofix. It stops the reviewer's next run without withdrawing a review already posted, so a labelled PR can still carry current findings, and an explicit `autofix:` label or `/autofix` from someone with write access is the authorisation to act on them. A PR with no review is still refused, by the guard that checks for one.

    The push uses `KHAN_ACTIONS_BOT_TOKEN`, because GitHub creates no workflow runs for `GITHUB_TOKEN`-triggered events, and the re-review of the autofix commit is the intended verification a fix gets. That verification is best-effort rather than guaranteed: the chain from the push to a posted review has several links, whether a break is visible depends on how the consumer triggers its reviewer, and the human re-arming loop is the accepted backstop for v1. The run's summary comment says so on every push. Ships with a documented workaround for gh-aw's unbounded PR-branch fetch, which is otherwise fatal on large monorepos.
