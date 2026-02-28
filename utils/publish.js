/**
 * This file determines which actions need to be published,
 * "builds" them, and "publishes" them as git tags on the current repo.
 * Building currently consists of checking the `action.yml`
 * for references to other actions in this repo and replacing them
 * with the appropriate pinned references.
 */
import fs from "fs";
import {execFileSync, execSync} from "child_process";
import {buildPackage, extractIntraRepoDependencies} from "./build.js";

/**
 * Returns true if the given tag exists, false otherwise.
 *
 * The publish process uses this check to determine if an action needs to be
 * built/published.
 */
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
export const publishDirectoryAsTags = (distPath, origin, tag, dryRun, auth) => {
    let publishSha = null;
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
    ].filter(Boolean);
    if (!dryRun) {
        cmds.push(`git push origin --tags`);
    }
    for (const cmd of cmds) {
        try {
            console.log(`  >> ${cmd}`);
            execSync(cmd, {cwd: distPath});
            if (cmd === `git commit -m publish`) {
                publishSha = execSync(`git rev-parse HEAD`, {
                    cwd: distPath,
                    encoding: "utf8",
                }).trim();
            }
        } catch (err) {
            console.log(`Command ${cmd} failed :(`);
            return null;
        }
    }
    return {sha: publishSha};
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

export const collectIntraRepoDependencyGraph = (packageNames) => {
    const packageSet = new Set(packageNames);
    const graph = {};
    packageNames.forEach((name) => {
        const actionYml = fs.readFileSync(`actions/${name}/action.yml`, "utf8");
        const deps = extractIntraRepoDependencies(actionYml).filter((depName) =>
            packageSet.has(depName),
        );
        graph[name] = deps.sort();
    });
    return graph;
};

export const findDependencyCycle = (graph) => {
    const visited = new Set();
    const visiting = new Set();
    const indexByNode = new Map();
    const stack = [];

    const dfs = (name) => {
        visiting.add(name);
        indexByNode.set(name, stack.length);
        stack.push(name);

        for (const depName of graph[name] ?? []) {
            if (visiting.has(depName)) {
                const idx = indexByNode.get(depName);
                return [...stack.slice(idx), depName];
            }
            if (!visited.has(depName)) {
                const cycle = dfs(depName);
                if (cycle) {
                    return cycle;
                }
            }
        }

        stack.pop();
        indexByNode.delete(name);
        visiting.delete(name);
        visited.add(name);
        return null;
    };

    const names = Object.keys(graph).sort();
    for (const name of names) {
        if (visited.has(name)) {
            continue;
        }
        const cycle = dfs(name);
        if (cycle) {
            return cycle;
        }
    }
    return null;
};

export const topologicallySortActions = (graph) => {
    const inDegree = {};
    const dependents = {};
    const names = Object.keys(graph).sort();
    names.forEach((name) => {
        inDegree[name] = graph[name].length;
        dependents[name] = [];
    });

    names.forEach((name) => {
        graph[name].forEach((depName) => {
            dependents[depName].push(name);
        });
    });
    names.forEach((name) => dependents[name].sort());

    const queue = names.filter((name) => inDegree[name] === 0).sort();
    const sorted = [];

    while (queue.length > 0) {
        const name = queue.shift();
        sorted.push(name);
        dependents[name].forEach((dependent) => {
            inDegree[dependent] -= 1;
            if (inDegree[dependent] === 0) {
                queue.push(dependent);
                queue.sort();
            }
        });
    }

    if (sorted.length !== names.length) {
        throw new Error(`Failed topological sort; graph is not a DAG`);
    }
    return sorted;
};

const parseMonorepoName = (origin) => {
    const scpMatch = origin.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (scpMatch) {
        return scpMatch[1];
    }
    const httpsMatch = origin.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (httpsMatch) {
        return httpsMatch[1];
    }
    throw new Error(`Unable to determine monorepo name from origin: ${origin}`);
};

const parseSemver = (version) => {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
        return null;
    }
    return match.slice(1).map((x) => Number(x));
};

