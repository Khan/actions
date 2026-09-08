import {describe, expect, it} from "vitest";

import pairs from "../eval/same-run-september-2026/pairs.json";
import reservation from "../eval/same-run-september-2026/proposal-reservation.json";
import {pairDiagnostics} from "../eval/replay-same-run";
import {dedupeClaims, describesSameDefect} from "./dedup";
import {mergeCrossFileDuplicates} from "./dedup-crossfile";
import {
    applyVerifications,
    parseValidatorOutput,
    type Claim,
} from "./dispatch-contracts";
import {attributionLine} from "./attribution";
import {isBlockingLabel} from "./render-comment";
import {computeVerdict} from "./verdict";

const claims = (): Claim[] => structuredClone(reservation.claims) as Claim[];
const blockingIds = (input: Claim[]): string[] =>
    input
        .filter((claim) => isBlockingLabel(claim.label))
        .map((claim) => claim.id);
const target = "correctness-reviewer-3";
const advisory = "completeness-2";

describe("September 2026 same-run duplicate audit", () => {
    for (const fixture of pairs) {
        it(`replays webapp#${fixture.pr}, run ${fixture.run}, ${fixture.claims[0].id}`, () => {
            const input = structuredClone(fixture.claims) as Claim[];
            for (const pair of fixture.expectedPairs) {
                const a = input.find((claim) => claim.id === pair.ids[0])!;
                const b = input.find((claim) => claim.id === pair.ids[1])!;
                expect(describesSameDefect(a, b)).toBe(pair.similar);
                const diagnostic = pairDiagnostics(a, b);
                expect(diagnostic.score).toEqual(pair.score);
                expect(diagnostic.floor).toEqual(pair.floor);
                expect(diagnostic.failedFloors.length === 0).toBe(pair.similar);
                // A cross-file text match still has no cross-source authority.
                expect(
                    mergeCrossFileDuplicates(dedupeClaims([a, b]).claims)
                        .claims,
                ).toHaveLength(2);
            }
            const baseline = dedupeClaims(input);
            const proposed = dedupeClaims(input, fixture.proposals);
            expect(proposed.claims.length).toBeLessThanOrEqual(
                baseline.claims.length,
            );
            expect(blockingIds(proposed.claims)).toEqual(
                blockingIds(baseline.claims),
            );
        });
    }

    it("reproduces the original unproductive reservation when the later proposal is absent", () => {
        const result = dedupeClaims(
            claims(),
            reservation.proposals.slice(0, -1),
        );
        expect(result.merges).toEqual(reservation.baselineMerges);
        expect(result.clusterRejections).toEqual(
            reservation.baselineRejections,
        );
        expect(result.claims.some((claim) => claim.id === advisory)).toBe(true);
    });

    it("lets a later verified proposal use a head an earlier proposal couldn't merge", () => {
        const input = claims();
        const before = structuredClone(input);
        const result = dedupeClaims(input, reservation.proposals);
        const merged = result.merges.find(
            (merge) => merge.survivor === target,
        )!;
        expect(merged.merged.map((copy) => copy.id)).toEqual([
            "skill-auditor-ool-1",
            advisory,
        ]);
        expect(merged.merged[1]).toMatchObject({
            via: "clusterer",
            groundedBy: "evidence",
            line: 313,
        });
        expect(result.claims).toHaveLength(23);
        expect(blockingIds(result.claims)).toEqual(
            blockingIds(dedupeClaims(input).claims),
        );
        expect(
            result.claims.find((claim) => claim.id === "holistic-1"),
        ).toEqual(input.find((claim) => claim.id === "holistic-1"));
        // Preserve every independent claim, not just the verdict floor.
        const original = dedupeClaims(
            input,
            reservation.proposals.slice(0, -1),
        );
        expect(result.claims.filter((claim) => claim.id !== target)).toEqual(
            original.claims.filter(
                (claim) => ![target, advisory].includes(claim.id),
            ),
        );
        const survivor = result.claims.find((claim) => claim.id === target)!;
        expect(survivor.also_flagged_by).toContainEqual({
            source: "completeness",
            line: 313,
            subject: input.find((claim) => claim.id === advisory)!.subject,
        });
        expect(survivor.also_flagged_by).toContainEqual({
            source: "skill-auditor (out-of-lane)",
            line: 230,
        });
        expect(survivor.discussion).toBe(
            input.find((claim) => claim.id === target)!.discussion,
        );
        expect(input).toEqual(before);
    });

    it("preserves the recorded validation outcome, attribution, and request-changes verdict", () => {
        const verifications = parseValidatorOutput(
            JSON.stringify(reservation.validator),
        );
        const before = applyVerifications(
            dedupeClaims(claims(), reservation.proposals.slice(0, -1)).claims,
            verifications,
        );
        const after = applyVerifications(
            dedupeClaims(claims(), reservation.proposals).claims,
            verifications,
        );
        expect(after).toHaveLength(before.length - 1);
        expect(blockingIds(after)).toEqual(blockingIds(before));
        for (const set of [before, after]) {
            expect(
                computeVerdict({
                    postedLabels: set.map((claim) => claim.label),
                    dimensions: {
                        correctness: "assessed",
                        skillSeverity: "assessed",
                        patternTriage: "assessed",
                    },
                }).event,
            ).toBe("REQUEST_CHANGES");
        }
        const survivor = after.find((claim) => claim.id === target)!;
        const footer = attributionLine(
            survivor.source,
            survivor.also_flagged_by,
        );
        expect(footer).toContain("skill-auditor (out-of-lane) (at line 230)");
        expect(footer).toContain("completeness (at line 313)");
        expect(footer).toContain(
            claims().find((claim) => claim.id === advisory)!.subject,
        );
    });

    it("doesn't give an unproposed or ungrounded advisory permission to merge", () => {
        const proposals = structuredClone(reservation.proposals);
        proposals[proposals.length - 1].evidence = "UnrelatedSymbol";
        const result = dedupeClaims(claims(), proposals);
        expect(result.claims.some((claim) => claim.id === advisory)).toBe(true);
        expect(result.clusterRejections).toContainEqual({
            id: advisory,
            reason: "ungrounded",
        });
    });

    it("keeps productive head ownership exclusive instead of chaining model proposals", () => {
        const base = claims().find((claim) => claim.id === target)!;
        const a = {...base, id: "a", source: "a"};
        const b = {...a, id: "b", source: "b"};
        const advisoryCopy = (id: string, text: string): Claim => ({
            ...a,
            id,
            source: id,
            label: "suggestion (non-blocking)",
            subject: text,
            discussion: text,
            failure_scenario: text,
        });
        const x = advisoryCopy("x", "An independent database constraint.");
        const y = advisoryCopy("y", "A separate retry timeout.");
        const input = [a, b, x, y];
        const result = dedupeClaims(input, [
            {ids: ["a", "x"], evidence: "First exact-anchor proposal"},
            {ids: ["b", "y"], evidence: "Second exact-anchor proposal"},
        ]);
        expect(result.claims.map((claim) => claim.id)).toEqual(["a", "y"]);
        expect(result.merges[0].merged.map((claim) => claim.id)).toEqual([
            "b",
            "x",
        ]);
        expect(result.claims[1]).toEqual(y);
    });

    it("keeps the later copy when it is blocking, on another path, or from the same source", () => {
        for (const change of [
            {label: "issue (blocking)"},
            {path: "another.go"},
            {source: "correctness-reviewer"},
        ]) {
            const input = claims().map((claim) =>
                claim.id === advisory ? {...claim, ...change} : claim,
            );
            const result = dedupeClaims(input, reservation.proposals);
            expect(result.claims.some((claim) => claim.id === advisory)).toBe(
                true,
            );
            expect(blockingIds(result.claims)).toEqual(
                blockingIds(dedupeClaims(input).claims),
            );
        }
    });
});
