import {describe, expect, it, vi} from "vitest";
import getChangedFiles from "./index.ts";

type PullRequestSummary = {
    number: number;
    title: string;
    base: {sha: string};
};

const makeCore = () => ({
    warn: vi.fn(),
    info: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
});

const makeGithub = ({
    pullRequests = [],
    compareStatus = 200,
    compareFiles = [],
}: {
    pullRequests?: PullRequestSummary[];
    compareStatus?: number;
    compareFiles?: Array<{filename: string; status: string}>;
}) => ({
    rest: {
        repos: {
            listPullRequestsAssociatedWithCommit: vi
                .fn()
                .mockResolvedValue({data: pullRequests}),
            compareCommits: vi.fn().mockResolvedValue({
                status: compareStatus,
                data: {files: compareFiles},
            }),
        },
    },
});

describe("getChangedFiles", () => {
    it("filters to added/modified/renamed files and directory prefixes on pull_request", async () => {
        const core = makeCore();
        const github = makeGithub({
            compareFiles: [
                {filename: "packages/a/src/index.ts", status: "modified"},
                {filename: "packages/b/README.md", status: "added"},
                {filename: "docs/readme.md", status: "modified"},
                {filename: "packages/a/old.ts", status: "removed"},
            ],
        });

        await getChangedFiles({
            github,
            core,
            directoriesRaw: "packages/a\npackages/b/",
            context: {
                eventName: "pull_request",
                payload: {
                    pull_request: {base: {ref: "main"}, head: {sha: "headsha"}},
                    repository: {owner: {name: "Khan"}, name: "actions"},
                },
                repo: {owner: "Khan", repo: "actions"},
            },
        });

        expect(github.rest.repos.compareCommits).toHaveBeenCalledWith({
            base: "main",
            head: "headsha",
            owner: "Khan",
            repo: "actions",
        });
        expect(core.setOutput).toHaveBeenCalledWith(
            "files",
            JSON.stringify(["packages/a/src/index.ts", "packages/b/README.md"]),
        );
    });

    it("uses before/after SHAs for normal push events", async () => {
        const core = makeCore();
        const github = makeGithub({
            compareFiles: [
                {filename: "actions/a/index.ts", status: "modified"},
            ],
        });

        await getChangedFiles({
            github,
            core,
            directoriesRaw: "",
            context: {
                eventName: "push",
                payload: {
                    before: "1234567890abcdef",
                    after: "fedcba0987654321",
                    repository: {owner: {name: "Khan"}, name: "actions"},
                },
                repo: {owner: "Khan", repo: "actions"},
            },
        });

        expect(
            github.rest.repos.listPullRequestsAssociatedWithCommit,
        ).not.toHaveBeenCalled();
        expect(github.rest.repos.compareCommits).toHaveBeenCalledWith({
            base: "1234567890abcdef",
            head: "fedcba0987654321",
            owner: "Khan",
            repo: "actions",
        });
    });

    it("resolves base from associated PR for new-branch push events and warns for multiple PRs", async () => {
        const core = makeCore();
        const github = makeGithub({
            pullRequests: [
                {number: 100, title: "A", base: {sha: "basesha-1"}},
                {number: 101, title: "B", base: {sha: "basesha-2"}},
            ],
            compareFiles: [
                {filename: "actions/a/index.ts", status: "modified"},
            ],
        });

        await getChangedFiles({
            github,
            core,
            directoriesRaw: "",
            context: {
                eventName: "push",
                payload: {
                    before: "0000000000000000000000000000000000000000",
                    after: "newheadsha",
                    repository: {owner: {name: "Khan"}, name: "actions"},
                },
                repo: {owner: "Khan", repo: "actions"},
            },
        });

        expect(
            github.rest.repos.listPullRequestsAssociatedWithCommit,
        ).toHaveBeenCalledWith({
            owner: "Khan",
            repo: "actions",
            commit_sha: "newheadsha",
        });
        expect(core.warn).toHaveBeenCalledTimes(1);
        expect(github.rest.repos.compareCommits).toHaveBeenCalledWith({
            base: "basesha-1",
            head: "newheadsha",
            owner: "Khan",
            repo: "actions",
        });
    });

    it("throws for new-branch push when no associated PRs are found", async () => {
        const core = makeCore();
        const github = makeGithub({pullRequests: []});

        await expect(
            getChangedFiles({
                github,
                core,
                directoriesRaw: "",
                context: {
                    eventName: "push",
                    payload: {
                        before: "0000000000000000000000000000000000000000",
                        after: "newheadsha",
                        repository: {owner: {name: "Khan"}, name: "actions"},
                    },
                    repo: {owner: "Khan", repo: "actions"},
                },
            }),
        ).rejects.toThrow("No pull requests found associated with commit");
    });

    it("uses merge_group base/head shas", async () => {
        const core = makeCore();
        const github = makeGithub({
            compareFiles: [
                {filename: "actions/a/index.ts", status: "modified"},
            ],
        });

        await getChangedFiles({
            github,
            core,
            directoriesRaw: "",
            context: {
                eventName: "merge_group",
                payload: {
                    merge_group: {base_sha: "base-sha", head_sha: "head-sha"},
                    repository: {owner: {name: "Khan"}, name: "actions"},
                },
                repo: {owner: "Khan", repo: "actions"},
            },
        });

        expect(github.rest.repos.compareCommits).toHaveBeenCalledWith({
            base: "base-sha",
            head: "head-sha",
            owner: "Khan",
            repo: "actions",
        });
    });

    it("fails gracefully when compareCommits response is not 200", async () => {
        const core = makeCore();
        const github = makeGithub({
            compareStatus: 500,
            compareFiles: [],
        });

        await getChangedFiles({
            github,
            core,
            directoriesRaw: "",
            context: {
                eventName: "pull_request",
                payload: {
                    pull_request: {base: {ref: "main"}, head: {sha: "headsha"}},
                    repository: {owner: {name: "Khan"}, name: "actions"},
                },
                repo: {owner: "Khan", repo: "actions"},
            },
        });

        expect(core.setFailed).toHaveBeenCalledWith(
            "The GitHub API for comparing the base and head commits for this pull_request event returned 500, expected 200.",
        );
        expect(core.setOutput).not.toHaveBeenCalled();
    });

    it("sets failure for unsupported event names", async () => {
        const core = makeCore();
        const github = makeGithub({});

        await getChangedFiles({
            github,
            core,
            directoriesRaw: "",
            context: {
                eventName: "schedule",
                payload: {
                    repository: {owner: {name: "Khan"}, name: "actions"},
                },
                repo: {owner: "Khan", repo: "actions"},
            },
        });

        expect(core.setFailed).toHaveBeenCalledTimes(2);
        expect(core.setFailed.mock.calls[0]?.[0]).toContain(
            "schedule events are not supported",
        );
        expect(github.rest.repos.compareCommits).not.toHaveBeenCalled();
    });

    it("throws for new-branch push when payload.after is missing", async () => {
        const core = makeCore();
        const github = makeGithub({});

        await expect(
            getChangedFiles({
                github,
                core,
                directoriesRaw: "",
                context: {
                    eventName: "push",
                    payload: {
                        before: "0000000000000000000000000000000000000000",
                        repository: {owner: {name: "Khan"}, name: "actions"},
                    },
                    repo: {owner: "Khan", repo: "actions"},
                },
            }),
        ).rejects.toThrow("Missing payload.after.");
    });
});
