import {beforeEach, describe, expect, it, vi} from "vitest";
import {vol} from "memfs";

const {execSyncMock, buildPackageMock, extractIntraRepoDependenciesMock} =
    vi.hoisted(() => ({
        execSyncMock: vi.fn(),
        buildPackageMock: vi.fn(),
        extractIntraRepoDependenciesMock: vi.fn(),
    }));

vi.mock("fs", () => vi.importActual("memfs"));
vi.mock("child_process", () => ({execSync: execSyncMock}));
vi.mock("./build.ts", () => ({
    buildPackage: buildPackageMock,
    extractIntraRepoDependencies: extractIntraRepoDependenciesMock,
}));

import {
    checkTag,
    collectIntraRepoDependencyGraph,
    collectPackageJsons,
    findDependencyCycle,
    lookupPublishedActionRef,
    publishAsNeeded,
    publishDirectoryAsTags,
    topologicallySortActions,
} from "./publish.ts";

describe("publish", () => {
    beforeEach(() => {
        vol.reset();
        execSyncMock.mockReset();
        buildPackageMock.mockReset();
        extractIntraRepoDependenciesMock.mockReset();
        vi.unstubAllGlobals();
    });

    describe("graph utilities", () => {
        it("findDependencyCycle returns null for a dag", () => {
            const graph = {
                "json-args": [],
                "full-or-limited": ["json-args"],
                "gerald-pr": [],
            };
            expect(findDependencyCycle(graph)).toBe(null);
        });

        it("findDependencyCycle returns the full cycle path", () => {
            const graph = {
                a: ["b"],
                b: ["c"],
                c: ["a"],
            };
            expect(findDependencyCycle(graph)).toEqual(["a", "b", "c", "a"]);
        });

        it("topologicallySortActions orders dependencies before dependents", () => {
            const graph = {
                c: ["a", "b"],
                b: ["a"],
                a: [],
                d: [],
            };

            expect(topologicallySortActions(graph)).toEqual([
                "a",
                "b",
                "c",
                "d",
            ]);
        });

        it("topologicallySortActions throws for cyclic graphs", () => {
            expect(() =>
                topologicallySortActions({a: ["b"], b: ["a"]}),
            ).toThrow("graph is not a DAG");
        });
    });

    describe("checkTag", () => {
        it("returns true when tag exists", () => {
            execSyncMock.mockReturnValueOnce("");
            expect(checkTag("my-tag")).toBe(true);
            expect(execSyncMock).toHaveBeenCalledWith(
                "git show-ref --tags my-tag",
            );
        });

        it("returns false when git show-ref throws", () => {
            execSyncMock.mockImplementationOnce(() => {
                throw new Error("missing");
            });
            expect(checkTag("missing-tag")).toBe(false);
        });
    });

    describe("publishDirectoryAsTags", () => {
        it("runs the git publish sequence and returns commit sha", () => {
            execSyncMock.mockImplementation(
                (cmd: string, options?: {encoding?: string}) => {
                    if (
                        cmd === "git rev-parse HEAD" &&
                        options?.encoding === "utf8"
                    ) {
                        return "published-sha\n";
                    }
                    return "";
                },
            );

            const result = publishDirectoryAsTags(
                "actions/a/dist",
                "git@github.com:Khan/actions.git",
                "a-v1.0.0",
                false,
                "AUTH",
            );

            expect(result).toEqual({sha: "published-sha"});
            expect(execSyncMock).toHaveBeenCalledWith(
                "git push origin --tags",
                {
                    cwd: "actions/a/dist",
                },
            );
            expect(execSyncMock).toHaveBeenCalledWith(
                'git config --local http.https://github.com/.extraheader "AUTH"',
                {cwd: "actions/a/dist"},
            );
        });

        it("omits push command on dry run", () => {
            execSyncMock.mockImplementation(
                (cmd: string, options?: {encoding?: string}) => {
                    if (
                        cmd === "git rev-parse HEAD" &&
                        options?.encoding === "utf8"
                    ) {
                        return "dry-sha\n";
                    }
                    return "";
                },
            );

            const result = publishDirectoryAsTags(
                "actions/a/dist",
                "git@github.com:Khan/actions.git",
                "a-v1.0.0",
                true,
                null,
            );

            expect(result).toEqual({sha: "dry-sha"});
            expect(execSyncMock).not.toHaveBeenCalledWith(
                "git push origin --tags",
                {
                    cwd: "actions/a/dist",
                },
            );
        });

        it("returns null when a command fails", () => {
            execSyncMock.mockImplementation((cmd: string) => {
                if (cmd === "git tag a-v1.0.0") {
                    throw new Error("tag failed");
                }
                return "";
            });

            const result = publishDirectoryAsTags(
                "actions/a/dist",
                "git@github.com:Khan/actions.git",
                "a-v1.0.0",
                false,
                null,
            );

            expect(result).toBe(null);
        });
    });

    describe("package metadata and dependency graph", () => {
        it("collectPackageJsons indexes by package name", () => {
            vol.fromJSON({
                "actions/a/package.json": JSON.stringify({
                    name: "a",
                    version: "1.0.0",
                }),
                "actions/b/package.json": JSON.stringify({
                    name: "b",
                    version: "2.0.0",
                }),
            });

            expect(collectPackageJsons(["a", "b"])).toEqual({
                a: {name: "a", version: "1.0.0"},
                b: {name: "b", version: "2.0.0"},
            });
        });

        it("collectPackageJsons throws when name is missing", () => {
            vol.fromJSON({
                "actions/a/package.json": JSON.stringify({version: "1.0.0"}),
            });

            expect(() => collectPackageJsons(["a"])).toThrow(/Missing name/);
        });

        it("collectIntraRepoDependencyGraph keeps only intra-repo deps and sorts", () => {
            vol.fromJSON({
                "actions/a/action.yml": "uses: ./actions/b",
                "actions/b/action.yml": "uses: ./actions/a",
            });

            extractIntraRepoDependenciesMock.mockImplementation(
                (actionYml: string) => {
                    if (actionYml.includes("./actions/b")) {
                        return ["external", "b"];
                    }
                    return ["a"];
                },
            );

            expect(collectIntraRepoDependencyGraph(["a", "b"])).toEqual({
                a: ["b"],
                b: ["a"],
            });
        });
    });

    describe("lookupPublishedActionRef", () => {
        it("returns cached value without calling fetch", async () => {
            const cache = {
                "dep@1.2.3": {sha: "cached-sha", version: "1.2.3"},
            };
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);

            await expect(
                lookupPublishedActionRef(
                    "Khan/actions",
                    "dep",
                    "1.2.3",
                    undefined,
                    cache,
                ),
            ).resolves.toEqual({sha: "cached-sha", version: "1.2.3"});
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("resolves annotated tags to commit sha and caches result", async () => {
            const fetchSpy = vi
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => [
                        {
                            ref: "refs/tags/dep-v1.2.3",
                            object: {type: "tag", sha: "tag-obj-sha"},
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        object: {type: "commit", sha: "commit-sha"},
                    }),
                });
            vi.stubGlobal("fetch", fetchSpy);

            const cache: Record<string, {sha: string; version: string}> = {};
            await expect(
                lookupPublishedActionRef(
                    "Khan/actions",
                    "dep",
                    "1.2.3",
                    "token",
                    cache,
                ),
            ).resolves.toEqual({sha: "commit-sha", version: "1.2.3"});
            expect(cache["dep@1.2.3"]).toEqual({
                sha: "commit-sha",
                version: "1.2.3",
            });
        });

        it("throws when exact tag ref is not present", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({ok: true, json: async () => []}),
            );

            await expect(
                lookupPublishedActionRef(
                    "Khan/actions",
                    "dep",
                    "1.2.3",
                    undefined,
                    {},
                ),
            ).rejects.toThrow('Could not find published tag "dep-v1.2.3"');
        });

        it("throws when github api request fails", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: false,
                    status: 500,
                    statusText: "Internal Server Error",
                    text: async () => "boom",
                }),
            );

            await expect(
                lookupPublishedActionRef(
                    "Khan/actions",
                    "dep",
                    "1.2.3",
                    undefined,
                    {},
                ),
            ).rejects.toThrow("GitHub API request failed");
        });
    });

    describe("publishAsNeeded", () => {
        it("builds and publishes selected actions in topo order and reuses newly published dep SHAs", async () => {
            vol.fromJSON({
                "actions/a/package.json": JSON.stringify({
                    name: "a",
                    version: "1.0.0",
                }),
                "actions/a/action.yml": "uses: ./actions/b",
                "actions/b/package.json": JSON.stringify({
                    name: "b",
                    version: "2.0.0",
                }),
                "actions/b/action.yml": "name: b",
            });

            extractIntraRepoDependenciesMock.mockImplementation(
                (actionYml: string) =>
                    actionYml.includes("./actions/b") ? ["b"] : [],
            );
            buildPackageMock
                .mockReturnValueOnce("actions/b/dist")
                .mockReturnValueOnce("actions/a/dist");

            let commitCount = 0;
            execSyncMock.mockImplementation(
                (cmd: string, options?: {encoding?: string}) => {
                    if (
                        cmd === "git remote get-url origin" &&
                        options?.encoding === "utf8"
                    ) {
                        return "git@github.com:Khan/actions.git\n";
                    }
                    if (
                        cmd ===
                            "git config --local http.https://github.com/.extraheader" &&
                        options?.encoding === "utf-8"
                    ) {
                        return "AUTH\n";
                    }
                    if (cmd.startsWith("git show-ref --tags ")) {
                        throw new Error("missing tag");
                    }
                    if (
                        cmd === "git rev-parse HEAD" &&
                        options?.encoding === "utf8"
                    ) {
                        commitCount += 1;
                        return `commit-${commitCount}\n`;
                    }
                    return "";
                },
            );

            await publishAsNeeded(["a", "b"], true);

            expect(buildPackageMock.mock.calls[0]?.[0]).toBe("b");
            expect(buildPackageMock.mock.calls[0]?.[3]).toEqual({});
            expect(buildPackageMock.mock.calls[1]?.[0]).toBe("a");
            expect(buildPackageMock.mock.calls[1]?.[3]).toEqual({
                b: {sha: "commit-1", version: "2.0.0"},
            });
        });

        it("looks up already-published dependency refs for unselected deps", async () => {
            vol.fromJSON({
                "actions/a/package.json": JSON.stringify({
                    name: "a",
                    version: "1.0.0",
                }),
                "actions/a/action.yml": "uses: ./actions/b",
                "actions/b/package.json": JSON.stringify({
                    name: "b",
                    version: "2.0.0",
                }),
                "actions/b/action.yml": "name: b",
            });

            extractIntraRepoDependenciesMock.mockImplementation(
                (actionYml: string) =>
                    actionYml.includes("./actions/b") ? ["b"] : [],
            );
            buildPackageMock.mockReturnValueOnce("actions/a/dist");

            const fetchSpy = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    {
                        ref: "refs/tags/b-v2.0.0",
                        object: {type: "commit", sha: "published-b-sha"},
                    },
                ],
            });
            vi.stubGlobal("fetch", fetchSpy);

            execSyncMock.mockImplementation(
                (cmd: string, options?: {encoding?: string}) => {
                    if (
                        cmd === "git remote get-url origin" &&
                        options?.encoding === "utf8"
                    ) {
                        return "https://github.com/Khan/actions.git\n";
                    }
                    if (
                        cmd ===
                            "git config --local http.https://github.com/.extraheader" &&
                        options?.encoding === "utf-8"
                    ) {
                        throw new Error("no auth");
                    }
                    if (cmd.startsWith("git show-ref --tags ")) {
                        throw new Error("missing tag");
                    }
                    if (
                        cmd === "git rev-parse HEAD" &&
                        options?.encoding === "utf8"
                    ) {
                        return "commit-a\n";
                    }
                    return "";
                },
            );

            await publishAsNeeded(["a"], true);

            expect(buildPackageMock).toHaveBeenCalledWith(
                "a",
                expect.any(Object),
                "Khan/actions",
                {b: {sha: "published-b-sha", version: "2.0.0"}},
            );
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("throws when origin cannot be parsed as a github repo", async () => {
            vol.fromJSON({
                "actions/a/package.json": JSON.stringify({
                    name: "a",
                    version: "1.0.0",
                }),
                "actions/a/action.yml": "name: a",
            });
            extractIntraRepoDependenciesMock.mockReturnValue([]);

            execSyncMock.mockImplementation(
                (cmd: string, options?: {encoding?: string}) => {
                    if (
                        cmd === "git remote get-url origin" &&
                        options?.encoding === "utf8"
                    ) {
                        return "not-a-github-origin\n";
                    }
                    return "";
                },
            );

            await expect(publishAsNeeded(["a"], true)).rejects.toThrow(
                "Unable to determine monorepo name",
            );
        });

        it("calls process.exit(1) when publishing fails", async () => {
            vol.fromJSON({
                "actions/a/package.json": JSON.stringify({
                    name: "a",
                    version: "1.0.0",
                }),
                "actions/a/action.yml": "name: a",
            });
            extractIntraRepoDependenciesMock.mockReturnValue([]);
            buildPackageMock.mockReturnValue("actions/a/dist");

            execSyncMock.mockImplementation(
                (cmd: string, options?: {encoding?: string}) => {
                    if (
                        cmd === "git remote get-url origin" &&
                        options?.encoding === "utf8"
                    ) {
                        return "git@github.com:Khan/actions.git\n";
                    }
                    if (
                        cmd ===
                            "git config --local http.https://github.com/.extraheader" &&
                        options?.encoding === "utf-8"
                    ) {
                        return "AUTH\n";
                    }
                    if (cmd.startsWith("git show-ref --tags ")) {
                        throw new Error("missing tag");
                    }
                    if (cmd === "git push origin --tags") {
                        throw new Error("push failed");
                    }
                    if (
                        cmd === "git rev-parse HEAD" &&
                        options?.encoding === "utf8"
                    ) {
                        return "commit-a\n";
                    }
                    return "";
                },
            );

            const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
                code?: number,
            ) => {
                throw new Error(`exit:${code}`);
            }) as never);

            await expect(publishAsNeeded(["a"], false)).rejects.toThrow(
                "exit:1",
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
});
