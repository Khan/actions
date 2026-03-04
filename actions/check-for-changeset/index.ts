type ContextLike = {
    payload: {
        pull_request: {
            head: {
                ref: string;
            };
        };
    };
};

type CoreLike = {
    debug: (message: string) => void;
    setFailed: (message: string) => void;
};

type CheckForChangesetInput = {
    context: ContextLike;
    core: CoreLike;
    inputFiles: string[];
};

const checkForChangeset = ({
    context,
    core,
    inputFiles,
}: CheckForChangesetInput): void => {
    if (!inputFiles.length) {
        return; // no relevant files changed, ignore
    }
    core.debug("Changed files: " + inputFiles);

    const branchName = context.payload.pull_request.head.ref;
    if (branchName === "changeset-release/main") {
        return; // release PRs don't need changesets.
    }

    const hasChangeset = inputFiles.some((name) =>
        /^\.changeset\/.*\.md/.test(name),
    );
    if (!hasChangeset) {
        core.setFailed(
            "This PR does not have a changeset. You can add one by " +
                "running `pnpm changeset` and following the prompts.\n" +
                "If this PR doesn't need a changeset, run `pnpm changeset " +
                "--empty` and commit results.",
        );
    }
};

export default checkForChangeset;
