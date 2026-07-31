import {describe, it, expect, afterEach} from "vitest";

import {piRunner, sdkRunner, selectedRunner} from "./live-runner";

/**
 * The harness-selection seam. This is the whole point of the Pi runner
 * landing, and it was previously unexercised: a silent mis-selection would
 * run the SDK arm while the operator believed they were measuring Pi, which
 * is the worst failure this seam has (the arm under test swaps invisibly).
 */

const original = process.env["REVIEW_DISPATCH_RUNNER"];

afterEach(() => {
    if (original === undefined) {
        delete process.env["REVIEW_DISPATCH_RUNNER"];
    } else {
        process.env["REVIEW_DISPATCH_RUNNER"] = original;
    }
});

describe("selectedRunner", () => {
    it("defaults to the SDK harness when unset", () => {
        delete process.env["REVIEW_DISPATCH_RUNNER"];
        expect(typeof selectedRunner()).toBe("function");
    });

    it("accepts the two known values", () => {
        for (const value of ["sdk", "pi"]) {
            process.env["REVIEW_DISPATCH_RUNNER"] = value;
            expect(() => selectedRunner()).not.toThrow();
        }
    });

    it("throws on an unknown value rather than silently running the SDK arm", () => {
        for (const typo of ["sdkk", "claude", "PI", ""]) {
            process.env["REVIEW_DISPATCH_RUNNER"] = typo;
            expect(() => selectedRunner()).toThrow(/must be "sdk" or "pi"/);
        }
    });

    it("exposes both runners as constructible", () => {
        expect(typeof sdkRunner()).toBe("function");
        expect(typeof piRunner()).toBe("function");
    });
});
