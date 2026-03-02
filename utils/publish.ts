/**
 * This file determines which actions need to be published,
 * "builds" them, and "publishes" them as git tags on the current repo.
 * Building currently consists of checking the `action.yml`
 * for references to other actions in this repo and replacing them
 * with the appropriate pinned references.
 */
import fs from "fs";
import {execSync} from "child_process";
import {
    buildPackage,
    extractIntraRepoDependencies,
    type DependencyRef,
    type PackageJsonLike,
    type PackageJsonMap,
} from "./build.ts";

type DependencyGraph = Record<string, string[]>;
type PublishedRefCache = Record<string, DependencyRef>;

type GitObjectRef = {
    type: string;
    sha: string;
};

type GitMatchingRef = {
    ref: string;
    object?: GitObjectRef;
};

type GitTagResponse = {
    object?: GitObjectRef;
};

/**
 * Returns true if the given tag exists, false otherwise.
 *
 * The publish process uses this check to determine if an action needs to be
 * built/published.
 */
export const checkTag = (tag: string): boolean => {
    try {
        execSync(`git show-ref --tags ${tag}`);
    } catch {
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
    distPath: string,
    origin: string,
    tag: string,
    dryRun: boolean,
    auth: string | null,
): {sha: string | null} | null => {
    let publishSha: string | null = null;
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
    ].filter((value): value is string => Boolean(value));

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
        } catch {
            console.log(`Command ${cmd} failed :(`);
            return null;
        }
    }

    return {sha: publishSha};
};

export const collectPackageJsons = (packageNames: string[]): PackageJsonMap => {
    const packageJsons: PackageJsonMap = {};
    packageNames.forEach((name) => {
        const pkg = JSON.parse(
            fs.readFileSync(`actions/${name}/package.json`, "utf8"),
        ) as PackageJsonLike;
        if (!pkg.name) {
            throw new Error(`Missing name in actions/${name}/package.json`);
        }
        packageJsons[pkg.name] = pkg;
    });
    return packageJsons;
};

export const collectIntraRepoDependencyGraph = (
    packageNames: string[],
): DependencyGraph => {
    const packageSet = new Set(packageNames);
    const graph: DependencyGraph = {};

    packageNames.forEach((name) => {
        const actionYml = fs.readFileSync(`actions/${name}/action.yml`, "utf8");
        const deps = extractIntraRepoDependencies(actionYml).filter((depName) =>
            packageSet.has(depName),
        );
        graph[name] = deps.sort();
    });

    return graph;
};

