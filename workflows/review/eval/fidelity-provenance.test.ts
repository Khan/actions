import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

import {
    FIDELITY_IMPLEMENTATION_FILES,
    measureFidelity,
} from "./claim-fidelity-report";
import {hashFiles} from "./fidelity-provenance";

const productionFiles = [
    "workflows/review/lib/dispatch-contracts.ts",
    "workflows/review/lib/submission-render.ts",
    "workflows/review/lib/render-comment.ts",
    "workflows/review/lib/attribution.ts",
    "workflows/review/lib/agent-json.ts",
    "workflows/review/lib/finding-schema.ts",
];

describe("fidelity implementation provenance", () => {
    it("records the production verification and rendering dependencies in the report", () => {
        const report = measureFidelity();
        expect(report.implementationFiles).toEqual(
            FIDELITY_IMPLEMENTATION_FILES,
        );
        expect(report.implementationFiles).toEqual(
            expect.arrayContaining(productionFiles),
        );
        expect(report.implementationFiles).toContain(
            "workflows/review/eval/metrics.ts",
        );
        expect(report.implementationFiles).not.toContain(
            "workflows/review/eval/live-producer.ts",
        );
        expect(report.implementationSha256).toBe(
            hashFiles(report.implementationFiles),
        );
    });

    it("names bare-renderer equality rather than publication bytes", () => {
        const report = measureFidelity();
        expect(report.renderingSurface).toContain("without attribution");
        for (const row of report.rows) {
            expect(row.originalMatchesBareRenderer).toBe(true);
            expect(row.controlMatchesBareRenderer).toBe(true);
            expect(row).not.toHaveProperty("originalMatchesProduction");
            expect(row).not.toHaveProperty("controlMatchesProduction");
        }
    });

    it("changes when any recorded dependency's bytes change", () => {
        const before = hashFiles(FIDELITY_IMPLEMENTATION_FILES);
        for (const changed of FIDELITY_IMPLEMENTATION_FILES) {
            const after = hashFiles(FIDELITY_IMPLEMENTATION_FILES, (path) =>
                path === changed
                    ? Buffer.concat([
                          readFileSync(path),
                          Buffer.from("\n// changed\n"),
                      ])
                    : readFileSync(path),
            );
            expect(after, changed).not.toBe(before);
        }
    });
});
