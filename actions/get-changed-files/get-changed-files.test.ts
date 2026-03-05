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
        // Arrange
        const core = makeCore();
        const github = makeGithub({
            compareFiles: [
                {filename: "packages/a/src/index.ts", status: "modified"},
                {filename: "packages/b/README.md", status: "added"},
                {filename: "docs/readme.md", status: "modified"},
                {filename: "packages/a/old.ts", status: "removed"},
            ],
        });

        // Act
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

        // Assert
        expect({
            compareArgs: github.rest.repos.compareCommits.mock.calls[0]?.[0],
            outputArgs: core.setOutput.mock.calls[0],
        }).toEqual({
            compareArgs: {
                base: "main",
                head: "headsha",
                owner: "Khan",
                repo: "actions",
            },
            outputArgs: [
                "files",
                JSON.stringify([
                    "packages/a/src/index.ts",
                    "packages/b/README.md",
                ]),
            ],
        });
    });

    it("uses before/after SHAs for normal push events", async () => {
        // Arrange
        const core = makeCore();
        const github = makeGithub({
            compareFiles: [
                {filename: "actions/a/index.ts", status: "modified"},
            ],
        });

        // Act
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

        // Assert
        expect({
            prLookupCalls:
                github.rest.repos.listPullRequestsAssociatedWithCommit.mock
                    .calls.length,
            compareArgs: github.rest.repos.compareCommits.mock.calls[0]?.[0],
        }).toEqual({
            prLookupCalls: 0,
            compareArgs: {
                base: "1234567890abcdef",
                head: "fedcba0987654321",
                owner: "Khan",
                repo: "actions",
            },
        });
    });

    it("resolves base from associated PR for new-branch push events and warns for multiple PRs", async () => {
        // Arrange
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

        // Act
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

        // Assert
        expect({
            prLookupArgs:
                github.rest.repos.listPullRequestsAssociatedWithCommit.mock
                    .calls[0]?.[0],
            warnCalls: core.warn.mock.calls.length,
            compareArgs: github.rest.repos.compareCommits.mock.calls[0]?.[0],
        }).toEqual({
            prLookupArgs: {
                owner: "Khan",
                repo: "actions",
                commit_sha: "newheadsha",
            },
            warnCalls: 1,
            compareArgs: {
                base: "basesha-1",
                head: "newheadsha",
                owner: "Khan",
                repo: "actions",
            },
        });
    });

    it("throws for new-branch push when no associated PRs are found", async () => {
        // Arrange
        const core = makeCore();
        const github = makeGithub({pullRequests: []});

        // Act
        const underTest = getChangedFiles({
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

        // Assert
        await expect(underTest).rejects.toThrow(
            "No pull requests found associated with commit",
        );
    });

    it("uses merge_group base/head shas", async () => {
        // Arrange
        const core = makeCore();
        const github = makeGithub({
            compareFiles: [
                {filename: "actions/a/index.ts", status: "modified"},
            ],
        });

        // Act
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

        // Assert
        expect(github.rest.repos.compareCommits).toHaveBeenCalledWith({
            base: "base-sha",
            head: "head-sha",
            owner: "Khan",
            repo: "actions",
        });
    });

    it("fails gracefully when compareCommits response is not 200", async () => {
        // Arrange
        const core = makeCore();
        const github = makeGithub({
            compareStatus: 500,
            compareFiles: [],
        });

        // Act
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

        // Assert
        expect({
            failedMessage: core.setFailed.mock.calls[0]?.[0],
            outputCalls: core.setOutput.mock.calls.length,
        }).toEqual({
            failedMessage:
                "The GitHub API for comparing the base and head commits for this pull_request event returned 500, expected 200.",
            outputCalls: 0,
        });
    });

    it("sets failure for unsupported event names", async () => {
        // Arrange
        const core = makeCore();
        const github = makeGithub({});

        // Act
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

        // Assert
        expect({
            failedCalls: core.setFailed.mock.calls.length,
            firstFailedMessage: core.setFailed.mock.calls[0]?.[0],
            compareCalls: github.rest.repos.compareCommits.mock.calls.length,
        }).toEqual({
            failedCalls: 2,
            firstFailedMessage:
                "This action only supports pull requests and pushes, schedule events are not supported. Please submit an issue on this action's GitHub repo if you believe this in correct.",
            compareCalls: 0,
        });
    });

    it("throws for new-branch push when payload.after is missing", async () => {
        // Arrange
        const core = makeCore();
        const github = makeGithub({});

        // Act
        const underTest = getChangedFiles({
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
        });

        // Assert
        await expect(underTest).rejects.toThrow("Missing payload.after.");
    });
});
