/**
 * Building a package consists of:
 *   * processing the action.ym l to handle any references to other actions in
 *     this repo.
 *   * copying the package.json file into the dist/ folder (if one exists)
 *   * bundling the index.js into the dist/ folder using ncc (if one exists)
 */
import fs from "fs";
import {execSync} from "child_process";

export const processActionYml = (
    name,
    packageJsons,
    actionYml,
    monorepoName,
) => {
    console.log("Processing action.yml for", name);
    // This first replacement is to rewrite local requires, in the case where we have
    // a github-script action with e.g. `require('./actions/my-action/index.js')`, and turning
    // it into `require('${{ github.action_path }}/index.js')`. Writing it this way means it
    // will work in this repo without publishing (so our workflows can use it directly), and
    // then we do this replacement when publishing so it will work there too.
    // See https://docs.github.com/en/actions/learn-github-actions/contexts#github-context
    const replacements = [
        {
            from: new RegExp(`\\./actions/${name}/`),
            to: "${{ github.action_path }}/",
        },
    ];
    Object.keys(packageJsons[name].dependencies ?? {}).forEach((depName) => {
        console.log("  Processing dependency:", depName);
        if (depName in packageJsons) {
            const target = `${monorepoName}@${depName}-v${packageJsons[depName].version}`;
            console.log(`    Replacing with: ${target}`);
            replacements.push({
                from: new RegExp(`\\buses: \\./actions/${depName}\\b`, "g"),
                to: `uses: ${target}`,
            });
        } else {
            console.log("     Skipping (external dependency)");
        }
    });
    replacements.forEach(({from, to}) => {
        actionYml = actionYml.replace(from, to);
    });

    return actionYml;
};

export const buildPackage = (name, packageJsons, monorepoName) => {
    const base = `actions/${name}`;
    const dist = `${base}/dist`;

    if (fs.existsSync(dist)) {
        fs.rmSync(dist, {recursive: true});
    }
    fs.mkdirSync(dist);

    // package.json
    if (fs.existsSync(`${base}/package.json`)) {
        fs.copyFileSync(`${base}/package.json`, `${dist}/package.json`);
    }

    // action.yml
    const actionYml = fs.readFileSync(`${base}/action.yml`, "utf8");
    fs.writeFileSync(
        `${base}/dist/action.yml`,
        processActionYml(name, packageJsons, actionYml, monorepoName),
    );

    // JS code
    if (fs.existsSync(`${base}/index.js`)) {
        console.log(`Building ${base}/index.js`);
        execSync(`pnpm ncc build ${base}/index.js -o ${dist} --source-map`);
    }

    return dist;
};
