/**
 * This file determines which actions need to be published,
 * "builds" them, and "publishes" them as git tags on the current repo.
 * Building currently consists of checking the `action.yml`
 * for references to other actions in this repo and replacing them
 * with the appropriate pinned references.
 */
import fs from "fs";
import {execSync} from "child_process";
import {buildPackage} from "./build.mjs";

export const checkTag = (tag) => {
    try {
        execSync(`git show-ref --tags ${tag}`);
    } catch (err) {
        return false;
    }
    return true;
};

/**
 * Create a little git repo in the `actions/some-action/dist` directory,
 * which contains the built version of a given action.
 * We then push that bare commit as a tag to the `khan/actions` repo,
 * e.g. https://github.com/Khan/actions/tree/shared-node-cache-v0.2.4
 * which only contains the files for that one action.
 *
 * This is how we can have multiple actions in the same repo; normally
 * github's actions infra expects 1 action = 1 repo.
 * This way, when you do `uses: Khan/actions#shared-node-cachev0.2.4`
 * it looks like there actually is only one action in the repo.
 */
export const publishDirectoryAsTags = (
    distPath,
    origin,
    tag,
    majorTag,
    dryRun,
    auth,
) => {
    const cmds = [
        `git init .`,
        `git add .`,
        `git config user.email "khan-actions-bot@khanacademy.org"`,
        `git config user.name "Khan Actions Bot"`,
        auth
            ? `git config --local http.https://github.com/.extraheader "${auth}"`
            : null,
        `git commit -m publish`,
        `git remote add origin ${origin}`,
        `git fetch origin --tags`,
        `git tag ${tag}`,
        `git tag -f ${majorTag}`,
    ].filter(Boolean);
    if (!dryRun) {
        // This will succeed with a warning if the major tag doesn't exist
        cmds.push(`git push origin :refs/tags/${majorTag}`);
        cmds.push(`git push origin --tags`);
    }
    for (const cmd of cmds) {
        try {
            console.log(`  >> ${cmd}`);
            execSync(cmd, {cwd: distPath});
        } catch (err) {
            console.log(`Command ${cmd} failed :(`);
            return false;
        }
    }
    return true;
};

export const collectPackageJsons = (packageNames) => {
    const packageJsons = {};
    packageNames.forEach((name) => {
        const pkg = JSON.parse(
            fs.readFileSync(`actions/${name}/package.json`, "utf8"),
        );
        packageJsons[pkg.name] = pkg;
    });
    return packageJsons;
};

/**
 * Get the authentication information from the current git repo, if it exists.
 * Github's `actions/checkout` uses this `http.xyz.extraheader` local config thing
 * to store authentication info, and we need to grab it and add it to the
 * little bare repo we set up in `publishDirectoryAsTags`.
 */
const getAuth = () => {
    try {
        return execSync(
            `git config --local http.https://github.com/.extraheader`,
            {encoding: "utf-8"},
        ).trim();
    } catch (err) {
        return null;
    }
};

export const publishAsNeeded = (packageNames, dryRun = false) => {
    console.log(`Publishing (${dryRun ? "dry run" : "for real"})...`);

    // Because we rewrite our major version tags (filter-files-v1 for example)
    // on every patch & minor version publish, tags will move around, and -f
    // is needed if you have different tags locally.
    execSync(`git fetch --tags -f`);
    const origin = execSync(`git remote get-url origin`, {
        encoding: "utf8",
    }).trim();
    const auth = getAuth();
    const packageJsons = collectPackageJsons(packageNames);
    let failed = false;
    packageNames.forEach((name) => {
        const version = packageJsons[name].version;
        const majorVersion = version.split(".")[0];
        const tag = `${name}-v${version}`;
        const majorTag = `${name}-v${majorVersion}`;
        if (!checkTag(tag)) {
            const distPath = buildPackage(name, packageJsons, `Khan/actions`);
            console.log(`Publishing ${tag} in ${distPath}`);
            const success = publishDirectoryAsTags(
                distPath,
                origin,
                tag,
                majorTag,
                dryRun,
                auth,
            );
            if (success) {
                console.log(`Finished publishing ${tag}`);
            } else {
                console.log(`Failed to publish ${tag}`);
                failed = true;
            }

            console.log();
        }
    });
    if (failed) {
        process.exit(1);
    }
};
