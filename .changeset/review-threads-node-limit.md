---
"review": patch
---

Staging failed on every PR with GraphQL `MAX_NODE_LIMIT_EXCEEDED` as of 1.17.0: the downvote-adjudication change gave THREADS_QUERY `reviewThreads(first: 100)` x `comments(first: 100)` x `reactions(first: 100)`, and GitHub prices a query by its potential nodes (1,010,100 here) against a 500,000 cap before reading any data, so the failure was static and unconditional (first hit on Khan/agent-settings#76, the v1.17.0 bump itself). `reactions` drops to `first: 10` (110,100 potential nodes), which is semantically free: only the opener's reactions are read, the adjudication threshold is one attributable non-bot 👎, and the only reaction ever skipped is the bot's own nudge seed. A test now pins the node arithmetic from the query string the production code actually sends, since fixture-driven tests never price the query.
