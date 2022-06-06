/**
 * Building a package currently only consists of processing
 * the action.yml to handle any references to other actions in
 * this repo.
 */
import fs from "fs";
import path from "path";

function copyDir(src, dest) {
    const entries = fs.readdirSync(src, {withFileTypes: true});
    fs.mkdirSync(dest, {recursive: true});

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

export const processActionYml = (
    name,
    packageJsons,
    actionYml,
    monorepoName,
) => {
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
    const allActionNames = Object.keys(packageJsons);
    // For each of the other actions, replace any local-path references to it
    // to a normal action reference, locked to the current latest version.
    allActionNames.forEach((actionName) => {
        replacements.push({
            from: new RegExp(`\\buses: \\./actions/${actionName}\\b`, "g"),
            to: `uses: ${monorepoName}@${actionName}-v${packageJsons[actionName].version}`,
        });
    });
    replacements.forEach(({from, to}) => {
        actionYml = actionYml.replace(from, to);
    });

    return actionYml;
};

export const buildPackage = (name, packageJsons, monorepoName) => {
    const dist = `actions/${name}/dist`;
    if (fs.existsSync(dist)) {
        fs.rmSync(dist, {recursive: true});
    }
    copyDir(`actions/${name}`, dist);
    const yml = `actions/${name}/dist/action.yml`;
    const actionYml = fs.readFileSync(yml, "utf8");
    fs.writeFileSync(
        yml,
        processActionYml(name, packageJsons, actionYml, monorepoName),
    );
    return dist;
};
