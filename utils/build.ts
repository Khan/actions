/**
 * Building a package consists of:
 *   * processing the action.yml to handle any references to other actions in
 *     this repo.
 *   * copying the package.json file into the dist/ folder (if one exists)
 *   * bundling the action entrypoint into the dist/ folder using ncc
 */
import * as fs from "fs";
import path from "path";
import {execSync} from "child_process";
import fg from "fast-glob";

const escapeRegExp = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type DependencyRef = {
    sha: string;
    version: string;
};

export type DependencyRefs = Record<string, DependencyRef>;

export type PackageJsonLike = {
    name?: string;
    version: string;
    dependencies?: Record<string, string>;
};

export type PackageJsonMap = Record<string, PackageJsonLike>;

const localActionUsesRegex = (actionNamePattern: string) =>
    // matches `uses: ./actions/some-action`
    new RegExp(`\\buses:\\s*\\.\\/actions\\/${actionNamePattern}\\b`, "g");

const localActionRequirePathRegex = (name: string) =>
    new RegExp(`\\./actions/${escapeRegExp(name)}/`);

export const extractIntraRepoDependencies = (actionYml: string): string[] => {
    const deps = new Set<string>();
    let match;
    const usesRegex = localActionUsesRegex(`([A-Za-z0-9._-]+)`);
    while ((match = usesRegex.exec(actionYml)) !== null) {
        deps.add(match[1]!);
    }
    return [...deps].sort();
};

export const processActionYml = (
    name: string,
    packageJsons: PackageJsonMap,
    actionYml: string,
    monorepoName: string,
    dependencyRefs: DependencyRefs = {},
): string => {
    console.log("  Processing action.yml for", name);
    // This first replacement is to rewrite local requires, in the case where we have
    // a github-script action with e.g. `require('./actions/my-action/index.js')`, and turning
    // it into `require('${{ github.action_path }}/index.js')`. Writing it this way means it
    // will work in this repo without publishing (so our workflows can use it directly), and
    // then we do this replacement when publishing so it will work there too.
    // See https://docs.github.com/en/actions/learn-github-actions/contexts#github-context
    const replacements = [
        {
            from: localActionRequirePathRegex(name),
            to: "${{ github.action_path }}/",
        },
    ];

    extractIntraRepoDependencies(actionYml).forEach((depName) => {
        console.log("    Processing dependency:", depName);
        if (depName in packageJsons) {
            const depRef = dependencyRefs[depName];
            if (!depRef?.sha) {
                throw new Error(
                    `Missing published SHA for dependency "${depName}" used by "${name}"`,
                );
            }
            const target = `${monorepoName}@${depRef.sha} # ${depName}-v${depRef.version}`;
            console.log(`      Replacing with: ${target}`);
            replacements.push({
                from: localActionUsesRegex(escapeRegExp(depName)),
                to: `uses: ${target}`,
            });
        } else {
            console.log("       Skipping (external dependency)");
        }
    });
    replacements.forEach(({from, to}) => {
        actionYml = actionYml.replace(from, to);
    });

    return actionYml;
};

/**
 * Copies all files matching the `sourcePath` to the output bundle folder
 * (dist/). Globs are supported and expanded with fast-glob.
 */
const bundleIfExists = (sourcePath: string): void => {
    // We pass 'fs' here explicitly to support our unit tests. This way we can
    // mock 'fs' with 'memfs' and have fast-glob see that same set of files.
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

const findActionEntrypoint = (base: string): string | null => {
    const tsEntrypoint = `${base}/index.ts`;
    if (fs.existsSync(tsEntrypoint)) {
        return tsEntrypoint;
    }

    const jsEntrypoint = `${base}/index.js`;
    if (fs.existsSync(jsEntrypoint)) {
        return jsEntrypoint;
    }

    return null;
};

export const buildPackage = (
    name: string,
    packageJsons: PackageJsonMap,
    monorepoName: string,
    dependencyRefs: DependencyRefs = {},
): string => {
    const base = `actions/${name}`;
    const dist = `${base}/dist`;

    // Clean before starting the build
    if (fs.existsSync(dist)) {
        fs.rmSync(dist, {recursive: true, force: true});
    }
    fs.mkdirSync(dist, {recursive: true});

    bundleIfExists(`${base}/package.json`);
    bundleIfExists(`${base}/*.md`);
    bundleIfExists(`${base}/*.js`);
    bundleIfExists(`${base}/*.conf`);

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

    const entrypoint = findActionEntrypoint(base);
    if (entrypoint) {
        console.log(`  Building ${entrypoint}`);
        execSync(`pnpm ncc build ${entrypoint} -o ${dist} --source-map`);
    }

    return dist;
};
