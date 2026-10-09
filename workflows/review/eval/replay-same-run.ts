import pairs from "./same-run-september-2026/pairs.json";
import reservation from "./same-run-september-2026/proposal-reservation.json";
import {dedupeClaims, describesSameDefect} from "../lib/dedup";
import {
    bigrams,
    contentTokens,
    EXACT_ANCHOR_FLOOR,
    intersectionSize,
    OTHER_LINE_FLOOR,
} from "../lib/dedup-text";
import {type Claim} from "../lib/dispatch-contracts";
import {isBlockingLabel} from "../lib/render-comment";

// Mirror dedup.ts's private text selection for diagnostics only. Tests compare
// the resulting predicate to describesSameDefect, so this cannot change merges.
const comparisonKey = (text: string): string =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
const comparedText = (claim: Claim): string => {
    const subject = comparisonKey(claim.subject);
    const failure = comparisonKey(claim.failure_scenario);
    return subject.startsWith(failure) || failure.startsWith(subject)
        ? `${claim.subject} ${claim.discussion}`
        : `${claim.subject} ${claim.failure_scenario}`;
};

export const pairDiagnostics = (a: Claim, b: Claim) => {
    const tokensA = contentTokens(comparedText(a));
    const tokensB = contentTokens(comparedText(b));
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const shared = intersectionSize(setA, setB);
    const score = {
        jaccard: shared / (setA.size + setB.size - shared || 1),
        overlap: shared / (Math.min(setA.size, setB.size) || 1),
        sharedBigrams: intersectionSize(bigrams(tokensA), bigrams(tokensB)),
    };
    const floor =
        a.line !== undefined && a.line === b.line
            ? EXACT_ANCHOR_FLOOR
            : OTHER_LINE_FLOOR;
    const failedFloors = (Object.keys(floor) as (keyof typeof floor)[]).filter(
        (key) => score[key] < floor[key],
    );
    return {
        ids: [a.id, b.id],
        anchors: [a, b].map((claim) => ({path: claim.path, line: claim.line})),
        score,
        floor,
        failedFloors,
        similar: describesSameDefect(a, b),
        structuralBarriers: [
            ...(a.path !== b.path ? ["other-path"] : []),
            ...(a.source === b.source ? ["same-source"] : []),
            ...(isBlockingLabel(a.label) && isBlockingLabel(b.label)
                ? ["blocking-member"]
                : []),
        ],
    };
};

export const replaySameRunAudit = () => ({
    baseline: "review-v1.25.0 (8c13cc7bf9dc4a444971300a10e4dbf13d0f6f52)",
    scope: "12 available claim groups. Published comments for webapp#41921 are not replay inputs. Pair-only proposals do not reproduce full-run head ownership.",
    pairs: pairs.flatMap((fixture) => {
        const input = fixture.claims as Claim[];
        return input.slice(1).map((b) => ({
            pr: fixture.pr,
            run: fixture.run,
            ...pairDiagnostics(input[0], b),
            namedTogether: fixture.proposals.filter(
                (proposal) =>
                    proposal.ids.includes(input[0].id) &&
                    proposal.ids.includes(b.id),
            ),
        }));
    }),
    reservation: dedupeClaims(
        reservation.claims as Claim[],
        reservation.proposals,
    ),
});

if (typeof require !== "undefined" && require.main === module) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(replaySameRunAudit(), null, 2));
}
