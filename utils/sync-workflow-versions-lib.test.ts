import {describe, expect, it, vi} from "vitest";
import {
    syncWorkflowVersionContent,
    syncWorkflowVersions,
    type DirEntryLike,
} from "./sync-workflow-versions-lib.ts";

describe("syncWorkflowVersionContent", () => {
    it("rewrites the pinned checkout ref to the given version", () => {
        // Arrange: a stale ref, as shipped in review-v1.3.0 through v1.4.0.
        const content = [
            "pre-agent-steps:",
            "  - uses: actions/checkout@abc # v5",
            "    with:",
            "      repository: Khan/actions",
            "      ref: review-v1.2.2",
        ].join("\n");

        // Act
        const result = syncWorkflowVersionContent(content, "review", "9.9.9");

        // Assert
        expect(result.replaced).toBe(1);
        expect(result.content).toContain("ref: review-v9.9.9");
        expect(result.content).not.toContain("review-v1.2.2");
    });

    it("rewrites every semver literal but leaves templates alone", () => {
        // Arrange
        const content =
            "ref: review-v1.2.2\n" +
            "the marker is `v=review-v<version>` (a template)\n" +
            "released as review-v1.3.0\n";

        // Act
        const result = syncWorkflowVersionContent(content, "review", "2.0.0");

        // Assert
        expect(result.replaced).toBe(2);
        expect(result.content).toBe(
            "ref: review-v2.0.0\n" +
                "the marker is `v=review-v<version>` (a template)\n" +
                "released as review-v2.0.0\n",
        );
    });

    it("leaves other workflows' literals alone", () => {
        // Arrange
        const content = "ref: review-v1.2.2\nsee also triage-v3.0.0\n";

        // Act
        const result = syncWorkflowVersionContent(content, "review", "2.0.0");

        // Assert
        expect(result.replaced).toBe(1);
        expect(result.content).toBe(
            "ref: review-v2.0.0\nsee also triage-v3.0.0\n",
        );
    });

    it("returns unchanged content when already at the version", () => {
        // Act
        const result = syncWorkflowVersionContent(
            "ref: review-v1.4.0",
            "review",
            "1.4.0",
        );

        // Assert
        expect(result.replaced).toBe(1);
        expect(result.content).toBe("ref: review-v1.4.0");
    });
});

describe("syncWorkflowVersions", () => {
    const makeDeps = (files: Record<string, string>) => {
        const writes: Record<string, string> = {};
        const readdirSyncImpl = (dir: string): DirEntryLike[] => {
            const children = new Map<string, boolean>();
            for (const path of Object.keys(files)) {
                if (!path.startsWith(`${dir}/`)) {
                    continue;
                }
                const rest = path.slice(dir.length + 1);
                const slash = rest.indexOf("/");
                children.set(
                    slash === -1 ? rest : rest.slice(0, slash),
                    slash !== -1,
                );
            }
            return [...children].map(([name, isDir]) => ({
                name,
                isDirectory: () => isDir,
                isFile: () => !isDir,
            }));
        };
        return {
            writes,
            deps: {
                readFileSyncImpl: (path: string) => {
                    const content = files[path];
                    if (content === undefined) {
                        throw new Error(`unexpected read: ${path}`);
                    }
                    return content;
                },
                writeFileSyncImpl: (path: string, data: string) => {
                    writes[path] = data;
                },
                readdirSyncImpl,
                log: vi.fn(),
            },
        };
    };

    it("writes review.md with the package version substituted", () => {
        // Arrange
        const {writes, deps} = makeDeps({
            "workflows/review/package.json":
                '{"name": "review", "version": "1.5.0"}',
            "workflows/review/review.md": "      ref: review-v1.2.2\n",
        });

        // Act
        syncWorkflowVersions(deps);

        // Assert
        expect(writes["workflows/review/review.md"]).toBe(
            "      ref: review-v1.5.0\n",
        );
    });

    it("syncs every workflow to its own version", () => {
        // Arrange
        const {writes, deps} = makeDeps({
            "workflows/review/package.json":
                '{"name": "review", "version": "1.5.0"}',
            "workflows/review/review.md": "ref: review-v1.2.2\n",
            "workflows/triage/package.json":
                '{"name": "triage", "version": "2.1.0"}',
            "workflows/triage/triage.md":
                "ref: triage-v2.0.0\nsee review-v1.2.2\n",
        });

        // Act
        syncWorkflowVersions(deps);

        // Assert: each workflow gets its own version, and a mention of
        // another workflow's tag is not rewritten.
        expect(writes["workflows/review/review.md"]).toBe(
            "ref: review-v1.5.0\n",
        );
        expect(writes["workflows/triage/triage.md"]).toBe(
            "ref: triage-v2.1.0\nsee review-v1.2.2\n",
        );
    });

    it("never rewrites CHANGELOG.md", () => {
        // Arrange: the changelog holds historic versions on purpose.
        const {writes, deps} = makeDeps({
            "workflows/review/package.json":
                '{"name": "review", "version": "1.5.0"}',
            "workflows/review/review.md": "ref: review-v1.5.0\n",
            "workflows/review/CHANGELOG.md": "## review-v1.2.2 notes\n",
        });

        // Act
        syncWorkflowVersions(deps);

        // Assert
        expect(writes).toEqual({});
    });

    it("is a no-op for a workflow with no version literals", () => {
        // Arrange
        const {writes, deps} = makeDeps({
            "workflows/triage/package.json":
                '{"name": "triage", "version": "2.0.0"}',
            "workflows/triage/triage.md": "no pinned ref here\n",
        });

        // Act
        syncWorkflowVersions(deps);

        // Assert
        expect(writes).toEqual({});
    });

    it("does not write when the ref is already current", () => {
        // Arrange
        const {writes, deps} = makeDeps({
            "workflows/review/package.json":
                '{"name": "review", "version": "1.5.0"}',
            "workflows/review/review.md": "      ref: review-v1.5.0\n",
        });

        // Act
        syncWorkflowVersions(deps);

        // Assert
        expect(writes).toEqual({});
    });

    it("throws when a workflow's package.json has no version", () => {
        // Arrange
        const {deps} = makeDeps({
            "workflows/review/package.json": '{"name": "review"}',
            "workflows/review/review.md": "ref: review-v1.2.2\n",
        });

        // Act + Assert
        expect(() => syncWorkflowVersions(deps)).toThrow(/No version found/);
    });
});
