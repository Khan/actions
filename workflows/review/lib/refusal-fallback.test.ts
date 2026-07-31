import {describe, it, expect} from "vitest";

import {REFUSAL_FALLBACK, refusalFallbackFor} from "./refusal-fallback";

describe("refusalFallbackFor", () => {
    it("sends the measured refuser to Opus 4.8", () => {
        // Fable 5 is not a prediction: run 30656579898 caught it refusing
        // `incident-auth-bypass` under Anthropic's usage policy.
        expect(refusalFallbackFor("claude-fable-5")).toBe("claude-opus-4-8");
    });

    it("covers Opus 5 pre-emptively", () => {
        expect(refusalFallbackFor("claude-opus-5")).toBe("claude-opus-4-8");
    });

    it("has no fallback for an unlisted model, so its refusal stays visible", () => {
        expect(refusalFallbackFor("claude-sonnet-4-6")).toBeUndefined();
        expect(refusalFallbackFor("claude-opus-4-8")).toBeUndefined();
    });

    it("refuses to loop back to a model that already refused", () => {
        expect(
            refusalFallbackFor("claude-fable-5", [
                "claude-fable-5",
                "claude-opus-4-8",
            ]),
        ).toBeUndefined();
    });

    it("never maps a model to itself", () => {
        for (const [from, to] of Object.entries(REFUSAL_FALLBACK)) {
            expect(to).not.toBe(from);
        }
    });
});