export const findDependencyCycle = (
    graph: DependencyGraph,
): string[] | null => {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const indexByNode = new Map<string, number>();
    const stack: string[] = [];

    const dfs = (name: string): string[] | null => {
        visiting.add(name);
        indexByNode.set(name, stack.length);
        stack.push(name);

        for (const depName of graph[name] ?? []) {
            if (visiting.has(depName)) {
                const idx = indexByNode.get(depName);
                if (idx === undefined) {
                    return [depName, depName];
                }
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

export const topologicallySortActions = (graph: DependencyGraph): string[] => {
    const inDegree: Record<string, number> = {};
    const dependents: Record<string, string[]> = {};
    const names = Object.keys(graph).sort();

    names.forEach((name) => {
        inDegree[name] = graph[name]?.length ?? 0;
        dependents[name] = [];
    });

    names.forEach((name) => {
        (graph[name] ?? []).forEach((depName) => {
            dependents[depName]?.push(name);
        });
    });
    names.forEach((name) => {
        dependents[name]?.sort();
    });

    const queue = names.filter((name) => inDegree[name] === 0).sort();
    const sorted: string[] = [];

    while (queue.length > 0) {
        const name = queue.shift();
        if (!name) {
            break;
        }

        sorted.push(name);
        (dependents[name] ?? []).forEach((dependent) => {
            const nextInDegree = (inDegree[dependent] ?? 0) - 1;
            inDegree[dependent] = nextInDegree;
            if (nextInDegree === 0) {
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

const parseMonorepoName = (origin: string): string => {
    const scpMatch = origin.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (scpMatch) {
        const repo = scpMatch[1];
        if (repo) {
            return repo;
        }
    }

    const httpsMatch = origin.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (httpsMatch) {
        const repo = httpsMatch[1];
        if (repo) {
            return repo;
        }
    }

    throw new Error(`Unable to determine monorepo name from origin: ${origin}`);
};

const fetchJson = async <T>(url: string, githubToken?: string): Promise<T> => {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "khan-actions-publisher",
    };
    if (githubToken) {
        headers.Authorization = `Bearer ${githubToken}`;
    }

    const response = await fetch(url, {headers});
    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `GitHub API request failed (${response.status} ${response.statusText}) for ${url}: ${body}`,
        );
    }

    return (await response.json()) as T;
};

const resolveGitObjectToCommitSha = async (
    monorepoName: string,
    object: GitObjectRef,
    githubToken?: string,
): Promise<string> => {
    let current: GitObjectRef | undefined = object;
    let depth = 0;

    while (current?.type === "tag" && depth < 5) {
        const tagObj: GitTagResponse = await fetchJson<GitTagResponse>(
            `https://api.github.com/repos/${monorepoName}/git/tags/${current.sha}`,
            githubToken,
        );
        current = tagObj.object;
        depth += 1;
    }

    if (current?.type !== "commit" || !current.sha) {
        throw new Error(`Could not resolve tag object to commit SHA`);
    }

    return current.sha;
};

export const lookupPublishedActionRef = async (
    monorepoName: string,
    actionName: string,
    version: string,
    githubToken: string | undefined,
    cache: PublishedRefCache,
): Promise<DependencyRef> => {
    const cacheKey = `${actionName}@${version}`;
    if (cache[cacheKey]) {
        return cache[cacheKey];
    }

    const tag = `${actionName}-v${version}`;
    const refs = await fetchJson<GitMatchingRef[]>(
        `https://api.github.com/repos/${monorepoName}/git/matching-refs/tags/${tag}`,
        githubToken,
    );

    const exactRef = (Array.isArray(refs) ? refs : []).find(
        (ref) => ref.ref === `refs/tags/${tag}`,
    );
    if (!exactRef?.object) {
        throw new Error(
            `Could not find published tag "${tag}" for dependency "${actionName}"`,
        );
    }

    // We fetch from github because local git data might not have the tag present.
    const sha = await resolveGitObjectToCommitSha(
        monorepoName,
        exactRef.object,
        githubToken,
    );
    const ref = {sha, version};
    cache[cacheKey] = ref;
    return ref;
};

/**
 * Get the authentication information from the current git repo, if it exists.
 * Github's `actions/checkout` uses this `http.xyz.extraheader` local config thing
 * to store authentication info, and we need to grab it and add it to the
 * little bare repo we set up in `publishDirectoryAsTags`.
 */
const getAuth = (): string | null => {
    try {
        return execSync(
            `git config --local http.https://github.com/.extraheader`,
            {
                encoding: "utf-8",
            },
        ).trim();
    } catch {
        return null;
    }
};

export const publishAsNeeded = async (
    packageNames: string[],
    dryRun = false,
): Promise<void> => {
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
    const publishedRefs: PublishedRefCache = {};
    const knownPublishedRefs: PublishedRefCache = {};
    let failed = false;

    for (const name of publishOrder) {
        if (!selectedSet.has(name)) {
            continue;
        }

        console.log(`Processing ${name}...`);
        const actionPkg = packageJsons[name];
        if (!actionPkg?.version) {
            throw new Error(`No package metadata found for action "${name}"`);
        }

        const version = actionPkg.version;
        const tag = `${name}-v${version}`;
        const dependencyRefs: Record<string, DependencyRef> = {};

        for (const depName of graph[name] ?? []) {
            const depVersion = packageJsons[depName]?.version;
            if (!depVersion) {
                throw new Error(
                    `Missing version for dependency action "${depName}"`,
                );
            }
            dependencyRefs[depName] =
                publishedRefs[depName] ??
                (await lookupPublishedActionRef(
                    monorepoName,
                    depName,
                    depVersion,
                    githubToken,
                    knownPublishedRefs,
                ));
        }

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
    }

    if (failed) {
        process.exit(1);
    }
};
