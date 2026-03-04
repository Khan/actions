import fs from "fs";
import {execSync} from "child_process";
import fg from "fast-glob";

export const PINNED_RE = /(?<=uses:\s+)([^@\s]+)@([a-f0-9]{40})\s+#\s*(\S+)/g;
export const UNPINNED_RE =
    /(?<=uses:\s+)((?!\.\/).+\/.+)@(?!([a-f0-9]{40})\s)(\S+)/g;

export type UpdatePinnedDeps = {
    execSyncImpl?: typeof execSync;
    globSyncImpl?: typeof fg.sync;
    readFileSyncImpl?: typeof fs.readFileSync;
    writeFileSyncImpl?: typeof fs.writeFileSync;
    log?: (message: string) => void;
    exit?: (code: number) => never;
};

export type UpdatePinnedSummary = {
    filesScanned: number;
    uniqueRefs: number;
    updatedFiles: number;
    updatedRefs: number;
    alreadyCurrent: number;
    failures: number;
};

export const resolveRef = (
    action: string,
    ref: string,
    execSyncImpl: typeof execSync = execSync,
): string | null => {
    const url = `https://github.com/${action}.git`;

    const tagOutput = execSyncImpl(
        `git ls-remote --tags ${url} ${ref} ${ref}^{}`,
        {
            encoding: "utf-8",
        },
    ).trim();

    if (tagOutput) {
        const lines = tagOutput.split("\n");
        const deref = lines.find((line) => line.includes("^{}"));
        if (deref) {
            return deref.split(/\s+/)[0] ?? null;
        }
        return lines[0]?.split(/\s+/)[0] ?? null;
    }

    const branchOutput = execSyncImpl(`git ls-remote --heads ${url} ${ref}`, {
        encoding: "utf-8",
    }).trim();

    if (branchOutput) {
        return branchOutput.split(/\s+/)[0] ?? null;
    }

    return null;
};

export const updatePinnedActions = (
    deps: UpdatePinnedDeps = {},
): UpdatePinnedSummary => {
    const execSyncImpl = deps.execSyncImpl ?? execSync;
    const globSyncImpl = deps.globSyncImpl ?? fg.sync;
    const readFileSyncImpl = deps.readFileSyncImpl ?? fs.readFileSync;
    const writeFileSyncImpl = deps.writeFileSyncImpl ?? fs.writeFileSync;
    const log = deps.log ?? console.log;
    const exit = deps.exit ?? ((code: number): never => process.exit(code));

    const files = globSyncImpl([
        ".github/workflows/*.yml",
        ".github/workflows/*.yaml",
        ".github/actions/**/*.yml",
        ".github/actions/**/*.yaml",
        "actions/**/action.yml",
        "actions/**/action.yaml",
    ]);

    const seen = new Map<string, string | null>();

    for (const file of files) {
        const content = readFileSyncImpl(file, "utf-8");
        let match: RegExpExecArray | null;

        PINNED_RE.lastIndex = 0;
        while ((match = PINNED_RE.exec(content)) !== null) {
            const [, action, , ref] = match;
            seen.set(`${action}@${ref}`, null);
        }

        UNPINNED_RE.lastIndex = 0;
        while ((match = UNPINNED_RE.exec(content)) !== null) {
            const [, action, , ref] = match;
            seen.set(`${action}@${ref}`, null);
        }
    }

    if (seen.size === 0) {
        log("No action references found.");
        exit(0);
    }

    log(`Found ${seen.size} unique action reference(s). Resolving...\n`);

    let failures = 0;
    for (const key of seen.keys()) {
        const [action, ref] = key.split("@");
        if (!action || !ref) {
            continue;
        }

        log(`  Resolving ${action} @ ${ref}`);
        try {
            const sha = resolveRef(action, ref, execSyncImpl);
            if (!sha) {
                log(`    Could not resolve ref "${ref}" for ${action}`);
                failures += 1;
            } else {
                seen.set(key, sha);
                log(`    -> ${sha}`);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            log(`    Error resolving ${action}@${ref}: ${message}`);
            failures += 1;
        }
    }

    log("");

    let updatedFiles = 0;
    let updatedRefs = 0;
    let alreadyCurrent = 0;

    for (const file of files) {
        let content = readFileSyncImpl(file, "utf-8");
        let fileChanged = false;

        PINNED_RE.lastIndex = 0;
        content = content.replace(
            PINNED_RE,
            (
                full: string,
                action: string,
                oldSha: string,
                ref: string,
            ): string => {
                const newSha = seen.get(`${action}@${ref}`);
                if (!newSha || newSha === oldSha) {
                    if (newSha === oldSha) {
                        alreadyCurrent += 1;
                    }
                    return full;
                }
                log(`  ${file}: ${action}@${ref}`);
                log(`    ${oldSha} -> ${newSha}`);
                fileChanged = true;
                updatedRefs += 1;
                return `${action}@${newSha} # ${ref}`;
            },
        );

        UNPINNED_RE.lastIndex = 0;
        content = content.replace(
            UNPINNED_RE,
            (
                full: string,
                action: string,
                _unused: string,
                ref: string,
            ): string => {
                const newSha = seen.get(`${action}@${ref}`);
                if (!newSha) {
                    return full;
                }
                log(`  ${file}: ${action}@${ref} (unpinned)`);
                log(`    -> ${newSha} # ${ref}`);
                fileChanged = true;
                updatedRefs += 1;
                return `${action}@${newSha} # ${ref}`;
            },
        );

        if (fileChanged) {
            writeFileSyncImpl(file, content);
            updatedFiles += 1;
        }
    }

    log("");
    if (updatedRefs > 0) {
        log(
            `Updated ${updatedRefs} reference(s) across ${updatedFiles} file(s).`,
        );
    } else {
        log("All pinned actions are already up-to-date.");
    }
    if (alreadyCurrent > 0) {
        log(`   ${alreadyCurrent} reference(s) already current.`);
    }
    if (failures > 0) {
        log(`   ${failures} reference(s) could not be resolved.`);
        exit(1);
    }

    return {
        filesScanned: files.length,
        uniqueRefs: seen.size,
        updatedFiles,
        updatedRefs,
        alreadyCurrent,
        failures,
    };
};
