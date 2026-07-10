/**
 * Rewrite each workflow's `<name>-v<semver>` literals (e.g. the pinned
 * Khan/actions checkout ref inside workflows/review/review.md) to that
 * workflow's current package version.
 *
 * Runs as part of the changesets version command (root package.json
 * "version-packages", wired into .github/workflows/release.yml) so the bump
 * lands in the same Version Packages commit that gets tagged.
 *
 * Usage: node -r @swc-node/register utils/sync-workflow-versions.ts
 */
import {syncWorkflowVersions} from "./sync-workflow-versions-lib.ts";

syncWorkflowVersions();
