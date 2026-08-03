import {describe, it, expect} from "vitest";

import {renderProbes, summarizeProbes, type ProbeResult} from "./sandbox-smoke";

/**
 * The sandbox smoke's gate decision. The probes themselves need a real
 * bubblewrap sandbox and are exercised by the CI job; what is unit-testable is
 * the part that decides pass from fail, and the one rule that is easy to get
 * wrong: an empty probe set is a failure, not a pass.
 */

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
    name: "write to the checkout",
    expected: "denied",
    satisfied: true,
    detail: "refused",
    ...overrides,
});

describe("summarizeProbes", () => {
    it("passes only when every probe landed on the policy's side", () => {
        expect(summarizeProbes([probe(), probe({name: "read"})])).toEqual({
            ok: true,
            failed: [],
        });
    });

    it("names every contradicted probe", () => {
        const verdict = summarizeProbes([
            probe(),
            probe({name: "open a TCP connection", satisfied: false}),
            probe({name: "append to the cap journal", satisfied: false}),
        ]);
        expect(verdict.ok).toBe(false);
        expect(verdict.failed).toEqual([
            "open a TCP connection",
            "append to the cap journal",
        ]);
    });

    it("fails an empty probe set: nothing ran, so nothing is proven", () => {
        // The whole job exists to answer a question. "No probes" answers it
        // with silence, and a green wall on silence is how an untested
        // writable mount reaches a consumer's PR.
        expect(summarizeProbes([])).toEqual({ok: false, failed: []});
    });
});

describe("renderProbes", () => {
    it("marks a contradicted probe and leaves an expected one plain", () => {
        const table = renderProbes([
            probe(),
            probe({name: "open a TCP connection", satisfied: false}),
        ]);
        expect(table).toContain(
            "| write to the checkout | denied | as expected",
        );
        expect(table).toContain(
            "| open a TCP connection | denied | **CONTRADICTED**",
        );
    });

    it("escapes pipes so command output cannot break the table", () => {
        const table = renderProbes([probe({detail: "grep foo | wc -l"})]);
        expect(table).toContain("grep foo \\| wc -l");
    });
});
