// Get the changed files for a pull-request or push

const getBaseAndHead = (context, core) => {
    switch (context.eventName) {
        case "pull_request_target":
        case "pull_request":
            return [
                context.payload.pull_request?.base?.ref,
                context.payload.pull_request?.head?.sha,
            ];
        case "push":
            return [context.payload.before, context.payload.after];
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

    const [base, head] = getBaseAndHead(context, core);
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
