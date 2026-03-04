import {describe, expect, it, vi} from "vitest";
import checkForChangeset from "./index.ts";

const makeCore = () => ({
    debug: vi.fn(),
    setFailed: vi.fn(),
});

describe("checkForChangeset", () => {
    it("returns early when no relevant files changed", () => {
        const core = makeCore();

        checkForChangeset({
            context: {payload: {pull_request: {head: {ref: "feature-branch"}}}},
            core,
            inputFiles: [],
        });

        expect(core.debug).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("skips enforcement for changeset release branch", () => {
        const core = makeCore();

        checkForChangeset({
            context: {
                payload: {
                    pull_request: {head: {ref: "changeset-release/main"}},
                },
            },
            core,
            inputFiles: ["packages/pkg/src/index.ts"],
        });

        expect(core.debug).toHaveBeenCalledWith(
            "Changed files: packages/pkg/src/index.ts",
        );
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("passes when a changeset markdown file exists", () => {
        const core = makeCore();

        checkForChangeset({
            context: {payload: {pull_request: {head: {ref: "feature-branch"}}}},
            core,
            inputFiles: ["packages/pkg/src/index.ts", ".changeset/add-thing.md"],
        });

        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("fails when no changeset markdown file exists", () => {
        const core = makeCore();

        checkForChangeset({
            context: {payload: {pull_request: {head: {ref: "feature-branch"}}}},
            core,
            inputFiles: ["packages/pkg/src/index.ts"],
        });

        expect(core.setFailed).toHaveBeenCalledTimes(1);
        expect(core.setFailed.mock.calls[0]?.[0]).toContain(
            "This PR does not have a changeset.",
        );
    });
});
