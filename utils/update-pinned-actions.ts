/**
 * Scan all workflow and action YAML files for GitHub Action references and
 * ensure they are pinned to commit SHAs. Handles two cases:
 *   1. Already pinned (`uses: owner/repo@<sha> # <tag>`) — updates stale SHAs
 *   2. Unpinned (`uses: owner/repo@<tag>`) — replaces with `@<sha> # <tag>`
 *
 * Usage: node utils/update-pinned-actions.ts
 */
import fs from "fs";
import {execSync} from "child_process";
import fg from "fast-glob";

// Matches already-pinned: `owner/repo@<sha> # <tag>`
const PINNED_RE = /(?<=uses:\s+)([^@\s]+)@([a-f0-9]{40})\s+#\s*(\S+)/g;

// Matches unpinned: `owner/repo@<tag>` (where tag is NOT a 40-char hex SHA)
// Excludes local actions (starting with ./)
const UNPINNED_RE = /(?<=uses:\s+)((?!\.\/).+\/.+)@(?!([a-f0-9]{40})\s)(\S+)/g;

/**
 * Resolve a tag or branch to its commit SHA via git ls-remote.
 * For annotated tags the dereferenced (^{}) commit SHA is returned.
 */
const resolveRef = (action: string, ref: string): string | null => {
    const url = `https://github.com/${action}.git`;

    // Try tags first (covers both lightweight and annotated)
    const tagOutput = execSync(`git ls-remote --tags ${url} ${ref} ${ref}^{}`, {
        encoding: "utf-8",
    }).trim();

    if (tagOutput) {
        const lines = tagOutput.split("\n");
        // If there's a ^{} line it's an annotated tag — use the deref SHA
        const deref = lines.find((line) => line.includes("^{}"));
        if (deref) {
            return deref.split(/\s+/)[0] ?? null;
        }
        return lines[0]?.split(/\s+/)[0] ?? null;
    }

    // Fall back to branches
    const branchOutput = execSync(`git ls-remote --heads ${url} ${ref}`, {
        encoding: "utf-8",
    }).trim();

    if (branchOutput) {
        return branchOutput.split(/\s+/)[0] ?? null;
    }

    return null;
};

const files = fg.sync([
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ".github/actions/**/*.yml",
    ".github/actions/**/*.yaml",
    "actions/**/action.yml",
    "actions/**/action.yaml",
]);

// key: "action@ref" -> resolved SHA (filled later)
const seen = new Map<string, string | null>();

for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
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
    console.log("No action references found.");
    process.exit(0);
}

console.log(`Found ${seen.size} unique action reference(s). Resolving...\n`);

let failures = 0;
for (const key of seen.keys()) {
    const [action, ref] = key.split("@");
    if (!action || !ref) {
        continue;
    }

    console.log(`  Resolving ${action} @ ${ref}`);
    try {
        const sha = resolveRef(action, ref);
        if (!sha) {
            console.log(`    Could not resolve ref "${ref}" for ${action}`);
            failures += 1;
        } else {
            seen.set(key, sha);
            console.log(`    -> ${sha}`);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`    Error resolving ${action}@${ref}: ${message}`);
        failures += 1;
    }
}

console.log("");

let updatedFiles = 0;
let updatedRefs = 0;
let alreadyCurrent = 0;

for (const file of files) {
    let content = fs.readFileSync(file, "utf-8");
    let fileChanged = false;

    PINNED_RE.lastIndex = 0;
    content = content.replace(
        PINNED_RE,
        (full: string, action: string, oldSha: string, ref: string): string => {
            const newSha = seen.get(`${action}@${ref}`);
            if (!newSha || newSha === oldSha) {
                if (newSha === oldSha) {
                    alreadyCurrent += 1;
                }
                return full;
            }
            console.log(`  ${file}: ${action}@${ref}`);
            console.log(`    ${oldSha} -> ${newSha}`);
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
            console.log(`  ${file}: ${action}@${ref} (unpinned)`);
            console.log(`    -> ${newSha} # ${ref}`);
            fileChanged = true;
            updatedRefs += 1;
            return `${action}@${newSha} # ${ref}`;
        },
    );

    if (fileChanged) {
        fs.writeFileSync(file, content);
        updatedFiles += 1;
    }
}

console.log("");
if (updatedRefs > 0) {
    console.log(
        `Updated ${updatedRefs} reference(s) across ${updatedFiles} file(s).`,
    );
} else {
    console.log("All pinned actions are already up-to-date.");
}
if (alreadyCurrent > 0) {
    console.log(`   ${alreadyCurrent} reference(s) already current.`);
}
if (failures > 0) {
    console.log(`   ${failures} reference(s) could not be resolved.`);
    process.exit(1);
}
