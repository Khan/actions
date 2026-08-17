---
"get-changed-files": patch
---

Don't fail a new branch's first push when its PR hasn't been created yet.

On a `push` event where `before` is all zeros (the first push to a brand-new branch), the action looks up the pull request associated with the pushed commit to determine a base ref. That first push can race ahead of PR creation, so no PR is associated with the commit yet and the action hard-failed:

```
Could not determine base ref for 'push' event. No pull requests found associated with commit: <sha>. context.payload.base_ref is null.
```

This turned the "Node CI Push" job red on any PR whose branch was pushed before the PR existed, even though nothing was actually wrong.

The lookup now falls back to comparing against the repository's default branch (the base the PR would compare against anyway) and emits a `::warning::` instead of exiting non-zero. It still throws if no default branch is available in the payload.
