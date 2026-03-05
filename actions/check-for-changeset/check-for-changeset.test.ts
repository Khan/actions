import {describe, expect, it, vi} from "vitest";
import checkForChangeset from "./index.ts";

const makeCore = () => ({
    debug: vi.fn(),
    setFailed: vi.fn(),
});

describe("checkForChangeset", () => {
    it("returns early when no relevant files changed", () => {
        // Arrange
        const core = makeCore();

        // Act
        checkForChangeset({
            context: {payload: {pull_request: {head: {ref: "feature-branch"}}}},
            core,
            inputFiles: [],
        });

        // Assert
        expect({
            debugCalls: core.debug.mock.calls.length,
            failedCalls: core.setFailed.mock.calls.length,
        }).toEqual({debugCalls: 0, failedCalls: 0});
    });

    it("skips enforcement for changeset release branch", () => {
        // Arrange
        const core = makeCore();

        // Act
        checkForChangeset({
            context: {
                payload: {
                    pull_request: {head: {ref: "changeset-release/main"}},
                },
            },
            core,
            inputFiles: ["packages/pkg/src/index.ts"],
        });

        // Assert
        expect({
            debugCall: core.debug.mock.calls[0]?.[0],
            failedCalls: core.setFailed.mock.calls.length,
        }).toEqual({
            debugCall: "Changed files: packages/pkg/src/index.ts",
            failedCalls: 0,
        });
    });

    it("passes when a changeset markdown file exists", () => {
        // Arrange
        const core = makeCore();

        // Act
        checkForChangeset({
            context: {payload: {pull_request: {head: {ref: "feature-branch"}}}},
            core,
            inputFiles: [
                "packages/pkg/src/index.ts",
                ".changeset/add-thing.md",
            ],
        });

        // Assert
        expect(core.setFailed.mock.calls.length).toBe(0);
    });

    it("fails when no changeset markdown file exists", () => {
        // Arrange
        const core = makeCore();

        // Act
        checkForChangeset({
            context: {payload: {pull_request: {head: {ref: "feature-branch"}}}},
            core,
            inputFiles: ["packages/pkg/src/index.ts"],
        });

        // Assert
        expect(core.setFailed.mock.calls[0]?.[0]).toContain(
            "This PR does not have a changeset.",
        );
    });
});
