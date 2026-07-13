import {describe, it, expect} from "vitest";

import {
    FINDING_SCHEMA_VERSION,
    KNOWN_LENSES,
    SEVERITIES,
    ANCHOR_TYPES,
    MIN_CONFIDENCE,
    MAX_CONFIDENCE,
    validateFinding,
    isValidFinding,
    assertFinding,
    validateOutOfLaneObservation,
    isValidOutOfLaneObservation,
} from "./finding-schema.ts";

/**
 * Unit tests for the versioned structured finding schema/validator.
 * Covers the exported version constant, well-formed findings across
 * every anchor type + optional fields, and malformed findings for every
 * required field — including the all-violations collection behavior the coder
 * documented (so per-lens validator drop-rate stays diagnosable).
 */

// A minimal well-formed finding. Individual tests clone + mutate this so a
// single field is the only thing under test.
const makeValidFinding = (overrides: Record<string, unknown> = {}) => ({
    schema_version: FINDING_SCHEMA_VERSION,
    id: "finding-1",
    lens: "security-auth",
    anchor: {type: "line", path: "src/app.ts", line: 42},
    severity: "blocking",
    confidence: 0.9,
    evidence_trace: ["src/app.ts:42 calls exec() with unsanitized input"],
    failure_scenario:
        "A request whose `name` param contains `; rm -rf /` reaches exec() unescaped and runs as a shell command.",
    producing_hunt: "security-auth/command-injection",
    model_authored_prose: "User input flows unsanitized into a shell command.",
    ...overrides,
});

describe("FINDING_SCHEMA_VERSION", () => {
    it("is the exported monotonic constant (===2 since failure_scenario)", () => {
        expect(FINDING_SCHEMA_VERSION).toBe(2);
        expect(typeof FINDING_SCHEMA_VERSION).toBe("number");
    });
});

describe("exported canonical lists", () => {
    it("KNOWN_LENSES contains the eleven specialist lenses", () => {
        for (const lens of [
            "security-auth",
            "ai-safety-moderation",
            "mass-comms-coppa",
            "caching-resource",
            "data-migrations",
            "concurrency-async",
            "api-federation-compat",
            "cross-deploy-serialization",
            "deploy-infra-config",
            "money-payments",
            "content-i18n",
        ]) {
            expect(KNOWN_LENSES).toContain(lens);
        }
    });

    it("KNOWN_LENSES contains the always-on / triage reviewers", () => {
        expect(KNOWN_LENSES).toContain("correctness");
        expect(KNOWN_LENSES).toContain("pattern-triage");
        expect(KNOWN_LENSES).toContain("first-principles");
    });

    it("SEVERITIES is exactly blocking + advisory (#194 axis)", () => {
        expect([...SEVERITIES]).toEqual(["blocking", "advisory"]);
    });

    it("ANCHOR_TYPES includes the required PR-level anchor", () => {
        expect([...ANCHOR_TYPES]).toEqual(["line", "file", "pr"]);
    });

    it("confidence bounds are the closed unit interval", () => {
        expect(MIN_CONFIDENCE).toBe(0);
        expect(MAX_CONFIDENCE).toBe(1);
    });
});

describe("validateFinding — well-formed findings", () => {
    it("accepts a minimal well-formed line-anchored finding", () => {
        const result = validateFinding(makeValidFinding());
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.finding.id).toBe("finding-1");
        }
    });

    it("accepts a multi-line range anchor with an explicit side", () => {
        const result = validateFinding(
            makeValidFinding({
                anchor: {
                    type: "line",
                    path: "src/app.ts",
                    line: 50,
                    start_line: 42,
                    side: "RIGHT",
                },
            }),
        );
        expect(result.ok).toBe(true);
    });

    it("accepts a LEFT-side line anchor", () => {
        const result = validateFinding(
            makeValidFinding({
                anchor: {
                    type: "line",
                    path: "src/app.ts",
                    line: 7,
                    side: "LEFT",
                },
            }),
        );
        expect(result.ok).toBe(true);
    });

    it("accepts a file-level anchor", () => {
        const result = validateFinding(
            makeValidFinding({anchor: {type: "file", path: "src/app.ts"}}),
        );
        expect(result.ok).toBe(true);
    });

    it("accepts a PR-level anchor with no path/line", () => {
        const result = validateFinding(
            makeValidFinding({anchor: {type: "pr"}}),
        );
        expect(result.ok).toBe(true);
    });

    it("accepts advisory severity", () => {
        expect(
            validateFinding(makeValidFinding({severity: "advisory"})).ok,
        ).toBe(true);
    });

    it("accepts confidence at both interval boundaries", () => {
        expect(validateFinding(makeValidFinding({confidence: 0})).ok).toBe(
            true,
        );
        expect(validateFinding(makeValidFinding({confidence: 1})).ok).toBe(
            true,
        );
    });

    it("accepts the optional suggested_patch + pre_merge_obligation when present", () => {
        const result = validateFinding(
            makeValidFinding({
                suggested_patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
                pre_merge_obligation: "Rotate the leaked key before merge.",
            }),
        );
        expect(result.ok).toBe(true);
    });

    it("accepts the optional rule_quote when present and non-empty", () => {
        const result = validateFinding(
            makeValidFinding({
                rule_quote:
                    "Always wrap errors with errors.Wrap before returning them.",
            }),
        );
        expect(result.ok).toBe(true);
    });

    it("rejects an empty or non-string rule_quote", () => {
        for (const bad of ["", 42]) {
            const result = validateFinding(makeValidFinding({rule_quote: bad}));
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(
                    result.errors.some((e) => e.startsWith("rule_quote:")),
                ).toBe(true);
            }
        }
    });

    it("accepts every KNOWN_LENSES value", () => {
        for (const lens of KNOWN_LENSES) {
            expect(validateFinding(makeValidFinding({lens})).ok).toBe(true);
        }
    });
});

