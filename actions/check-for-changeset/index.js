module.exports = ({context, core, inputFiles}) => {
    core.debug("Changed files: " + inputFiles);
    core.debug(process.env.GITHUB_REF_NAME);

    if (process.env.GITHUB_REF_NAME === "changeset-release/main") {
        return; // release PRs don't need changesets.
    }

    if (inputFiles.every((name) => name.startsWith(".github/"))) {
        return; // changes to workflows don't require changesets
    }

    const hasChangeset = inputFiles.some((name) => {
        return /^\.changeset\/.*\.md/.test(name);
    });
    if (!hasChangeset) {
        core.setFailed(
            "This PR does not have a changeset. You can add one by " +
                "running `yarn changeset` and following the prompts.\n" +
                "If this PR doesn't need a changeset, run `yarn changeset " +
                "--empty` and commit results.",
        );
    }
};
