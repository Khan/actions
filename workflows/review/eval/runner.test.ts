import {describe, expect, expectTypeOf, it} from "vitest";

import type {CorpusCase} from "./corpus/loader";
import {runCase, type PlannedReview} from "./runner";

describe("planned review events", () => {
    it("accepts every submittable review event and null, but not a hold", () => {
        expectTypeOf<PlannedReview["event"]>().toEqualTypeOf<
            "APPROVE" | "COMMENT" | "REQUEST_CHANGES" | null
        >();
    });

    it.each([
        ["advisory", "assessed", "APPROVE", "APPROVE"],
        ["medium", "assessed", "COMMENT", "COMMENT"],
        ["blocking", "assessed", "REQUEST_CHANGES", "REQUEST_CHANGES"],
        ["advisory", "unavailable", "HOLD_FOR_HUMAN", null],
        ["medium", "unavailable", "HOLD_FOR_HUMAN", null],
    ] as const)(
        "%s finding with correctness %s maps %s to %s",
        (severity, correctness, verdict, event) => {
            const corpusCase: CorpusCase = {
                id: "review-event",
                tags: [],
                category: "synthetic-mutation",
                description: "Review event mapping",
                changedFiles: [{path: "src/example.ts", status: "modified"}],
                dimensions: {
                    correctness,
                    skillSeverity: "assessed",
                    patternTriage: "assessed",
                },
                findings: [
                    {
                        source: "correctness",
                        finding: {
                            schema_version: 2,
                            id: "finding",
                            lens: "correctness",
                            anchor: {
                                type: "line",
                                path: "src/example.ts",
                                line: 1,
                                side: "RIGHT",
                            },
                            severity,
                            confidence: 0.9,
                            evidence_trace: ["src/example.ts:1"],
                            failure_scenario: "An empty input throws.",
                            producing_hunt: "test:review-event",
                            model_authored_prose: "Handle the empty input.",
                        },
                    },
                ],
                validation: [{id: "finding", verification: "confirmed"}],
                policyConflicts: [],
                expected: {verdict},
                sourcePath: "runner.test.ts",
            };

            const result = runCase(corpusCase);

            expect(result.verdict.event).toBe(verdict);
            expect(result.plannedReview.event).toBe(event);
            expect(result.posted).toBe(false);
            if (event === "COMMENT") {
                expect(result.plannedReview.body).not.toBe("");
                expect(result.plannedReview.comments).toEqual([
                    {
                        path: "src/example.ts",
                        line: 1,
                        body: expect.stringContaining(
                            "Handle the empty input.",
                        ),
                    },
                ]);
            }
        },
    );
});