const compareSemver = (a, b) => {
    for (let i = 0; i < a.length; i++) {
        if (a[i] > b[i]) {
            return 1;
        }
        if (a[i] < b[i]) {
            return -1;
        }
    }
    return 0;
};

const fetchJson = (url, githubToken) => {
    const args = [
        "-sSfL",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: khan-actions-publisher",
    ];
    if (githubToken) {
        args.push("-H", `Authorization: Bearer ${githubToken}`);
    }
    args.push(url);
    const output = execFileSync("curl", args, {encoding: "utf8"});
    return JSON.parse(output);
};

export const lookupLatestPublishedActionRef = (
    monorepoName,
    actionName,
    githubToken,
    cache,
) => {
    if (cache[actionName]) {
        return cache[actionName];
    }

    const prefix = `${actionName}-v`;
    let page = 1;
    let best = null;

    while (true) {
        const tags = fetchJson(
            `https://api.github.com/repos/${monorepoName}/tags?per_page=100&page=${page}`,
            githubToken,
        );
        if (!Array.isArray(tags) || tags.length === 0) {
            break;
        }

        tags.forEach((tagObj) => {
            const tagName = tagObj.name ?? "";
            if (!tagName.startsWith(prefix)) {
                return;
            }
            const version = tagName.slice(prefix.length);
            const parsed = parseSemver(version);
            if (!parsed) {
                return;
            }
            if (!best || compareSemver(parsed, best.parsed) > 0) {
                best = {
                    sha: tagObj.commit.sha,
                    version,
                    parsed,
                };
            }
        });

        if (tags.length < 100) {
            break;
        }
        page += 1;
    }

    if (!best?.sha) {
        throw new Error(
            `Could not find an existing published SHA for dependency "${actionName}"`,
        );
    }

    const ref = {sha: best.sha, version: best.version};
    cache[actionName] = ref;
    return ref;
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
    const monorepoName = parseMonorepoName(origin);
    const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const auth = getAuth();
    const allPackageNames = fs
        .readdirSync("actions")
        .filter((name) => fs.statSync(`actions/${name}`).isDirectory());
    const packageJsons = collectPackageJsons(allPackageNames);
    const graph = collectIntraRepoDependencyGraph(allPackageNames);
    const cycle = findDependencyCycle(graph);
    if (cycle) {
        throw new Error(
            `Detected intra-repo action dependency cycle: ${cycle.join(
                " -> ",
            )}`,
        );
    }

    const publishOrder = topologicallySortActions(graph);
    const selectedSet = new Set(packageNames);
    const publishedRefs = {};
    const knownPublishedRefs = {};
    let failed = false;
    publishOrder.forEach((name) => {
        if (!selectedSet.has(name)) {
            return;
        }
        console.log(`Processing ${name}...`);
        const version = packageJsons[name].version;
        const tag = `${name}-v${version}`;
        const dependencyRefs = {};

        (graph[name] ?? []).forEach((depName) => {
            dependencyRefs[depName] =
                publishedRefs[depName] ??
                lookupLatestPublishedActionRef(
                    monorepoName,
                    depName,
                    githubToken,
                    knownPublishedRefs,
                );
        });

        if (checkTag(tag)) {
            console.log(`  Version ${tag} already exists. Nothing to do.`);
        } else {
            const distPath = buildPackage(
                name,
                packageJsons,
                monorepoName,
                dependencyRefs,
            );
            console.log(`  Publishing ${tag} in ${distPath}`);
            const publishResult = publishDirectoryAsTags(
                distPath,
                origin,
                tag,
                dryRun,
                auth,
            );
            if (publishResult?.sha) {
                publishedRefs[name] = {sha: publishResult.sha, version};
                knownPublishedRefs[name] = publishedRefs[name];
                console.log(`🏁  Finished publishing ${tag}`);
            } else {
                console.log(`🚨  Failed to publish ${tag}`);
                failed = true;
            }
        }

        console.log();
    });
    if (failed) {
        process.exit(1);
    }
};
