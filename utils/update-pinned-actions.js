/**
 * Scan all workflow and action YAML files for pinned GitHub Action references
 * (format: `uses: owner/repo@<sha> # <tag>`) and update any stale SHAs by
 * resolving the tag/branch via `git ls-remote`.
 *
 * Usage: node utils/update-pinned-actions.js
 */
import fs from "fs";
import {execSync} from "child_process";
import fg from "fast-glob";

const PINNED_RE = /(?<=uses:\s+)([^@\s]+)@([a-f0-9]{40})\s+#\s*(\S+)/g;

/**
 * Resolve a tag or branch to its commit SHA via git ls-remote.
 * For annotated tags the dereferenced (^{}) commit SHA is returned.
 */
const resolveRef = (action, ref) => {
    const url = `https://github.com/${action}.git`;

    // Try tags first (covers both lightweight and annotated)
    const tagOutput = execSync(`git ls-remote --tags ${url} ${ref} ${ref}^{}`, {
        encoding: "utf-8",
    }).trim();

    if (tagOutput) {
        const lines = tagOutput.split("\n");
        // If there's a ^{} line it's an annotated tag — use the deref SHA
        const deref = lines.find((l) => l.includes("^{}"));
        if (deref) {
            return deref.split(/\s+/)[0];
        }
        return lines[0].split(/\s+/)[0];
    }

    // Fall back to branches
    const branchOutput = execSync(`git ls-remote --heads ${url} ${ref}`, {
        encoding: "utf-8",
    }).trim();

    if (branchOutput) {
        return branchOutput.split(/\s+/)[0];
    }

    return null;
};

// -- main -------------------------------------------------------------------

const files = fg.sync([
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    "actions/*/action.yml",
    "actions/*/action.yaml",
]);

// Collect unique action+ref pairs across all files
// eslint-disable-next-line no-undef
const seen = new Map(); // key: "action@ref" → resolved SHA (filled later)

for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    let m;
    PINNED_RE.lastIndex = 0;
    while ((m = PINNED_RE.exec(content)) !== null) {
        const [, action, , ref] = m;
        seen.set(`${action}@${ref}`, null);
    }
}

if (seen.size === 0) {
    console.log("No pinned action references found.");
    process.exit(0);
}

console.log(`Found ${seen.size} unique pinned action(s). Resolving…\n`);

// Resolve each unique action+ref
let failures = 0;
for (const key of seen.keys()) {
    const [action, ref] = key.split("@");
    console.log(`  Resolving ${action} @ ${ref}`);
    try {
        const sha = resolveRef(action, ref);
        if (!sha) {
            console.log(`    ⚠  Could not resolve ref "${ref}" for ${action}`);
            failures++;
        } else {
            seen.set(key, sha);
            console.log(`    → ${sha}`);
        }
    } catch (err) {
        console.log(`    ⚠  Error resolving ${action}@${ref}: ${err.message}`);
        failures++;
    }
}

console.log("");

// Update files in-place
let updatedFiles = 0;
let updatedRefs = 0;
let alreadyCurrent = 0;

for (const file of files) {
    let content = fs.readFileSync(file, "utf-8");
    let fileChanged = false;

    PINNED_RE.lastIndex = 0;
    content = content.replace(PINNED_RE, (match, action, oldSha, ref) => {
        const newSha = seen.get(`${action}@${ref}`);
        if (!newSha || newSha === oldSha) {
            if (newSha === oldSha) {
                alreadyCurrent++;
            }
            return match;
        }
        console.log(`  ${file}: ${action}@${ref}`);
        console.log(`    ${oldSha} → ${newSha}`);
        fileChanged = true;
        updatedRefs++;
        return `${action}@${newSha} # ${ref}`;
    });

    if (fileChanged) {
        fs.writeFileSync(file, content);
        updatedFiles++;
    }
}

// Summary
console.log("");
if (updatedRefs > 0) {
    console.log(
        `🏁 Updated ${updatedRefs} reference(s) across ${updatedFiles} file(s).`,
    );
} else {
    console.log("🏁 All pinned actions are already up-to-date.");
}
if (alreadyCurrent > 0) {
    console.log(`   ${alreadyCurrent} reference(s) already current.`);
}
if (failures > 0) {
    console.log(`   ⚠  ${failures} reference(s) could not be resolved.`);
    process.exit(1);
}