describe("validateFinding — malformed findings", () => {
    const expectRejects = (input: unknown, matcher: RegExp) => {
        const result = validateFinding(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.some((e) => matcher.test(e))).toBe(true);
        }
    };

    it("rejects a non-object input", () => {
        expectRejects(null, /finding: must be an object/);
        expectRejects("nope", /finding: must be an object/);
        expectRejects([makeValidFinding()], /finding: must be an object/);
    });

    it("rejects an unrecognized schema_version (too low, too high, missing)", () => {
        expectRejects(makeValidFinding({schema_version: 0}), /schema_version/);
        expectRejects(
            makeValidFinding({schema_version: FINDING_SCHEMA_VERSION + 1}),
            /schema_version/,
        );
        const noVersion: Record<string, unknown> = {...makeValidFinding()};
        delete noVersion["schema_version"];
        expectRejects(noVersion, /schema_version/);
    });

    it("rejects a missing / empty id", () => {
        expectRejects(makeValidFinding({id: ""}), /^id:/);
        expectRejects(makeValidFinding({id: 123}), /^id:/);
    });

    it("rejects an unknown or non-string lens", () => {
        expectRejects(makeValidFinding({lens: "no-such-lens"}), /^lens:/);
        expectRejects(makeValidFinding({lens: 42}), /^lens:/);
    });

    it("rejects a bad severity", () => {
        expectRejects(makeValidFinding({severity: "nit"}), /^severity:/);
    });

    it("rejects out-of-range / non-numeric confidence", () => {
        expectRejects(makeValidFinding({confidence: -0.1}), /^confidence:/);
        expectRejects(makeValidFinding({confidence: 1.1}), /^confidence:/);
        expectRejects(makeValidFinding({confidence: NaN}), /^confidence:/);
        expectRejects(makeValidFinding({confidence: "high"}), /^confidence:/);
    });

    it("rejects an empty / malformed evidence_trace", () => {
        expectRejects(makeValidFinding({evidence_trace: []}), /evidence_trace/);
        expectRejects(
            makeValidFinding({evidence_trace: "not-array"}),
            /evidence_trace/,
        );
        expectRejects(
            makeValidFinding({evidence_trace: [""]}),
            /evidence_trace/,
        );
        expectRejects(
            makeValidFinding({evidence_trace: ["ok", 3]}),
            /evidence_trace/,
        );
    });

    it("rejects a missing producing_hunt", () => {
        expectRejects(makeValidFinding({producing_hunt: ""}), /producing_hunt/);
    });

    it("rejects a missing / empty failure_scenario", () => {
        expectRejects(
            makeValidFinding({failure_scenario: ""}),
            /failure_scenario/,
        );
        const noScenario: Record<string, unknown> = {...makeValidFinding()};
        delete noScenario["failure_scenario"];
        expectRejects(noScenario, /failure_scenario/);
    });

    it("rejects a missing model_authored_prose", () => {
        expectRejects(
            makeValidFinding({model_authored_prose: ""}),
            /model_authored_prose/,
        );
    });

    it("rejects present-but-empty optional fields", () => {
        expectRejects(
            makeValidFinding({suggested_patch: ""}),
            /suggested_patch/,
        );
        expectRejects(
            makeValidFinding({pre_merge_obligation: ""}),
            /pre_merge_obligation/,
        );
    });

    describe("anchor", () => {
        it("rejects a non-object anchor", () => {
            expectRejects(
                makeValidFinding({anchor: "line"}),
                /anchor: must be an object/,
            );
        });

        it("rejects an unknown anchor.type", () => {
            expectRejects(
                makeValidFinding({
                    anchor: {type: "region", path: "x", line: 1},
                }),
                /anchor\.type/,
            );
        });

        it("rejects a line/file anchor missing its path", () => {
            expectRejects(
                makeValidFinding({anchor: {type: "line", line: 1}}),
                /anchor\.path/,
            );
            expectRejects(
                makeValidFinding({anchor: {type: "file"}}),
                /anchor\.path/,
            );
        });

        it("rejects a non-positive / non-integer line", () => {
            expectRejects(
                makeValidFinding({anchor: {type: "line", path: "x", line: 0}}),
                /anchor\.line/,
            );
            expectRejects(
                makeValidFinding({
                    anchor: {type: "line", path: "x", line: 1.5},
                }),
                /anchor\.line/,
            );
        });

        it("rejects a bad side", () => {
            expectRejects(
                makeValidFinding({
                    anchor: {type: "line", path: "x", line: 1, side: "MIDDLE"},
                }),
                /anchor\.side/,
            );
        });

        it("rejects an inverted range (start_line > line)", () => {
            expectRejects(
                makeValidFinding({
                    anchor: {type: "line", path: "x", line: 5, start_line: 9},
                }),
                /anchor\.start_line/,
            );
        });

        it("rejects a non-positive start_line", () => {
            expectRejects(
                makeValidFinding({
                    anchor: {type: "line", path: "x", line: 5, start_line: 0},
                }),
                /anchor\.start_line/,
            );
        });
    });

    it("collects ALL violations at once (per-lens drop-rate diagnosability)", () => {
        const result = validateFinding({
            schema_version: 99,
            id: "",
            lens: "bogus",
            anchor: {type: "line"},
            severity: "nit",
            confidence: 5,
            evidence_trace: [],
            producing_hunt: "",
            model_authored_prose: "",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // Every field above is wrong — expect a rich, multi-error report,
            // not a fail-fast single message.
            expect(result.errors.length).toBeGreaterThanOrEqual(8);
        }
    });
});

