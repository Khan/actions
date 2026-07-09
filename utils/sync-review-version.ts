/**
 * Rewrite the review-v<version> literals in workflows/review/review.md (the
 * pinned Khan/actions checkout ref) to the current "review" package version.
 *
 * Runs as part of the changesets version command (root package.json
 * "version-packages", wired into .github/workflows/release.yml) so the bump
 * lands in the same Version Packages commit that gets tagged.
 *
 * Usage: node -r @swc-node/register utils/sync-review-version.ts
 */
import {syncReviewVersion} from "./sync-review-version-lib.ts";

syncReviewVersion();
