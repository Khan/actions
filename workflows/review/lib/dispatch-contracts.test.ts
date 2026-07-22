import {describe, it, expect} from "vitest";

import {joinProse, parseFinderOutput} from "./dispatch-contracts";

/**
 * Contract-parse tests for the label-shape mapping (dispatch-contracts.ts),
 * split from dispatch.test.ts alongside the module split. These pin the
 * run-29897276810 fixes: the ReportFindings-shape near-miss salvage, the
 * label-contract rejection that feeds the malformed-output retry, and the
 * punctuation-aware subject/discussion join.
 */

describe("label-contract enforcement (run 29897276810)", () => {
    it("salvages a ReportFindings-style near-miss that still carries a valid label", () => {
        // path lives in anchor/file, subject in summary (the run-29897276810
        // drift), but the label contract is honoured: salvage, don't reject.
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        anchor: {path: "a.ts", line: 38},
                        file: "a.ts",
                        label: "issue (blocking)",
                        summary: "AddDate subtracts months, not days.",
                        discussion: "The signature is (years, months, days).",
                        failure_scenario: "nothing ever expires",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.anchor).toMatchObject({
            path: "a.ts",
            line: 38,
        });
        expect(candidates[0].finding.severity).toBe("blocking");
        expect(candidates[0].finding.model_authored_prose).toBe(
            "AddDate subtracts months, not days. The signature is (years, months, days).",
        );
    });

    it("salvages a title-keyed subject (run 29908199997's drift shape)", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        id: "unbounded-expiration-read",
                        file: "a.go",
                        anchor: {path: "a.go", line: 44},
                        label: "issue (blocking)",
                        category: "resource-exhaustion",
                        title: "Expiration query is unbounded.",
                        discussion: "The query has no Limit and no KeysOnly.",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.model_authored_prose).toBe(
            "Expiration query is unbounded. The query has no Limit and no KeysOnly.",
        );
        expect(candidates[0].finding.failure_scenario).toBe(
            "Expiration query is unbounded.",
        );
    });

    it("salvages a label-valid finding with only {id, anchor, discussion} (run 29906543140)", () => {
        // Round-2 correctness drift: valid label, anchor object, rich
        // discussion, but no subject/summary and no failure_scenario.
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        id: "ttl-months-vs-days",
                        label: "issue (blocking)",
                        anchor: {path: "a.go", line: 38},
                        discussion:
                            "AddDate(0, -MemoryTTLDays, 0) passes 180 into the months parameter, so the cutoff is 15 years in the past.",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.severity).toBe("blocking");
        expect(candidates[0].finding.anchor).toMatchObject({
            path: "a.go",
            line: 38,
        });
        expect(candidates[0].finding.failure_scenario).toContain("AddDate");
    });

    it("salvages suggested_patch as the one-click fix (run 29943085279's drift shape)", () => {
        // That run's correctness pass emitted the ReportFindings-style keys
        // (id, label, severity, category, anchor, summary, discussion,
        // failure_scenario, suggested_patch); the label was valid so the
        // finding salvaged, but the AddDate fix under suggested_patch was
        // dropped and the posted comment carried no suggestion fence.
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        id: "ttl-months-not-days",
                        label: "issue (blocking)",
                        severity: "blocking",
                        category: "correctness",
                        anchor: {
                            path: "services/ai-guide/memory/expiration.go",
                            line: 38,
                        },
                        summary:
                            "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months (15 years), not 180 days; the retention cutoff is ~2011, so no memory is ever expired and the entire feature is a silent no-op.",
                        discussion:
                            "Go's time.Time.AddDate signature is AddDate(years, months, days), so the day count lands in the months slot.",
                        failure_scenario:
                            "A user has memories written 181+ days ago; ExpireStale computes cutoff = now minus 180 months, finds no memory older than that, deletes nothing.",
                        suggested_patch:
                            "cutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.suggested_patch).toBe(
            "cutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
        );
    });

    it("prefers suggestion over suggested_patch when a finding carries both", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        path: "a.go",
                        line: 38,
                        label: "issue (blocking)",
                        subject: "s",
                        discussion: "d",
                        failure_scenario: "f",
                        suggestion: "the contract key",
                        suggested_patch: "the drift key",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates[0].finding.suggested_patch).toBe("the contract key");
    });

    it("rejects a finding whose label is missing or unknown (the run's ReportFindings shape)", () => {
        const reportFindingsShape = JSON.stringify({
            findings: [
                {
                    id: "adddate-months-not-days",
                    severity: "blocking",
                    category: "correctness",
                    verdict: "CONFIRMED",
                    file: "a.ts",
                    anchor: {path: "a.ts", line: 38},
                    line: 38,
                    summary: "AddDate subtracts 180 months, not 180 days.",
                    failure_scenario: "retention never expires anything",
                    discussion: "AddDate's signature is (years, months, days).",
                },
            ],
        });
        expect(() =>
            parseFinderOutput(
                "correctness-reviewer",
                reportFindingsShape,
                new Set(),
            ),
        ).toThrow(
            /findings\[0\] label "" is not a Conventional Comments label/,
        );
        expect(() =>
            parseFinderOutput(
                "correctness-reviewer",
                JSON.stringify({
                    findings: [
                        {
                            path: "a.ts",
                            line: 2,
                            label: "blocker (critical)",
                            subject: "s",
                            discussion: "d",
                            failure_scenario: "f",
                        },
                    ],
                }),
                new Set(),
            ),
        ).toThrow(
            /"blocker \(critical\)" is not a Conventional Comments label/,
        );
    });

    it("joins subject and discussion with a sentence break only when needed", () => {
        expect(joinProse("No terminal punctuation", "Both tests pass.")).toBe(
            "No terminal punctuation. Both tests pass.",
        );
        expect(joinProse("Ends with a period.", "More detail.")).toBe(
            "Ends with a period. More detail.",
        );
        expect(joinProse("Ends inside `code.`", "More detail.")).toBe(
            "Ends inside `code.` More detail.",
        );
        expect(joinProse("Ends with a colon:", "the list.")).toBe(
            "Ends with a colon: the list.",
        );
        expect(joinProse("Only a subject", "")).toBe("Only a subject");
        expect(joinProse("", "Only a discussion.")).toBe("Only a discussion.");
    });
});
