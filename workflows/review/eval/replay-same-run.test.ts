import {describe, expect, it} from "vitest";

import pairs from "./same-run-september-2026/pairs.json";
import reservation from "./same-run-september-2026/proposal-reservation.json";
import {pairDiagnostics} from "./replay-same-run";
import {dedupeClaims, describesSameDefect} from "../lib/dedup";
import {verifiableClusters} from "../lib/dedup-cluster";
import {mergeCrossFileDuplicates} from "../lib/dedup-crossfile";
import {
    applyVerifications,
    parseValidatorOutput,
    type Claim,
} from "../lib/dispatch-contracts";
import {attributionLine} from "../lib/attribution";
import {isBlockingLabel} from "../lib/render-comment";
import {computeVerdict} from "../lib/verdict";

/**
 * Original inputs from the September 3–8 webapp audit. The full #42034 run
 * reproduces proposal scheduling after tier 1, which a pair-only replay misses.
 * Fixture provenance and evidence limits are in the adjacent eval report.
 */
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
            // In the bounded #42034 triple, tier 1 already absorbs the
            // advisory into holistic. Only the full-run fixture below
            // reproduces the reservation bug. All other groups stay separate.
            const expectedIds = input
                .filter(
                    (claim) =>
                        fixture.pr !== 42034 || claim.id !== "completeness-2",
                )
                .map((claim) => claim.id);
            expect(baseline.claims.map((claim) => claim.id)).toEqual(
                expectedIds,
            );
            expect(proposed.claims.map((claim) => claim.id)).toEqual(
                expectedIds,
            );
            expect(proposed.claims).toEqual(baseline.claims);
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
        expect(result.clusterRejections).toEqual([
            {id: "b", reason: "head-reserved"},
            {id: "y", reason: "cluster-collapsed"},
        ]);
    });

    it("reserves a rejected head when its proposal merges another member", () => {
        const base = claims().find((claim) => claim.id === target)!;
        const survivor = {...base, id: "s", source: "s"};
        const copy = (id: string, text: string, label: string): Claim => ({
            ...base,
            id,
            source: id,
            label,
            subject: text,
            discussion: text,
            failure_scenario: text,
        });
        const blocker = copy(
            "blocker",
            "Missing authorization permits deleted accounts to retain privileged workspace membership during token renewal.",
            "issue (blocking)",
        );
        // The proposals name different original ids, so both pass parsing.
        // Tier 1 maps this advisory alias to the blocking head. Only then does
        // the first proposal reject it while successfully merging x.
        const alias = {
            ...blocker,
            id: "alias",
            source: "alias",
            label: "suggestion (non-blocking)",
        };
        const first = copy(
            "x",
            "An independent database constraint.",
            "suggestion (non-blocking)",
        );
        const later = copy(
            "y",
            "A separate retry timeout.",
            "suggestion (non-blocking)",
        );
        const proposals = [
            {ids: ["s", "alias", "x"], evidence: "First exact-anchor proposal"},
            {ids: ["blocker", "y"], evidence: "Second exact-anchor proposal"},
        ];
        const input = [survivor, blocker, alias, first, later];
        const parsed = verifiableClusters(input, proposals);
        expect(parsed.rejections).toEqual([]);
        expect(parsed.clusterOf.size).toBe(5);
        expect(
            dedupeClaims([blocker, later], [proposals[1]]).claims,
        ).toHaveLength(1);
        const result = dedupeClaims(input, proposals);
        expect(result.claims.map((claim) => claim.id)).toEqual([
            "s",
            "blocker",
            "y",
        ]);
        expect(
            result.merges.map((merge) => ({
                survivor: merge.survivor,
                ids: merge.merged.map((member) => member.id),
            })),
        ).toEqual([
            {survivor: "s", ids: ["x"]},
            {survivor: "blocker", ids: ["alias"]},
        ]);
        expect(result.claims[2]).toEqual(later);
        expect(result.clusterRejections).toEqual([
            {id: "alias", reason: "blocking-member"},
            {id: "blocker", reason: "head-reserved"},
            {id: "y", reason: "cluster-collapsed"},
        ]);
    });

    it("records reserved members without stopping the later proposal's remaining pair", () => {
        const base = claims().find((claim) => claim.id === target)!;
        const a = {...base, id: "a", source: "a"};
        const b = {...a, id: "b", source: "b"};
        const copy = (id: string, text: string): Claim => ({
            ...base,
            id,
            source: id,
            label: "suggestion (non-blocking)",
            subject: text,
            discussion: text,
            failure_scenario: text,
        });
        const x = copy("x", "An independent database constraint.");
        const y = copy("y", "A separate retry timeout.");
        const z = copy("z", "An unrelated memory allocation.");
        const result = dedupeClaims(
            [a, b, x, y, z],
            [
                {ids: ["a", "x"], evidence: "First exact-anchor proposal"},
                {
                    ids: ["b", "y", "z"],
                    evidence: "Second exact-anchor proposal",
                },
            ],
        );
        expect(result.claims.map((claim) => claim.id)).toEqual(["a", "y"]);
        expect(
            result.merges.map((merge) => ({
                survivor: merge.survivor,
                ids: merge.merged.map((member) => member.id),
            })),
        ).toEqual([
            {survivor: "a", ids: ["b", "x"]},
            {survivor: "y", ids: ["z"]},
        ]);
        expect(result.clusterRejections).toEqual([
            {id: "b", reason: "head-reserved"},
        ]);
    });

    it("doesn't reject an identity tier 1 already established on a reserved head", () => {
        const base = claims().find((claim) => claim.id === target)!;
        const a = {...base, id: "a", source: "a"};
        const b = {...base, id: "b", source: "b"};
        const c = {
            ...base,
            id: "c",
            source: "c",
            label: "suggestion (non-blocking)",
        };
        const x = {
            ...base,
            id: "x",
            source: "x",
            label: "suggestion (non-blocking)",
            subject: "An independent database constraint.",
            discussion: "An independent database constraint.",
            failure_scenario: "An independent database constraint.",
        };
        const result = dedupeClaims(
            [a, b, c, x],
            [
                {ids: ["a", "x"], evidence: "First exact-anchor proposal"},
                {
                    ids: ["b", "c"],
                    evidence: "Identity already reached by tier 1",
                },
            ],
        );
        expect(result.claims.map((claim) => claim.id)).toEqual(["a"]);
        expect(result.merges[0].merged.map((member) => member.id)).toEqual([
            "b",
            "c",
            "x",
        ]);
        expect(result.clusterRejections).toEqual([]);
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
