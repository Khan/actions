import {describe, expect, it} from "vitest";

import {
    applyVerifications,
    buildClaims,
    parseValidatorOutput,
} from "../lib/dispatch-contracts";
import {renderClaimComment} from "../lib/submission-render";
import {parseCase} from "./corpus/loader";
import {
    FIDELITY_FACETS,
    loadFidelityFixtures,
    scoreFidelity,
} from "./claim-fidelity";
import {computeMetrics} from "./metrics";
import {runCase} from "./runner";

const fixtures = loadFidelityFixtures();
const allPass = Object.fromEntries(FIDELITY_FACETS.map((key) => [key, true]));

describe("historical finding fidelity", () => {
    it("pins three original reviewed commits, not relocated thread commits", () => {
        expect(fixtures.map((f) => f.provenance.reviewedCommit).sort()).toEqual(
            [
                "ec472f1619848fa78e8383b64ebb0d73a67a3756",
                "dd7693df7ec1ed308011b1a0e9c9b0c9831b6d82",
                "5b4a84fbb520c3102467ed549078c72aff3cdd93",
            ].sort(),
        );
        expect(
            fixtures.filter(
                (f) =>
                    f.provenance.reviewedCommit !==
                    f.provenance.currentCommentCommit,
            ),
        ).toHaveLength(2);
        for (const fixture of fixtures) {
            expect(fixture.checks.map((c) => c.facet)).toEqual(FIDELITY_FACETS);
            for (const evidence of fixture.provenance.evidence) {
                expect(evidence.text.split("\n")).toHaveLength(
                    evidence.endLine - evidence.startLine + 1,
                );
                expect(evidence.url).toContain(evidence.commit);
                expect(evidence.fileSha256).toMatch(/^[a-f0-9]{64}$/);
            }
        }
    });

    it("keeps detection separate from incorrect details", () => {
        const runs = fixtures.map(({corpusCase}) => ({
            corpusCase,
            result: runCase(corpusCase),
        }));
        const metrics = computeMetrics(runs);
        expect(metrics.mustCatchRecall.rate).toBe(1);
        expect(metrics.goldenPrecision.rate).toBe(1);
        expect(metrics.noise.numerator).toBe(0);
        expect(metrics.mustCatchRecall.denominator).toBe(3);
    });

    for (const fixture of fixtures) {
        describe(fixture.corpusCase.id, () => {
            it("detects the recorded component failures without rejecting the finding", () => {
                expect(
                    scoreFidelity(
                        fixture.provenance.originalBody,
                        fixture.checks,
                    ),
                ).toEqual(fixture.originalPass);
                const result = runCase(fixture.corpusCase);
                expect(result.postedCandidates).toHaveLength(1);
                expect(
                    scoreFidelity(
                        result.postedCandidates[0].body,
                        fixture.checks,
                    ),
                ).toEqual(fixture.originalPass);
            });

            it("accepts the hand-authored correction through production validation", () => {
                const claims = applyVerifications(
                    buildClaims(fixture.corpusCase.findings),
                    parseValidatorOutput(JSON.stringify(fixture.control)),
                );
                expect(claims).toHaveLength(1);
                expect(
                    scoreFidelity(
                        renderClaimComment(claims[0]),
                        fixture.checks,
                    ),
                ).toEqual(allPass);
            });

            it("replays the same correction and posting surface in the eval", () => {
                const corpusCase = parseCase(
                    {...fixture.corpusCase, validation: fixture.control.claims},
                    fixture.corpusCase.sourcePath,
                );
                const result = runCase(corpusCase);
                expect(result.postedCandidates).toHaveLength(1);
                const posted = result.postedCandidates[0];
                expect(scoreFidelity(posted.body, fixture.checks)).toEqual(
                    allPass,
                );
                const production = applyVerifications(
                    buildClaims(fixture.corpusCase.findings),
                    parseValidatorOutput(JSON.stringify(fixture.control)),
                );
                expect(posted.body).toBe(renderClaimComment(production[0]));
                expect(posted.finding.summary).toBe(production[0].subject);
                expect(posted.finding.model_authored_prose).toBe(
                    production[0].discussion,
                );
                expect(posted.blocking).toBe(false);
            });

            it("does not reward dropping the useful finding", () => {
                const corpusCase = parseCase(
                    {
                        ...fixture.corpusCase,
                        validation: [
                            {
                                id: fixture.corpusCase.findings[0].finding.id,
                                verification: "refuted",
                            },
                        ],
                    },
                    fixture.corpusCase.sourcePath,
                );
                const result = runCase(corpusCase);
                expect(result.postedCandidates).toHaveLength(0);
                expect(
                    computeMetrics([{corpusCase, result}]).mustCatchRecall.rate,
                ).toBe(0);
                expect(
                    Object.values(scoreFidelity(undefined, fixture.checks)),
                ).toEqual([false, false, false, false]);
            });
        });
    }

    it.each([null, [], "correction"])(
        "rejects a malformed correction: %j",
        (corrected) => {
            const {corpusCase} = fixtures[0];
            expect(() =>
                parseCase(
                    {
                        ...corpusCase,
                        validation: [
                            {
                                id: corpusCase.findings[0].finding.id,
                                verification: "confirmed",
                                corrected,
                            },
                        ],
                    },
                    "malformed-correction",
                ),
            ).toThrow("corrected: must be an object");
        },
    );

    it("keeps invalid correction fields unchanged through the production guard", () => {
        const {corpusCase} = fixtures[0];
        const result = runCase(
            parseCase(
                {
                    ...corpusCase,
                    validation: [
                        {
                            id: corpusCase.findings[0].finding.id,
                            verification: "confirmed",
                            corrected: {
                                subject: "",
                                discussion: 42,
                                line: "bad",
                                label: "unknown",
                            },
                        },
                    ],
                },
                "invalid-fields",
            ),
        );
        const original = corpusCase.findings[0].finding;
        expect(result.postedCandidates[0].finding.summary).toBe(
            original.summary,
        );
        expect(result.postedCandidates[0].finding.model_authored_prose).toBe(
            original.model_authored_prose,
        );
        expect(result.postedCandidates[0].anchor).toEqual(original.anchor);
        expect(result.postedCandidates[0].label).toBe(
            "suggestion (non-blocking)",
        );
    });

    it("does not apply a plausible correction that production ignores", () => {
        const fixture = fixtures[0];
        const corpusCase = parseCase(
            {
                ...fixture.corpusCase,
                validation: [
                    {...fixture.control.claims[0], verification: "plausible"},
                ],
            },
            "plausible-correction",
        );
        const posted = runCase(corpusCase).postedCandidates;
        expect(posted).toHaveLength(1);
        expect(scoreFidelity(posted[0].body, fixture.checks)).toEqual(
            fixture.originalPass,
        );
    });

    it("does not treat a nil panic claim as the diagnostic concern", () => {
        const fixture = fixtures.find((f) => f.corpusCase.id.includes("42001"));
        expect(fixture).toBeDefined();
        const score = scoreFidelity(
            "The nil argument causes a panic in errorToDebugMessage.",
            fixture!.checks,
        );
        expect(score.mainDefect).toBe(false);
        expect(score.supportingAssertions).toBe(false);
        expect(score.visibleConsequence).toBe(false);
    });
});
