/**
 * Building a package consists of:
 *   * processing the action.yml to handle any references to other actions in
 *     this repo.
 *   * copying the package.json file into the dist/ folder (if one exists)
 *   * bundling the index.js into the dist/ folder using ncc (if one exists)
 */
import fs from "fs";
import path from "path";
import {execSync} from "child_process";
import fg from "fast-glob";
import yaml from "js-yaml";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const localActionRequirePathRegex = (name) =>
    new RegExp(`\\./actions/${escapeRegExp(name)}/`);
const localActionUsesValueRegex = /^\.\/actions\/([A-Za-z0-9._-]+)$/;

const appendDependencyTagToName = (nameValue, depTag) => {
    if (nameValue.includes(depTag)) {
        return nameValue;
    }
    const quoted = nameValue.match(/^(['"])(.*)\1$/);
    if (quoted) {
        const [, quote, inner] = quoted;
        return `${quote}${inner} (${depTag})${quote}`;
    }
    return `${nameValue} (${depTag})`;
};

const transformStrings = (value, replacer) => {
    if (typeof value === "string") {
        return replacer(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => transformStrings(item, replacer));
    }
    if (value && typeof value === "object") {
        const next = {};
        Object.entries(value).forEach(([key, entryValue]) => {
            next[key] = transformStrings(entryValue, replacer);
        });
        return next;
    }
    return value;
};

const rewriteIntraRepoUsesAndStepNames = (
    actionDoc,
    actionName,
    packageJsons,
    monorepoName,
    dependencyRefs,
) => {
    const steps = actionDoc?.runs?.steps;
    if (!Array.isArray(steps)) {
        return;
    }

    steps.forEach((step) => {
        if (
            !step ||
            typeof step !== "object" ||
            typeof step.uses !== "string"
        ) {
            return;
        }
        const match = step.uses.match(localActionUsesValueRegex);
        if (!match) {
            return;
        }
        const depName = match[1];
        console.log("    Processing dependency:", depName);

        if (!(depName in packageJsons)) {
            console.log("       Skipping (external dependency)");
            return;
        }

        const depRef = dependencyRefs[depName];
        if (!depRef?.sha) {
            throw new Error(
                `Missing published SHA for dependency "${depName}" used by "${actionName}"`,
            );
        }

        const target = `${monorepoName}@${depRef.sha}`;
        console.log(`      Replacing with: ${target}`);
        step.uses = target;

        const depTag = `${depName}-v${depRef.version}`;
        if (typeof step.name === "string") {
            step.name = appendDependencyTagToName(step.name, depTag);
        } else {
            step.name = depTag;
        }
    });
};

export const extractIntraRepoDependencies = (actionYml) => {
    const deps = new Set();
    const actionDoc = yaml.load(actionYml);
    const steps = actionDoc?.runs?.steps;
    if (!Array.isArray(steps)) {
        return [];
    }
    steps.forEach((step) => {
        if (
            !step ||
            typeof step !== "object" ||
            typeof step.uses !== "string"
        ) {
            return;
        }
        const match = step.uses.match(localActionUsesValueRegex);
        if (match) {
            deps.add(match[1]);
        }
    });
    return [...deps].sort();
};

export const processActionYml = (
    name,
    packageJsons,
    actionYml,
    monorepoName,
    dependencyRefs = {},
) => {
    console.log("  Processing action.yml for", name);
    let actionDoc = yaml.load(actionYml);
    actionDoc = transformStrings(actionDoc, (str) =>
        str.replace(
            localActionRequirePathRegex(name),
            "${{ github.action_path }}/",
        ),
    );

    rewriteIntraRepoUsesAndStepNames(
        actionDoc,
        name,
        packageJsons,
        monorepoName,
        dependencyRefs,
    );

    return yaml.dump(actionDoc, {
        lineWidth: -1,
        noRefs: true,
    });
};

/**
 * Copies all files matching the `sourcePath` to the output bundle folder
 * (dist/). Globs are supported and expanded with fast-glob.
 */
const bundleIfExists = (sourcePath) => {
    // We pass 'fs' here explicitly to support our unit tests. This way we can
    // mock 'fs' with 'memfs' and have fast-glob see that same set of files!
    for (const fp of fg.globSync(sourcePath, {fs})) {
        const targetPath = path.join(
            path.dirname(fp),
            "dist",
            path.basename(fp),
        );

        if (fs.existsSync(fp)) {
            console.log(`  Copying ${fp} to ${targetPath}`);
            fs.copyFileSync(fp, targetPath);
        }
    }
};

export const buildPackage = (
    name,
    packageJsons,
    monorepoName,
    dependencyRefs = {},
) => {
    const base = `actions/${name}`;
    const dist = `${base}/dist`;

    // Clean before starting the build
    if (fs.existsSync(dist)) {
        fs.rmdirSync(dist, {recursive: true});
    }
    fs.mkdirSync(dist, {recursive: true});

    bundleIfExists(`${base}/package.json`);
    bundleIfExists(`${base}/*.md`);

    // action.yml needs special handling
    const actionYml = fs.readFileSync(`${base}/action.yml`, "utf8");
    fs.writeFileSync(
        `${base}/dist/action.yml`,
        processActionYml(
            name,
            packageJsons,
            actionYml,
            monorepoName,
            dependencyRefs,
        ),
    );

    // JS code - bundled into a single file using `ncc`
    if (fs.existsSync(`${base}/index.js`)) {
        console.log(`  Building ${base}/index.js`);
        execSync(`pnpm ncc build ${base}/index.js -o ${dist} --source-map`);
    }

    return dist;
};
