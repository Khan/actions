# autofix

## 0.4.0

### Minor Changes

-   499a8bd: Autofix now parses the review body's collapsed observations as a second work-list source, and the reviewer's documentation-label budget exemption goes away. The coupling this fixes: autofix selected its work exclusively off posted threads (the label parse on each opener), so any finding the reviewer's posting surface collapsed (the non-blocking budget, `blocking-only`/`blocking-medium` re-reviews) silently vanished from autofix's scope; the documentation autofix was the acute case, since its entire selection is one label. The plan reads the collapsed entries of the latest bot review body (`workflows/autofix/lib/collapsed.ts`, parsing the exact line grammar `submission.ts` renders), filtered by the same scope labels, deduplicated against open threads (`thread-covered`), and subject to the same stale-path currency check. Body-sourced items carry a synthetic `review-body:path:line:label-token` id; there is no thread to reply on, so the prompt reports their outcomes in the run summary instead of Step 6 replies. With that in place, the review side drops the documentation exemption from the non-blocking inline budget: doc findings are budgeted like any other, and collapsing one no longer shrinks the autofix's reach.

    Two disclosures. The collapsed section now always renders into the review body, never riding the top-ranked inline comment: the body is the only surface both stagers persist, so the ride made the new work-list source blind exactly where the budget sheds. Expected output-shape effect: the top inline comment shrinks by the collapsed section it used to carry, the review body grows by the same block, inline comment count is unchanged by this PR itself, and dropping the documentation exemption means a doc finding past the budget collapses instead of posting inline (at the measured 2.91 findings/run the budget binds rarely). And the body source widens `autofix: nits` to collapsed nitpick-class findings, which by design never become threads and were previously unreachable; that is the reach the posting-surface changeset promised this change would restore, and it means autofix can push commits for findings that never appeared as inline comments.

## 0.3.0

### Minor Changes

-   c24fdbf: The fixer learns the documentation reviewer's three new readability finding
    shapes (review's prose-readability release: metaphor in place of the
    mechanism, says-the-same-thing-twice, undefined coinage).

    Three rule changes in `autofix.md` Step 4, no code changes:

    -   **Batched instances are in scope.** The reviewer caps readability at one
        thread per review and enumerates up to three further instances, verbatim, in
        that thread's body. The do-not-touch-other-files rule gains a second
        exception for them: each _quoted_ instance is part of the finding wherever
        it lives, while an instance merely alluded to without a quote is not.
        Without this, the fixer could only ever fix the anchored instance, the
        thread could never fully resolve, and the batching (which exists to spare
        the author five separate threads) would trade author attention for fixer
        blindness. The verbatim-rewrite rule below still governs each quoted
        instance: the reviewer quotes it but need not rewrite it, so the fixer
        touches it only when the fix needs none of its own words (deleting a
        duplicated paragraph) or the thread body carries a rewrite for that
        instance; a quoted metaphor or coinage without one is left unfixed and
        reported.
    -   **Readability rewrites are applied verbatim.** A readability finding carries
        its plain rewrite, and that rewrite passed claim validation, which checked
        it preserves the original sentence's meaning. The fixer's improvised
        paraphrase passed nothing, so improvising is now off the table: apply the
        reviewer's words, or (when the file has drifted and the quote no longer
        fits) leave the item unfixed and say so.
    -   **Duplicate paragraphs are deleted, never re-worded.** The existing
        rewrite-before-delete bias is calibrated for a restated comment sitting on
        unexplained code. Applied to a says-the-same-thing-twice finding it would
        produce a third phrasing of content that already exists twice, which is the
        defect the finding names. Deletion of the quoted copy is the fix.

    The README documents the one shape that stays out of reach by design: a PR
    title/description readability finding folds into the review body and never
    becomes a thread, so the thread-driven worklist cannot see it. The description
    is the author's voice; the review body already offers them the rewrite.

## 0.2.0

### Minor Changes

-   28d7938: Settle the `docs` convergence question, and bias the fixer toward rewrite-with-why over deletion.

    `docs` is now **permanently loop-ineligible under the current scope model** rather than ineligible pending measurement, and the argument in `scope.ts` is mechanical instead of a guess about which half of the documentation policy dominates. The reviewer's only bound on re-flagging is its newly-changed-code scope, built from each unseen hunk's _added_ lines (`computeNewScope`); a docs-scoped fix writes comment text and nothing else, and comment text is the documentation reviewer's subject matter. So deletion converges only by erasure (webapp#41204 fixed a "restates the constant" finding on `staleAfter` by deleting the comment, leaving the constant undocumented), while rewriting re-arms (webapp#41207 fixed 5 of 5 documentation threads at perfect precision, and the re-review its own push triggered minted three fresh documentation findings on the prose the fixer had just written). #41207 is the data point #41194 could not be: real `documentation`-labelled threads, and re-mints on lines the autofix commit itself introduced rather than a memoryless whole-diff re-derivation. #41207 predates the per-lens volume caps this release adds, so its re-mint count is an upper bound on what the capped reviewer would post; the caps bound how many findings a cycle emits, not whether the fixer's prose lands in the next cycle's in-scope set, so a capped loop re-arms more slowly but still re-arms. A cadence axis that wants `docs` needs an authorship-aware scope bound (exclude hunks whose commit carries `Autofix-Scope: docs`) as a precondition, not a better prompt.

    Two prompt rules follow from the same evidence, and they are the right trade only because one-shot mode has no cadence to protect: on a documentation item, **rewrite before you delete** when the code's non-obvious reason is recoverable from the diff, the surrounding code, or the reviewer's thread — and **never invent a rationale**, since a plausible reason nobody can source is worse than no comment. When a deletion does leave a value unexplained, Step 7 must name the symbol and say so, because a thread reported as plainly fixed hides the one sentence only the author can write.

