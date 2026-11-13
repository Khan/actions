import {dirname, join} from "node:path";

import {
    applyVerifications,
    buildClaims,
    parseValidatorOutput,
} from "../lib/dispatch-contracts";
import {renderClaimComment} from "../lib/submission-render";
import {loadFidelityFixtures, scoreFidelity} from "./claim-fidelity";
import {parseCase} from "./corpus/loader";
import {computeMetrics} from "./metrics";
import {runCase} from "./runner";
import {CLAIM_RENDERING_FILES, hashFiles} from "./fidelity-provenance";

export const FIDELITY_IMPLEMENTATION_FILES = [
    "workflows/review/eval/fidelity-provenance.ts",
    "workflows/review/eval/claim-fidelity-report.ts",
    "workflows/review/eval/corpus/loader.ts",
    "workflows/review/eval/runner.ts",
    "workflows/review/eval/metrics.ts",
    ...CLAIM_RENDERING_FILES,
];

/** Measures replay fidelity only. The controls are not model output. */
export const measureFidelity = () => {
    const fixtures = loadFidelityFixtures();
    const runs = fixtures.map(({corpusCase}) => ({
        corpusCase,
        result: runCase(corpusCase),
    }));
    const metrics = computeMetrics(runs);
    return {
        kind: "deterministic replay, hand-authored controls, no model calls",
        renderingSurface:
            "bare renderClaimComment without attribution or submission placement, not exact publication bytes",
        rulerSha256: hashFiles([
            "workflows/review/eval/claim-fidelity.ts",
            ...fixtures.flatMap(({corpusCase}) => [
                corpusCase.sourcePath,
                join(dirname(corpusCase.sourcePath), "fidelity.json"),
            ]),
        ]),
        implementationFiles: FIDELITY_IMPLEMENTATION_FILES,
        implementationSha256: hashFiles(FIDELITY_IMPLEMENTATION_FILES),
        reviewPromptSha256: hashFiles(["workflows/review/review.md"]),
        originalMetrics: {
            mustCatchRecall: metrics.mustCatchRecall.rate,
            goldenPrecision: metrics.goldenPrecision.rate,
            noise: metrics.noise.rate,
            findings: metrics.mustCatchRecall.denominator,
        },
        rows: fixtures.map((fixture, index) => {
            const {corpusCase, control, checks, provenance} = fixture;
            const corrected = runCase(
                parseCase(
                    {...corpusCase, validation: control.claims},
                    corpusCase.sourcePath,
                ),
            );
            const production = applyVerifications(
                buildClaims(corpusCase.findings),
                parseValidatorOutput(JSON.stringify(control)),
            );
            const productionBody = renderClaimComment(production[0]);
            const correctedBody = corrected.postedCandidates[0]?.body;
            return {
                caseId: corpusCase.id,
                reviewedCommit: provenance.reviewedCommit,
                original: scoreFidelity(
                    runs[index].result.postedCandidates[0]?.body,
                    checks,
                ),
                handAuthoredControl: scoreFidelity(correctedBody, checks),
                bareRendererControl: scoreFidelity(productionBody, checks),
                originalMatchesBareRenderer:
                    runs[index].result.postedCandidates[0]?.body ===
                    renderClaimComment(buildClaims(corpusCase.findings)[0]),
                controlRetained: corrected.postedCandidates.length === 1,
                controlMatchesBareRenderer: correctedBody === productionBody,
            };
        }),
    };
};

if (typeof require !== "undefined" && require.main === module) {
    // eslint-disable-next-line no-console -- Offline report CLI.
    console.log(JSON.stringify(measureFidelity(), null, 2));
}
