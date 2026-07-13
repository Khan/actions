import * as fs from "fs";

/**
 * Keep released-version literals inside each workflow's markdown in sync
 * with that workflow's package version.
 *
 * A workflow under `workflows/<name>/` is released as a `<name>-v<version>`
 * git tag named after the directory (see publishWorkflow in
 * utils/publish.ts), and its markdown may embed that tag as a literal:
 * review.md, for example, checks out Khan/actions at a pinned
 * `ref: review-v<version>` tag to fetch the deterministic lib the prompt
 * invokes at runtime. Changesets bumps package.json but knows nothing about
 * prose in a markdown file, so this script runs alongside `changeset version`
 * (see the root package.json "version-packages" script, used by
 * .github/workflows/release.yml) to rewrite every `<name>-v<semver>` literal
 * in each workflow's markdown to the version being released. That way the
 * bump lands in the same Version Packages commit that gets tagged, and each
 * tag's markdown pins its own release.
 *
 * CHANGELOG.md is skipped (changesets writes historic versions there on
 * purpose), and a workflow whose markdown embeds no literal is a no-op. A
 * workflow that must embed one enforces that with its own contract test;
 * workflows/review/version-sync.test.ts is the CI backstop that fails when
 * review.md's literals and the `review` package version diverge.
 */

export const WORKFLOWS_DIR = "workflows";

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const workflowVersionRe = (name: string): RegExp =>
    new RegExp(`${escapeRegExp(name)}-v\\d+\\.\\d+\\.\\d+`, "g");

export const syncWorkflowVersionContent = (
    content: string,
    name: string,
    version: string,
): {content: string; replaced: number} => {
    let replaced = 0;
    const next = content.replace(workflowVersionRe(name), () => {
        replaced += 1;
        return `${name}-v${version}`;
    });
    return {content: next, replaced};
};

export type DirEntryLike = {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
};

export type SyncWorkflowVersionsDeps = {
    readFileSyncImpl?: (path: string, encoding: "utf-8") => string;
    writeFileSyncImpl?: (path: string, data: string) => void;
    readdirSyncImpl?: (path: string) => DirEntryLike[];
    log?: (message: string) => void;
};

export const syncWorkflowVersions = (
    deps: SyncWorkflowVersionsDeps = {},
): void => {
    const readFileSyncImpl =
        deps.readFileSyncImpl ??
        ((path: string, encoding: "utf-8") => fs.readFileSync(path, encoding));
    const writeFileSyncImpl = deps.writeFileSyncImpl ?? fs.writeFileSync;
    const readdirSyncImpl =
        deps.readdirSyncImpl ??
        ((path: string) => fs.readdirSync(path, {withFileTypes: true}));
    const log = deps.log ?? console.log;

    const workflowNames = readdirSyncImpl(WORKFLOWS_DIR)
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    for (const name of workflowNames) {
        // The release tag is named after the directory, not package.json's
        // "name" field (see publishWorkflow in utils/publish.ts).
        const pkgPath = `${WORKFLOWS_DIR}/${name}/package.json`;
        const pkg = JSON.parse(readFileSyncImpl(pkgPath, "utf-8"));
        if (!pkg.version) {
            throw new Error(`No version found in ${pkgPath}`);
        }

        const markdownFiles = readdirSyncImpl(`${WORKFLOWS_DIR}/${name}`)
            .filter(
                (entry) =>
                    entry.isFile() &&
                    entry.name.endsWith(".md") &&
                    // Changesets writes historic versions to the changelog;
                    // those must stay as released.
                    entry.name !== "CHANGELOG.md",
            )
            .map((entry) => entry.name);

        for (const fileName of markdownFiles) {
            const filePath = `${WORKFLOWS_DIR}/${name}/${fileName}`;
            const content = readFileSyncImpl(filePath, "utf-8");
            const {content: synced, replaced} = syncWorkflowVersionContent(
                content,
                name,
                pkg.version,
            );

            if (replaced === 0) {
                continue;
            }

            if (synced === content) {
                log(`${filePath}: already at ${name}-v${pkg.version}`);
                continue;
            }

            writeFileSyncImpl(filePath, synced);
            log(
                `${filePath}: synced ${replaced} ${name}-v literal(s) ` +
                    `to ${name}-v${pkg.version}`,
            );
        }
    }
};