### Patch Changes

-   83d14c3: `threads.json` / `human-threads.json` are staged by code, completing deterministic-orchestrator slice 1. `lib/stage-pr.ts` deliberately deferred them ("Phase 2; a later slice"), so review.md Step 3 asked the ORCHESTRATOR to fetch the unresolved threads and write both files in a particular shape, and everything downstream then depended on a model-produced file: `dispatch.ts` reads it for `hasThreads` (which gates the thread-reconciler dispatch, so it changes the roster) and for open-thread suppression, and `lib/rereview.ts` reads it for the accountability section. That seam is the failure class Khan/actions#302 patched a symptom of: the prompt selected bot threads by one spelling of the bot's login while `openThreadsFromStaged` admitted another, so a _conforming_ staging produced zero usable threads and suppression silently never ran for a whole release. The worse direction was never hit but was always available: `human-threads.json` was specified as "any author other than the bot", and a bot thread misfiled there lands in `skipLines`, which makes the submission DROP a fresh finding on that line rather than merely duplicate one.

    The staging step now does one GraphQL fetch of every unresolved review thread and partitions it: threads this bot opened (full reply chain, bodies byte-for-byte, `resolved: false`, the opener's `html_url`) into `threads.json`, everyone else's `{path, line}` into `human-threads.json`, so a thread is in exactly one file and neither list is assembled by hand. GraphQL rather than REST because REST exposes neither a thread's resolution state nor the `PRRT_…` node id the resolve safe output takes. Producer and consumer now share one bot-identity predicate (`lib/threads.ts`'s `isReviewBotAuthor`, which compares suffix-stripped so REST's `github-actions[bot]` and GraphQL's bare `github-actions` are one account): the two layers can no longer spell the identity differently, which is the actual #302 defect rather than its symptom. The fetch, its paging, and its fail-closed guards live once and are shared with autofix's staging, which had the only copy and whose comments carry both prior postmortems (Khan/webapp#41140's `threadCount: 0`, and GitHub answering a rate limit with HTTP 200 plus an `errors` array); autofix's `collectThreads` is now that shared fetch plus its by-opener filter, with no behavior change.

    The bot identity is deployment config, not a compiled-in constant: `REVIEW_BOT_LOGIN` (default `github-actions[bot]`, matching autofix's `AUTOFIX_BOT_LOGIN` and the thumbs sweep's `REVIEW_SWEEP_BOT_LOGIN`) moves the producer and the suppression guard together, so a consumer posting reviews under its own GitHub App no longer has every one of its bot threads misfiled as human, which would put them in `skipLines` and drop fresh findings on those lines. Login comparison also case-folds before stripping the `[bot]` suffix, so a `…[BOT]` spelling cannot read as a different account.

    A failed thread fetch fails the staging step rather than degrading to `[]`, because an empty staging is not the conservative direction here: it drops the flip gate's `keptBlockingCount` to zero, and a reduced-depth re-review may then flip a prior REQUEST_CHANGES to APPROVE past still-open blocking threads nobody read. The step runs before any AI spend, GraphQL's HTTP-200 rate limit is retried, and the review re-runs on the next push. That retry now lives in `lib/threads.ts` beside the fetch rather than inline in the reviewer's CLI, so autofix's port inherits it (it had none, and died on its first throttle) and a unit test can reach both directions; a page that claims a successor without a cursor is likewise refused rather than returning the partial list, matching the guard on every other failure shape here. `dedup.ts`'s fail-closed guards (bot-authored opener, explicit `resolved: false`) stay rather than trusting the new producer, as does the `stagedThreadShapeFailure` tripwire: a conforming code staging can no longer trip it, which is the point, since a fire now means either that the producer and consumer have drifted inside one repo, or that the staging came from the eval's own producer or a hand-built reproduction. The new tests feed the staged bytes straight into `openThreadsFromStaged` and `computeRoster` rather than only asserting the file's shape, since "each layer looked right on its own" is how #302 shipped. review.md Step 3 keeps exactly one thread job: reading the reply chains for an author's factual dispute, which is a judgment.

    The tripwire this PR keeps is also made visible. `stagedThreadShapeFailure` reported `threadSuppressionUnavailable` on `dispatch-result.json` and printed a `::warning`, but the dispatcher runs inside the agent's Bash tool, where a workflow command is only text: measured on webapp#41204 run 30654454047, a deliberately mis-staged `threads.json` produced `unusableThreads: 9`, the line reached the run log and the step summary, and zero annotations across the run's six jobs mentioned suppression, while the pre-agent staging step's own `::warning` in that same run did annotate. Since a fail-open guard nobody can see failing is exactly how #302 survived a release, the dispatch-conformance gate now re-emits it: the gate is a `post-steps` step that runs `if: always()`, already reads every `out/` file, and its own workflow commands do annotate. The line is REBUILT from the numeric `unusableThreads` rather than forwarded as stored text, because the gate step is trusted while `out/` is a directory the agent can write, and a stored string could carry newlines that inject further commands (`::error`, `::add-mask`) into it; anything absent, non-numeric or non-positive forwards nothing. The formatter is shared with `dedup.ts` so the two cannot drift, and the forwarding lives in `lib/forwarded-warnings.ts` because `dispatch-gate.ts` sits at its 1000-line lint ceiling. Post-#308 this matters more, not less: a conforming code staging can no longer trip the tripwire, so a fire now means producer/consumer drift inside one repo.

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
