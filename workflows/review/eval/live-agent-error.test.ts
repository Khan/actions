import {describe, expect, it} from "vitest";

import {addAccounting, LiveAgentError} from "./live-agent-error";

describe("addAccounting", () => {
    it("adds reported counters and leaves unreported ones undefined", () => {
        const total: {
            toolCalls?: number;
            deniedReads?: number;
            deniedTools?: number;
        } = {};
        addAccounting(total, {toolCalls: 5});
        expect(total).toEqual({toolCalls: 5});
        // A runner that cannot count reports nothing, never a false zero.
        expect(total.deniedReads).toBeUndefined();
        expect(total.deniedTools).toBeUndefined();
        addAccounting(total, {toolCalls: 3, deniedReads: 2, deniedTools: 0});
        expect(total).toEqual({toolCalls: 8, deniedReads: 2, deniedTools: 0});
        addAccounting(total, {});
        expect(total).toEqual({toolCalls: 8, deniedReads: 2, deniedTools: 0});
    });

    it("folds a LiveAgentError's partial the same way", () => {
        const error = new LiveAgentError("timed out", {deniedReads: 1});
        const total = {toolCalls: 4};
        addAccounting(total, error.partial);
        expect(total).toEqual({toolCalls: 4, deniedReads: 1});
        expect(error.name).toBe("LiveAgentError");
    });
});
