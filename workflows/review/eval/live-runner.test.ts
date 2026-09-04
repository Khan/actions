import {describe, it, expect, afterEach, beforeEach, vi} from "vitest";

import {piRunner} from "./live-runner";

/**
 * The stale-seam tripwire and the shared-construction contract.
 *
 * The `REVIEW_DISPATCH_RUNNER` selection went away with the Claude Agent SDK
 * harness; an operator still exporting `sdk` must get an error, not a silent
 * run of the other harness (the arm under test swapping invisibly is the worst
 * failure a harness seam can have). And `produceLive` fans the roster out
 * concurrently through one `piRunner` closure, so that closure must construct
 * the runner (and initialize the srt sandbox) exactly once.
 */

/** Constructions observed, with the real `rejectStaleRunnerSelection` kept. */
let created = 0;

vi.mock("../lib/dispatch-runner-pi", async (importOriginal) => {
    const actual = await importOriginal<
        typeof import("../lib/dispatch-runner-pi")
    >();
    return {
        ...actual,
        createPiRunner: async () => {
            created += 1;
            // Yield before resolving: a cache that memoizes the RESOLVED
            // runner rather than the promise lets concurrent callers past the
            // guard here, which is the bug this test pins.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return () =>
                Promise.resolve({output: "{}", usd: 0, turns: 0, wallMs: 0});
        },
    };
});

const original = process.env["REVIEW_DISPATCH_RUNNER"];

beforeEach(() => {
    created = 0;
});

afterEach(() => {
    if (original === undefined) {
        delete process.env["REVIEW_DISPATCH_RUNNER"];
    } else {
        process.env["REVIEW_DISPATCH_RUNNER"] = original;
    }
});

const request = {
    name: "correctness-reviewer",
    model: "claude-opus-4-8",
    prompt: "review the diff",
    cwd: "/tmp",
    maxTurns: 30,
    timeoutMs: 60_000,
};

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

    it("builds one runner for a concurrent wave of dispatches", async () => {
        // The eval dispatches at DEFAULT_CONCURRENCY (4), so the whole first
        // wave arrives before any construction resolves. Four constructions
        // would mean four concurrent srt initializations.
        delete process.env["REVIEW_DISPATCH_RUNNER"];
        const runner = piRunner();
        const results = await Promise.all([
            runner(request),
            runner(request),
            runner(request),
            runner(request),
        ]);
        expect(created).toBe(1);
        expect(results.map((result) => result.output)).toEqual([
            "{}",
            "{}",
            "{}",
            "{}",
        ]);
    });

    it("reuses the same runner across sequential dispatches", async () => {
        delete process.env["REVIEW_DISPATCH_RUNNER"];
        const runner = piRunner();
        await runner(request);
        await runner(request);
        expect(created).toBe(1);
    });
});
