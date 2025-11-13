// Get the changed files for a pull-request or push

const getBaseAndHead = async (github, context, core) => {
    switch (context.eventName) {
        case "pull_request_target":
        case "pull_request":
            return [
                context.payload.pull_request?.base?.ref,
                context.payload.pull_request?.head?.sha,
            ];
        case "push":
            // For push events, if this is a new branch, the base_ref will be
            // null and before will be all zeros (courtesy
            // https://stackoverflow.com/a/61861763)
            if (context.payload.base_ref != null) {
                return [context.payload.before, context.payload.after];
            } else {
                // If we're on a new branch, then we try to find an open PR
                // associated that has the 'after' commit.
                const {owner, repo} = context;

                // Search for pull requests that contain the specified commit SHA
                const response =
                    await github.repos.listPullRequestsAssociatedWithCommit({
                        owner,
                        repo,
                        commit_sha: context.payload.after,
                    });

                const pullRequests = response.data.items;
                if (pullRequests.length === 0) {
                    throw new Error(
                        `Could not determine base ref for '${context.eventName}' event. ` +
                            `No pull requests found associated with commit: ${context.payload.after}. ` +
                            `context.payload.base_ref is null.`,
                    );
                } else if (pullRequests.length > 1) {
                    core.warn(
                        `Found ${pullRequests.length} PRs with the pushed commit (${context.payload.after}). ` +
                            `Proceeding on a hunch with the first one (#${pullRequests[0].number} - ${pullRequests[0].title})`,
                    );
                }

                return [pullRequests[0].base.sha, context.payload.after];
            }
        case "merge_group":
            return [
                context.payload.merge_group.base_sha,
                context.payload.merge_group.head_sha,
            ];
        default:
            core.setFailed(
                `This action only supports pull requests and pushes, ${context.eventName} events are not supported. ` +
                    "Please submit an issue on this action's GitHub repo if you believe this in correct.",
            );
    }
};

module.exports = async ({github, context, core, directoriesRaw}) => {
    const directories = directoriesRaw
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item.endsWith("/") ? item : item + "/"));

    const [base, head] = await getBaseAndHead(github, context, core);
    core.info(`Base: ${base}\nHead: ${head}`);

    // Ensure that the base and head properties are set on the payload.
    if (!base || !head) {
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
