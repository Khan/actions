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
