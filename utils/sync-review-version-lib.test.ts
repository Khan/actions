import {describe, expect, it, vi} from "vitest";
import {
    syncReviewVersion,
    syncReviewVersionContent,
} from "./sync-review-version-lib.ts";

describe("syncReviewVersionContent", () => {
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
        const result = syncReviewVersionContent(content, "9.9.9");

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
        const result = syncReviewVersionContent(content, "2.0.0");

        // Assert
        expect(result.replaced).toBe(2);
        expect(result.content).toBe(
            "ref: review-v2.0.0\n" +
                "the marker is `v=review-v<version>` (a template)\n" +
                "released as review-v2.0.0\n",
        );
    });

    it("returns unchanged content when already at the version", () => {
        // Act
        const result = syncReviewVersionContent("ref: review-v1.4.0", "1.4.0");

        // Assert
        expect(result.replaced).toBe(1);
        expect(result.content).toBe("ref: review-v1.4.0");
    });
});

describe("syncReviewVersion", () => {
    const makeDeps = (files: Record<string, string>) => {
        const writes: Record<string, string> = {};
        return {
            writes,
            deps: {
                readFileSyncImpl: ((p: string) => {
                    const content = files[p];
                    if (content === undefined) {
                        throw new Error(`unexpected read: ${p}`);
                    }
                    return content;
                }) as never,
                writeFileSyncImpl: ((p: string, data: string) => {
                    writes[p] = data;
                }) as never,
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
        syncReviewVersion(deps);

        // Assert
        expect(writes["workflows/review/review.md"]).toBe(
            "      ref: review-v1.5.0\n",
        );
    });

    it("does not write when the ref is already current", () => {
        // Arrange
        const {writes, deps} = makeDeps({
            "workflows/review/package.json":
                '{"name": "review", "version": "1.5.0"}',
            "workflows/review/review.md": "      ref: review-v1.5.0\n",
        });

        // Act
        syncReviewVersion(deps);

        // Assert
        expect(writes).toEqual({});
    });

    it("throws when review.md has no review-v literal to sync", () => {
        // Arrange
        const {deps} = makeDeps({
            "workflows/review/package.json":
                '{"name": "review", "version": "1.5.0"}',
            "workflows/review/review.md": "no pinned ref here\n",
        });

        // Act + Assert
        expect(() => syncReviewVersion(deps)).toThrow(
            /No review-v<semver> literals/,
        );
    });

    it("throws when package.json has no version", () => {
        // Arrange
        const {deps} = makeDeps({
            "workflows/review/package.json": '{"name": "review"}',
            "workflows/review/review.md": "ref: review-v1.2.2\n",
        });

        // Act + Assert
        expect(() => syncReviewVersion(deps)).toThrow(/No version found/);
    });
});
