import {describe, it, expect, afterEach} from "vitest";

import {piRunner} from "./live-runner";

/**
 * The stale-seam tripwire. The `REVIEW_DISPATCH_RUNNER` selection went away
 * with the Claude Agent SDK harness; an operator still exporting `sdk` must
 * get an error, not a silent run of the other harness (the arm under test
 * swapping invisibly is the worst failure a harness seam can have).
 */

const original = process.env["REVIEW_DISPATCH_RUNNER"];

afterEach(() => {
    if (original === undefined) {
        delete process.env["REVIEW_DISPATCH_RUNNER"];
    } else {
        process.env["REVIEW_DISPATCH_RUNNER"] = original;
    }
});

describe("piRunner", () => {
    it("constructs when no stale runner selection is present", () => {
        delete process.env["REVIEW_DISPATCH_RUNNER"];
        expect(typeof piRunner()).toBe("function");
    });

    it("tolerates the redundant-but-accurate value", () => {
        process.env["REVIEW_DISPATCH_RUNNER"] = "pi";
        expect(() => piRunner()).not.toThrow();
    });

    it("throws on a stale SDK selection rather than silently running Pi", () => {
        for (const stale of ["sdk", "sdkk", "claude", ""]) {
            process.env["REVIEW_DISPATCH_RUNNER"] = stale;
            expect(() => piRunner()).toThrow(/selects nothing/);
        }
    });
});
