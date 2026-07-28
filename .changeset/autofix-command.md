---
"autofix": minor
---

Add `/autofix` as a second arming surface, a peer of the label rather than a shorthand for it.

`/autofix`, `/autofix nits`, `/autofix blocking nits` all work; a bare command means `blocking`, the scope that terminates at the merge gate. Arguments are read from the command's own line, so prose below it survives as context for whoever reads the thread.

Both surfaces resolve through one function (`scope.ts` `resolveTokens`) over a shared token vocabulary, so a value cannot mean one thing as a label and another as a command. The three-axis model (scope unions, cadence is a flag, source unions) now describes tokens rather than labels, and stays bounded by the axes rather than growing as their product.

The trigger decides and the two never union: a stale `autofix: nits` label will not widen an explicit `/autofix blocking`. A command-armed run removes no labels, since a comment is self-clearing and any label present was not what armed it.

The command gate is written out longhand in the workflow's `if:` rather than using gh-aw's `slash_command` trigger, whose compiled gate misses a trailing CRLF and silently killed `/review` in Khan/webapp#40943. The parser tolerates the same shapes and a test pins the CRLF case.

Note the comment path's cheap gates are weaker by construction: `issue_comment` carries no `github.event.pull_request`, so the fork guard and the `skip-ai-review` check move into the plan rather than the `if:`. gh-aw's `roles` check still gates it, compiling to an `author_association` test, so a comment from someone without write access never reaches the agent.
