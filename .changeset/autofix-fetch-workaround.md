---
"autofix": patch
---

Work around a gh-aw bug that makes `push-to-pull-request-branch` unusable on large monorepos.

The safe-outputs job checks out with `actions/checkout` and no `fetch-depth`, giving a depth-1 shallow clone of `refs/pull/N/merge` — the merge commit without its parents. `push_to_pull_request_branch.cjs:935` then fetches the PR branch with no `--depth`. The branch tip is a parent of the merge commit and so absent, and its history never reaches the existing shallow boundary, so git walks the branch all the way back: a full-history fetch.

On a small repo this is invisible, because the branch's parent is usually the shallow boundary already. Reproducing the exact command against Khan/webapp from a faithful depth-1 checkout: over 14 minutes, 5.6 GB and still climbing, never finished. That is what cancelled the safe-outputs job on Khan/webapp#41130 and left the PR with no commit, no summary comment, and the label still on.

`--depth=1` on that fetch would fix it, but there is no way to ask for it: git has no `fetch.depth` config, none of the 20 `push-to-pull-request-branch` options touch fetch or checkout, frontmatter `checkout:` configures the agent job only, and `pre-agent-steps`/`post-steps` cannot inject steps into the safe-outputs job. gh-aw's own `checkout_pr_branch.cjs:229` passes `--depth`, and this same file passes `--depth=1` at :1001 and `--filter=blob:none` at :1065, so :935 is an oversight.

The workaround injects a partial-clone filter through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, which git honours as if passed via `-c` and which reaches the fetch because the handler runs it with `env: {...process.env, ...gitAuthEnv}` and `gitAuthEnv` is empty. Depth still cannot be bounded, but skipping blobs removes the bulk: the same fetch completes in 91 s and ~557 MB.

It composes with gh-aw's own `GIT_CONFIG_*` use rather than clobbering it: `ensureSafeDirectoryTrust` (`git_helpers.cjs:64-76`) reads the existing count and appends at the next free index.

Trade-off worth knowing: workflow-level `env:` reaches every job, so the agent job's checkout also becomes a partial clone and file reads lazily fetch blobs. gh-aw exposes no per-job env, so this cannot be scoped more tightly. Remove the whole block once the upstream fetch passes a depth.
