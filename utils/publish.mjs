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

export const publishDirectoryAsTag = (distPath, origin, tag, dryRun) => {
    const cmds = [
        `git init .`,
        `git add .`,
        `git commit -m publish`,
        `git remote add origin ${origin}`,
        `git tag ${tag}`,
    ];
    if (!dryRun) {
        cmds.push(`git push origin ${tag}`);
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
    execSync(`git fetch --tags`);
    const origin = execSync(`git remote get-url origin`, {
        encoding: "utf8",
    }).trim();
    const packageJsons = collectPackageJsons(packageNames);

    packageNames.forEach((name) => {
        const version = packageJsons[name].version;
        const tag = `${name}-v${version}`;
        if (!checkTag(tag)) {
            const distPath = buildPackage(name, packageJsons, `Khan/actions`);
            publishDirectoryAsTag(distPath, origin, tag, dryRun);
        }
    });
};
