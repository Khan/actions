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

export const publishDirectoryAsTags = (
    distPath,
    origin,
    tag,
    majorTag,
    dryRun,
) => {
    const cmds = [
        `git init .`,
        `git add .`,
        `git config user.email "khan-actions-bot@khanacademy.org"`,
        `git config user.name "Khan Actions Bot"`,
        `git commit -m publish`,
        `git remote add origin ${origin}`,
        `git tag ${tag}`,
        `git tag ${majorTag}`,
    ];
    if (!dryRun) {
        cmds.push(`git push origin ${tag}`);
        // This will succeed with a warning if the major tag doesn't exist
        cmds.push(`git push origin :refs/tags/${majorTag}`);
        cmds.push(`git push origin ${majorTag}`);
        cmds.push(`git push origin --tags`);
    }
    cmds.forEach((cmd) => {
        execSync(cmd, {cwd: distPath});
    });
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

export const publishAsNeeded = (packageNames, dryRun = false) => {
    // Because we rewrite our major version tags (filter-files-v1 for example)
    // on every patch & minor version publish, tags will move around, and -f
    // is needed if you have different tags locally.
    execSync(`git fetch --tags -f`);
    const origin = execSync(`git remote get-url origin`, {
        encoding: "utf8",
    }).trim();
    const packageJsons = collectPackageJsons(packageNames);

    packageNames.forEach((name) => {
        const version = packageJsons[name].version;
        const majorVersion = version.split(".")[0];
        const tag = `${name}-v${version}`;
        const majorTag = `${name}-v${majorVersion}`;
        if (!checkTag(tag)) {
            const distPath = buildPackage(name, packageJsons, `Khan/actions`);
            publishDirectoryAsTags(distPath, origin, tag, majorTag, dryRun);
        }
    });
};
