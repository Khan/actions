import {describe, expect, it} from "vitest";

import {
    AUTOFIX_SCOPES,
    findingLabelsForScope,
    isLoopEligible,
    resolveScope,
    SCOPE_LABELS,
    UNIMPLEMENTED_LABELS,
} from "./scope.ts";
import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
} from "../../review/lib/render-comment.ts";

describe("resolveScope", () => {
    it("reports none when no autofix label is present", () => {
        expect(resolveScope(["skip-ai-review", "bug"])).toEqual({
            status: "none",
        });
    });

    it("arms a single scope", () => {
        const result = resolveScope(["autofix: blocking"]);
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["blocking"]);
        expect(result.request.labels).toEqual(["autofix: blocking"]);
        expect(result.request.findingLabels).toEqual([...BLOCKING_LABELS]);
    });

    it("unions both scopes and orders them canonically", () => {
        // Labels supplied in the reverse of AUTOFIX_SCOPES order.
        const result = resolveScope(["autofix: nits", "autofix: blocking"]);
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["blocking", "nits"]);
        expect(result.request.findingLabels).toEqual([
            ...BLOCKING_LABELS,
            ...NON_BLOCKING_LABELS,
        ]);
    });

    it("ignores non-autofix labels alongside an autofix one", () => {
        const result = resolveScope(["bug", "autofix: nits", "priority"]);
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["nits"]);
    });

    it("rejects a label on an axis this version does not implement", () => {
        const result = resolveScope(["autofix: blocking", "autofix: loop"]);
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
            return;
        }
        expect(result.labels).toEqual(["autofix: loop"]);
        expect(result.reason).toContain("cadence");
    });

    it("rejects rather than ignores an unrecognised autofix label", () => {
        const result = resolveScope(["autofix: everything"]);
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
            return;
        }
        expect(result.reason).toContain("unrecognised");
        // The message tells the author what they could have used instead.
        expect(result.reason).toContain("autofix: blocking");
    });

    it("rejects when an unimplemented label is present even with a valid one", () => {
        // Guards the silent-drop failure: honouring the blocking half of
        // `blocking + loop` would look like a loop that stopped after one run.
        expect(resolveScope(["autofix: nits", "autofix: human"]).status).toBe(
            "rejected",
        );
    });
});

describe("the label vocabulary", () => {
    it("keeps every known label inside the shared namespace", () => {
        for (const label of [
            ...Object.keys(SCOPE_LABELS),
            ...Object.keys(UNIMPLEMENTED_LABELS),
        ]) {
            expect(label.startsWith("autofix: ")).toBe(true);
        }
    });

    it("never lets a label mean two things", () => {
        for (const label of Object.keys(SCOPE_LABELS)) {
            expect(UNIMPLEMENTED_LABELS[label]).toBeUndefined();
        }
    });

    it("covers every scope with exactly one label", () => {
        expect(Object.values(SCOPE_LABELS).sort()).toEqual(
            [...AUTOFIX_SCOPES].sort(),
        );
    });
});

describe("isLoopEligible", () => {
    // The constraint most likely to be violated by whoever adds the cadence
    // axis: non-blocking findings have no fixed point, so they cannot loop.
    it("allows blocking scope to loop", () => {
        expect(isLoopEligible("blocking")).toBe(true);
    });

    it("forbids nits from ever looping", () => {
        expect(isLoopEligible("nits")).toBe(false);
    });
});

describe("findingLabelsForScope", () => {
    it("maps each scope onto the reviewer's own taxonomy", () => {
        expect(findingLabelsForScope("blocking")).toEqual(BLOCKING_LABELS);
        expect(findingLabelsForScope("nits")).toEqual(NON_BLOCKING_LABELS);
    });

    it("keeps the two classes disjoint", () => {
        const blocking = new Set<string>(findingLabelsForScope("blocking"));
        for (const label of findingLabelsForScope("nits")) {
            expect(blocking.has(label)).toBe(false);
        }
    });
});
