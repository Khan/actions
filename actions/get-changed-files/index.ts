type RepoCompareFile = {
    filename: string;
    status: string;
};

type PullRequestSummary = {
    number: number;
    title: string;
    base: {
        sha: string;
    };
};

type GithubLike = {
    rest: {
        repos: {
            listPullRequestsAssociatedWithCommit: (args: {
                owner: string;
                repo: string;
                commit_sha: string;
            }) => Promise<{data: PullRequestSummary[]}>;
            compareCommits: (args: {
                base: string;
                head: string;
                owner: string;
                repo: string;
            }) => Promise<{status: number; data: {files: RepoCompareFile[]}}>;
        };
    };
};

type ContextLike = {
    eventName: string;
    payload: {
        pull_request?: {
            base?: {ref?: string};
            head?: {sha?: string};
        };
        before?: string;
        after?: string;
        repository: {
            owner: {name: string};
            name: string;
        };
        merge_group?: {
            base_sha: string;
            head_sha: string;
        };
    };
    repo: {
        owner: string;
        repo: string;
    };
};

type CoreLike = {
    warn: (message: string) => void;
    info: (message: string) => void;
    setFailed: (message: string) => void;
    setOutput: (name: string, value: string) => void;
};

// Get the changed files for a pull-request or push
const getBaseAndHead = async (
    github: GithubLike,
    context: ContextLike,
    core: CoreLike,
): Promise<[string | undefined, string | undefined]> => {
    switch (context.eventName) {
        case "pull_request_target":
        case "pull_request":
            return [
                context.payload.pull_request?.base?.ref,
                context.payload.pull_request?.head?.sha,
            ];

        case "push": {
            // For push events, if this is a new branch, the before may be all
            // zeros (courtesy https://stackoverflow.com/a/61861763).
            if ((context.payload.before?.replaceAll("0", "").length ?? 0) > 0) {
                return [context.payload.before, context.payload.after];
            }

            const afterSha = context.payload.after;
            if (!afterSha) {
                throw new Error(
                    `Could not determine base ref for '${context.eventName}' event. Missing payload.after.`,
                );
            }

            // If we're on a new branch, then we try to find an open PR
            // associated that has the 'after' commit.
            // Search for pull requests that contain the specified commit SHA
            const response =
                await github.rest.repos.listPullRequestsAssociatedWithCommit({
                    owner: context.payload.repository.owner.name,
                    repo: context.payload.repository.name,
                    commit_sha: afterSha,
                });

            const pullRequests = response.data;
            if (pullRequests.length === 0) {
                throw new Error(
                    `Could not determine base ref for '${context.eventName}' event. ` +
                        `No pull requests found associated with commit: ${afterSha}. ` +
                        `context.payload.base_ref is null.`,
                );
            }
            if (pullRequests.length > 1) {
                const first = pullRequests[0];
                if (!first) {
                    throw new Error(
                        `Could not determine base ref for '${context.eventName}' event.`,
                    );
                }
                core.warn(
                    `Found ${pullRequests.length} PRs with the pushed commit (${afterSha}). ` +
                        `Proceeding on a hunch with the first one (#${first.number} - ${first.title})`,
                );
            }

            // Comparing to the owning PR's base ref
            return [pullRequests[0]?.base.sha, afterSha];
        }

        case "merge_group":
            return [
                context.payload.merge_group?.base_sha,
                context.payload.merge_group?.head_sha,
            ];

        default:
            core.setFailed(
                `This action only supports pull requests and pushes, ${context.eventName} events are not supported. ` +
                    "Please submit an issue on this action's GitHub repo if you believe this in correct.",
            );
            return [undefined, undefined];
    }
};

const getChangedFiles = async ({
    github,
    context,
    core,
    directoriesRaw,
}: {
    github: GithubLike;
    context: ContextLike;
    core: CoreLike;
    directoriesRaw: string;
}): Promise<void> => {
    const directories = directoriesRaw
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item.endsWith("/") ? item : `${item}/`));

    const [base, head] = await getBaseAndHead(github, context, core);
    core.info(`Base: ${base}\nHead: ${head}`);

    if (!base || !head) {
        // Ensure that the base and head properties are set on the payload.
        core.setFailed(
            `The base and head commits are missing from the payload for this ${context.eventName} event.`,
        );
        return;
    }

    // Use GitHub's compare two commits API.
    // https://developer.github.com/v3/repos/commits/#compare-two-commits
    const response = await github.rest.repos.compareCommits({
        base,
        head,
        owner: context.repo.owner,
        repo: context.repo.repo,
    });

    // Ensure that the request was successful.
    if (response.status !== 200) {
        core.setFailed(
            `The GitHub API for comparing the base and head commits for this ${context.eventName} event returned ${response.status}, expected 200.`,
        );
        return;
    }

    let files = response.data.files.filter((file) =>
        ["added", "modified", "renamed"].includes(file.status),
    );

    if (directories.length) {
        files = files.filter((file) =>
            directories.some((directory) =>
                file.filename.startsWith(directory),
            ),
        );
    }

    const fileNames = files.map((file) => file.filename);
    const serialized = JSON.stringify(fileNames);

    core.info(`Added or renamed or modified: ${serialized}`);
    core.setOutput("files", serialized);
};

export default getChangedFiles;
