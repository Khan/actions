import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";

import {loadCorpus, type CorpusCase} from "./corpus/loader";

/** Independent of recall: a useful finding can still contain a false claim. */
export const FIDELITY_FACETS = [
    "mainDefect",
    "proposedFix",
    "supportingAssertions",
    "visibleConsequence",
] as const;

export type FidelityFacet = typeof FIDELITY_FACETS[number];
export type FidelityCheck = {
    facet: FidelityFacet;
    surface: "body" | "visible";
    /** Every required regex must match. Use alternation for equivalent wording. */
    required: string[];
    /** Any forbidden regex is a known error, including errors in code sketches. */
    forbidden: string[];
};

export type FidelityFixture = {
    corpusCase: CorpusCase;
    provenance: {
        reviewedCommit: string;
        currentCommentCommit: string;
        originalBody: string;
        url: string;
        evidence: {
            path: string;
            commit: string;
            startLine: number;
            endLine: number;
            text: string;
            fileSha256: string;
            url: string;
        }[];
    };
    checks: FidelityCheck[];
    originalPass: Record<FidelityFacet, boolean>;
    control: {
        kind: string;
        claims: {
            id: string;
            verification: "confirmed";
            confidence: number;
            reason: string;
            corrected: Record<string, unknown>;
        }[];
    };
};

/** Sidecars live beside case.json, so the shared corpus loader ignores them. */
export const loadFidelityFixtures = (): FidelityFixture[] =>
    loadCorpus()
        .filter((c) => c.tags.includes("claim-fidelity"))
        .map((corpusCase) => ({
            ...JSON.parse(
                readFileSync(
                    join(dirname(corpusCase.sourcePath), "fidelity.json"),
                    "utf8",
                ),
            ),
            corpusCase,
        }));

/**
 * Bounded lexical regression checks, not a semantic truth judge. Read the
 * actual rendered comment, never evidence_trace or failure_scenario: neither
 * is a substitute for what the author sees. No hidden context may rescue a
 * misleading visible line. A dropped finding fails every component rather
 * than improving quality by removing a useful concern.
 */
export const scoreFidelity = (
    body: string | undefined,
    checks: FidelityCheck[],
): Record<FidelityFacet, boolean> => {
    const result: Record<FidelityFacet, boolean> = {
        mainDefect: false,
        proposedFix: false,
        supportingAssertions: false,
        visibleConsequence: false,
    };
    if (body === undefined) {
        return result;
    }
    for (const check of checks) {
        const text =
            check.surface === "visible" ? body.split("<details>")[0] : body;
        const matches = (pattern: string): boolean =>
            new RegExp(pattern, "is").test(text);
        result[check.facet] =
            check.required.every(matches) && !check.forbidden.some(matches);
    }
    return result;
};
