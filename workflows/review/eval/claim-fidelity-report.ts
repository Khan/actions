import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
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

const hashFiles = (paths: string[]): string => {
    const hash = createHash("sha256");
    for (const path of paths) {
        hash.update(path);
        hash.update(readFileSync(path));
    }
    return hash.digest("hex");
};

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
        rulerSha256: hashFiles([
            "workflows/review/eval/claim-fidelity.ts",
            ...fixtures.flatMap(({corpusCase}) => [
                corpusCase.sourcePath,
                join(dirname(corpusCase.sourcePath), "fidelity.json"),
            ]),
        ]),
        implementationSha256: hashFiles([
            "workflows/review/eval/corpus/loader.ts",
            "workflows/review/eval/runner.ts",
            "workflows/review/eval/live-producer.ts",
        ]),
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
                productionControl: scoreFidelity(productionBody, checks),
                controlRetained: corrected.postedCandidates.length === 1,
                controlMatchesProduction: correctedBody === productionBody,
            };
        }),
    };
};

if (typeof require !== "undefined" && require.main === module) {
    // eslint-disable-next-line no-console -- Offline report CLI.
    console.log(JSON.stringify(measureFidelity(), null, 2));
}
