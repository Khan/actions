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
    const replacements = [{from: new RegExp(`\\./actions/${name}/`), to: "./"}];
    Object.keys(packageJsons[name].dependencies || {}).forEach((depName) => {
        replacements.push({
            from: new RegExp(`\\buses: \\./actions/${depName}\\b`, "g"),
            to: `uses: ${monorepoName}@${depName}-v${packageJsons[depName].version}`,
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
