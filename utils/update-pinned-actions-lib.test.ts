import {describe, expect, it, vi} from "vitest";
import {resolveRef, updatePinnedActions} from "./update-pinned-actions-lib.ts";

describe("resolveRef", () => {
    it("prefers annotated-tag dereferenced SHA", () => {
        const execSyncImpl = vi
            .fn()
            .mockReturnValueOnce(
                [
                    "1111111111111111111111111111111111111111\trefs/tags/v1",
                    "2222222222222222222222222222222222222222\trefs/tags/v1^{}",
                ].join("\n"),
            );

        expect(resolveRef("owner/repo", "v1", execSyncImpl as never)).toBe(
            "2222222222222222222222222222222222222222",
        );
    });

    it("falls back to branch lookup when tag lookup is empty", () => {
        const execSyncImpl = vi
            .fn()
            .mockReturnValueOnce("")
            .mockReturnValueOnce(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main",
            );

        expect(resolveRef("owner/repo", "main", execSyncImpl as never)).toBe(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
    });

    it("returns null when no tag or branch matches", () => {
        const execSyncImpl = vi.fn().mockReturnValueOnce("").mockReturnValueOnce("");

        expect(resolveRef("owner/repo", "missing", execSyncImpl as never)).toBe(null);
    });
});

describe("updatePinnedActions", () => {
    it("exits with 0 when no references are found", () => {
        const logs: string[] = [];
        const exit = vi.fn((code: number) => {
            throw new Error(`exit:${code}`);
        });

        expect(() =>
            updatePinnedActions({
                globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
                readFileSyncImpl: vi.fn().mockReturnValue("name: CI\n"),
                writeFileSyncImpl: vi.fn(),
                execSyncImpl: vi.fn(),
                log: (msg) => logs.push(msg),
                exit: exit as never,
            }),
        ).toThrow("exit:0");

        expect(logs).toContain("No action references found.");
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("updates stale pinned and unpinned references", () => {
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

        expect(result).toEqual({
            filesScanned: 1,
            uniqueRefs: 2,
            updatedFiles: 1,
            updatedRefs: 2,
            alreadyCurrent: 0,
            failures: 0,
        });
        expect(files["workflow.yml"]).toContain(
            "owner/repo@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v1",
        );
        expect(files["workflow.yml"]).toContain(
            "other/action@cccccccccccccccccccccccccccccccccccccccc # v2",
        );
        expect(files["workflow.yml"]).toContain("./actions/local-action");
    });

    it("counts already-current references without rewriting", () => {
        const content =
            "uses: owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1\n";
        const writeFileSyncImpl = vi.fn();

        const result = updatePinnedActions({
            globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
            readFileSyncImpl: vi.fn().mockReturnValue(content),
            writeFileSyncImpl: writeFileSyncImpl as never,
            execSyncImpl: vi
                .fn()
                .mockReturnValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1") as never,
            log: () => {},
            exit: (() => {
                throw new Error("unexpected exit");
            }) as never,
        });

        expect(result.alreadyCurrent).toBe(1);
        expect(result.updatedRefs).toBe(0);
        expect(writeFileSyncImpl).not.toHaveBeenCalled();
    });

    it("exits with 1 when resolution fails", () => {
        const exit = vi.fn((code: number) => {
            throw new Error(`exit:${code}`);
        });

        expect(() =>
            updatePinnedActions({
                globSyncImpl: vi.fn().mockReturnValue(["workflow.yml"]),
                readFileSyncImpl: vi
                    .fn()
                    .mockReturnValue("uses: owner/repo@v1\n"),
                writeFileSyncImpl: vi.fn(),
                execSyncImpl: vi.fn().mockReturnValue(""),
                log: () => {},
                exit: exit as never,
            }),
        ).toThrow("exit:1");

        expect(exit).toHaveBeenCalledWith(1);
    });
});
