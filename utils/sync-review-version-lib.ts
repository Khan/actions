import * as fs from "fs";

/**
 * Keep the released-version literals inside workflows/review/review.md in
 * sync with the "review" package version.
 *
 * review.md checks out Khan/actions at a pinned `ref: review-v<version>` tag
 * to fetch the deterministic lib the prompt invokes at runtime; that ref is
 * supposed to name the release the file ships in. Changesets bumps
 * package.json but knows nothing about prose in a markdown file, so this
 * script runs alongside `changeset version` (see the root package.json
 * "version-packages" script, used by .github/workflows/release.yml) to
 * rewrite every review-v<semver> literal in review.md to the version being
 * released. That way the bump lands in the same Version Packages commit that
 * gets tagged, and the tag's review.md pins its own release.
 *
 * workflows/review/version-sync.test.ts is the CI backstop: it fails when
 * the literals and the package version diverge.
 */

export const REVIEW_MD_PATH = "workflows/review/review.md";
export const REVIEW_PKG_PATH = "workflows/review/package.json";

export const REVIEW_VERSION_RE = /review-v\d+\.\d+\.\d+/g;

export const syncReviewVersionContent = (
    content: string,
    version: string,
): {content: string; replaced: number} => {
    let replaced = 0;
    const next = content.replace(REVIEW_VERSION_RE, () => {
        replaced += 1;
        return `review-v${version}`;
    });
    return {content: next, replaced};
};

export type SyncReviewVersionDeps = {
    readFileSyncImpl?: typeof fs.readFileSync;
    writeFileSyncImpl?: typeof fs.writeFileSync;
    log?: (message: string) => void;
};

export const syncReviewVersion = (deps: SyncReviewVersionDeps = {}): void => {
    const readFileSyncImpl = deps.readFileSyncImpl ?? fs.readFileSync;
    const writeFileSyncImpl = deps.writeFileSyncImpl ?? fs.writeFileSync;
    const log = deps.log ?? console.log;

    const pkg = JSON.parse(readFileSyncImpl(REVIEW_PKG_PATH, "utf-8"));
    if (!pkg.version) {
        throw new Error(`No version found in ${REVIEW_PKG_PATH}`);
    }

    const content = readFileSyncImpl(REVIEW_MD_PATH, "utf-8");
    const {content: synced, replaced} = syncReviewVersionContent(
        content,
        pkg.version,
    );

    if (replaced === 0) {
        // At minimum the pinned-checkout `ref:` line must match; finding
        // nothing means the file was restructured and the sync went blind.
        throw new Error(
            `No review-v<semver> literals found in ${REVIEW_MD_PATH}; ` +
                `expected at least the pinned checkout ref line.`,
        );
    }

    if (synced === content) {
        log(`${REVIEW_MD_PATH}: already at review-v${pkg.version}`);
        return;
    }

    writeFileSyncImpl(REVIEW_MD_PATH, synced);
    log(
        `${REVIEW_MD_PATH}: synced ${replaced} review-v literal(s) ` +
            `to review-v${pkg.version}`,
    );
};
