import {describe, it, expect} from "vitest";

import {parseRoutingConfig} from "./routing-config";

/**
 * The retired `re-review` posting modifiers (`blocking-only`,
 * `blocking-medium`, removed in PRA-53: repeat reviews post the full
 * surface). A leftover modifier in a consumer's ROUTING file must warn and
 * be ignored, never crash the parse or eat the mode; these cases replace
 * router-rereview-blocking-only.test.ts and
 * router-rereview-blocking-medium.test.ts, which pinned the live behavior.
 */
describe("parseRoutingConfig: retired re-review modifiers", () => {
    it("warns and ignores a leftover blocking-only; the mode still applies", () => {
        const config = parseRoutingConfig("re-review scoped blocking-only");
        expect(config.reReviewMode).toBe("scoped");
        expect(config.warnings.join("\n")).toContain(
            "blocking-only is retired",
        );
    });

    it("warns and ignores a leftover blocking-medium; the mode still applies", () => {
        const config = parseRoutingConfig("re-review scoped blocking-medium");
        expect(config.reReviewMode).toBe("scoped");
        expect(config.warnings.join("\n")).toContain(
            "blocking-medium is retired",
        );
    });

    it("still warns on an unknown modifier, with the unknown wording", () => {
        const config = parseRoutingConfig("re-review scoped fast");
        expect(config.reReviewMode).toBe("scoped");
        expect(config.warnings.join("\n")).toContain(
            'unknown re-review modifier "fast"',
        );
    });

    it("duplicate re-review lines still resolve last-wins", () => {
        const config = parseRoutingConfig(
            "re-review scoped blocking-only\nre-review fast",
        );
        expect(config.reReviewMode).toBe("fast");
        expect(config.warnings.join("\n")).toContain("duplicate re-review");
    });

    it("routing.json carries no modifier flags", () => {
        const config = parseRoutingConfig("re-review scoped blocking-medium");
        expect(config).not.toHaveProperty("reReviewBlockingOnly");
        expect(config).not.toHaveProperty("reReviewBlockingMedium");
    });
});