describe("isValidFinding", () => {
    it("narrows to true for a well-formed finding", () => {
        expect(isValidFinding(makeValidFinding())).toBe(true);
    });

    it("returns false for a malformed finding", () => {
        expect(isValidFinding({nope: true})).toBe(false);
        expect(isValidFinding(makeValidFinding({lens: "bogus"}))).toBe(false);
    });
});

describe("assertFinding", () => {
    it("returns the finding for well-formed input", () => {
        const finding = assertFinding(makeValidFinding());
        expect(finding.id).toBe("finding-1");
    });

    it("throws listing every violation for malformed input", () => {
        expect(() => assertFinding({schema_version: 99})).toThrowError(
            /Invalid finding/,
        );
        try {
            assertFinding(makeValidFinding({severity: "nit", confidence: 9}));
            throw new Error("expected assertFinding to throw");
        } catch (err) {
            const message = (err as Error).message;
            expect(message).toMatch(/severity/);
            expect(message).toMatch(/confidence/);
        }
    });
});

describe("validateOutOfLaneObservation", () => {
    const makeValidObservation = (
        overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
        path: "services/foo/dedup.go",
        line: 42,
        observation:
            "Dedup reads via an eventually-consistent Query immediately after PutMulti.",
        failure_scenario:
            "Two rapid submissions race the index; the second Query misses the first PutMulti and both rows persist.",
        suggested_lane: "correctness",
        ...overrides,
    });

    it("accepts a well-formed observation", () => {
        const result = validateOutOfLaneObservation(makeValidObservation());
        expect(result.ok).toBe(true);
    });

    it("accepts the minimal shape (no line, no suggested_lane)", () => {
        const minimal = makeValidObservation();
        delete minimal["line"];
        delete minimal["suggested_lane"];
        expect(validateOutOfLaneObservation(minimal).ok).toBe(true);
    });

    it("rejects a non-object", () => {
        const result = validateOutOfLaneObservation("nope");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toEqual(["observation: must be an object"]);
        }
    });

    it("requires path, observation, and failure_scenario", () => {
        const result = validateOutOfLaneObservation({});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain("path: required non-empty string");
            expect(result.errors).toContain(
                "observation: required non-empty string",
            );
            expect(result.errors).toContain(
                "failure_scenario: required non-empty string",
            );
        }
    });

    it("collects every violation rather than failing on the first", () => {
        const result = validateOutOfLaneObservation(
            makeValidObservation({
                path: "",
                line: 0,
                observation: "",
                suggested_lane: "",
            }),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.length).toBe(4);
        }
    });

    it("rejects a non-integer or non-positive line when present", () => {
        expect(
            validateOutOfLaneObservation(makeValidObservation({line: 1.5})).ok,
        ).toBe(false);
        expect(
            validateOutOfLaneObservation(makeValidObservation({line: -3})).ok,
        ).toBe(false);
    });
});

describe("isValidOutOfLaneObservation", () => {
    it("narrows well-formed input and rejects malformed input", () => {
        expect(
            isValidOutOfLaneObservation({
                path: "a.go",
                observation: "A real concern.",
                failure_scenario: "Input X produces wrong output Y.",
            }),
        ).toBe(true);
        expect(isValidOutOfLaneObservation({path: "a.go"})).toBe(false);
    });
});
