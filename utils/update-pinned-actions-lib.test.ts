import {describe, expect, it, vi} from "vitest";
import {resolveRef, updatePinnedActions} from "./update-pinned-actions-lib.ts";

describe("resolveRef", () => {
    it("prefers annotated-tag dereferenced SHA", () => {
        // Arrange
        const execSyncImpl = vi
            .fn()
            .mockReturnValueOnce(
                [
                    "1111111111111111111111111111111111111111\trefs/tags/v1",
                    "2222222222222222222222222222222222222222\trefs/tags/v1^{}",
                ].join("\n"),
            );

        // Act
        const result = resolveRef("owner/repo", "v1", execSyncImpl as never);

        // Assert
        expect(result).toBe("2222222222222222222222222222222222222222");
    });

    it("falls back to branch lookup when tag lookup is empty", () => {
        // Arrange
        const execSyncImpl = vi
            .fn()
            .mockReturnValueOnce("")
            .mockReturnValueOnce(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main",
            );

        // Act
        const result = resolveRef("owner/repo", "main", execSyncImpl as never);

        // Assert
        expect(result).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("returns null when no tag or branch matches", () => {
        // Arrange
        const execSyncImpl = vi
            .fn()
            .mockReturnValueOnce("")
            .mockReturnValueOnce("");

        // Act
        const result = resolveRef(
            "owner/repo",
            "missing",
            execSyncImpl as never,
        );

        // Assert
        expect(result).toBe(null);
    });
});

describe("updatePinnedActions", () => {
    it("exits with 0 when no references are found", () => {
        // Arrange
        const logs: string[] = [];
        const exit = vi.fn((code: number) => {
            throw new Error(`exit:${code}`);
        });

        // Act
        const underTest = () =>
            updatePinnedActions({
                globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
                readFileSyncImpl: vi.fn().mockReturnValue("name: CI\n"),
                writeFileSyncImpl: vi.fn(),
                execSyncImpl: vi.fn(),
                log: (msg) => logs.push(msg),
                exit: exit as never,
            });

        // Assert
        expect({
            thrown: (() => {
                try {
                    underTest();
                    return null;
                } catch (error) {
                    return error instanceof Error
                        ? error.message
                        : String(error);
                }
            })(),
            logs,
            exitArg: exit.mock.calls[0]?.[0],
        }).toEqual({
            thrown: "exit:0",
            logs: ["No action references found."],
            exitArg: 0,
        });
    });

    it("updates stale pinned and unpinned references", () => {
        // Arrange
        const files = {
            "workflow.yml": [
                "steps:",
                "  - uses: owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1",
                "  - uses: other/action@v2",
                "  - uses: ./actions/local-action",
            ].join("\n"),
        } as Record<string, string>;

        const readFileSyncImpl = vi.fn((file: string) => files[file] ?? "");
        const writeFileSyncImpl = vi.fn((file: string, content: string) => {
            files[file] = content;
        });
        const execSyncImpl = vi.fn((cmd: string) => {
            if (cmd.includes("owner/repo.git")) {
                return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1";
            }
            if (cmd.includes("other/action.git")) {
                return "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v2";
            }
            return "";
        });

        // Act
        const result = updatePinnedActions({
            globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
            readFileSyncImpl: readFileSyncImpl as never,
            writeFileSyncImpl: writeFileSyncImpl as never,
            execSyncImpl: execSyncImpl as never,
            log: () => {},
            exit: (() => {
                throw new Error("unexpected exit");
            }) as never,
        });

        // Assert
        expect({
            result,
            content: files["workflow.yml"],
        }).toEqual({
            result: {
                filesScanned: 1,
                uniqueRefs: 2,
                updatedFiles: 1,
                updatedRefs: 2,
                alreadyCurrent: 0,
                failures: 0,
            },
            content: [
                "steps:",
                "  - uses: owner/repo@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v1",
                "  - uses: other/action@cccccccccccccccccccccccccccccccccccccccc # v2",
                "  - uses: ./actions/local-action",
            ].join("\n"),
        });
    });

    it("counts already-current references without rewriting", () => {
        // Arrange
        const content =
            "uses: owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1\n";
        const writeFileSyncImpl = vi.fn();

        // Act
        const result = updatePinnedActions({
            globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
            readFileSyncImpl: vi.fn().mockReturnValue(content),
            writeFileSyncImpl: writeFileSyncImpl as never,
            execSyncImpl: vi
                .fn()
                .mockReturnValue(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1",
                ) as never,
            log: () => {},
            exit: (() => {
                throw new Error("unexpected exit");
            }) as never,
        });

        // Assert
        expect({
            alreadyCurrent: result.alreadyCurrent,
            updatedRefs: result.updatedRefs,
            writeCalls: writeFileSyncImpl.mock.calls.length,
        }).toEqual({alreadyCurrent: 1, updatedRefs: 0, writeCalls: 0});
    });

    it("exits with 1 when resolution fails", () => {
        // Arrange
        const exit = vi.fn((code: number) => {
            throw new Error(`exit:${code}`);
        });

        // Act
        const underTest = () =>
            updatePinnedActions({
                globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
                readFileSyncImpl: vi
                    .fn()
                    .mockReturnValue("uses: owner/repo@v1\n"),
                writeFileSyncImpl: vi.fn(),
                execSyncImpl: vi.fn().mockReturnValue(""),
                log: () => {},
                exit: exit as never,
            });

        // Assert
        expect({
            thrown: (() => {
                try {
                    underTest();
                    return null;
                } catch (error) {
                    return error instanceof Error
                        ? error.message
                        : String(error);
                }
            })(),
            exitArg: exit.mock.calls[0]?.[0],
        }).toEqual({thrown: "exit:1", exitArg: 1});
    });
});
