---
"review": patch
---

Keep the pinned `ref:` inside review.md in sync with the released version. The release flow's version command now runs `utils/sync-review-version.ts` after `changeset version`, rewriting every `review-v<semver>` literal in review.md to the version being released so the bump lands in the same Version Packages commit that gets tagged; `workflows/review/version-sync.test.ts` fails CI whenever the ref and the `review` package version diverge. Also bumps the currently stale ref from review-v1.2.2 to review-v1.4.0 (v1.3.0 through v1.4.0 shipped with the lagging ref, so an un-overridden consumer checked out a lib without `lib/provenance.ts`).
