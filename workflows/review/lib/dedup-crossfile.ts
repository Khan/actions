/**
 * Cross-file duplicate merge: ONE source posting the SAME finding on several
 * files collapses to one comment.
 *
 * Both existing dedup tiers require the same path and different sources by
 * design (dedup.ts, dedup-cluster.ts): they merge AGREEMENT, several
 * reviewers landing on one defect. This pass merges REPETITION, one reviewer
 * stamping the same finding across sibling files. Measured on Khan/webapp
 * PR 41440: inline comments 3764122555 and 3764122558 are byte-identical
 * 566-character documentation suggestions on two sibling eval YAML files,
 * posted by one source in one run; in-run clustering could not reach them
 * because every rule it has forbids exactly this shape.
 *
 * Rules, all of them narrower than the tiers this rides beside:
 *
 * - **Same source and same label, exactly.** A source does not disagree with
 *   itself about severity, so a label mismatch means the findings differ in
 *   ask even when their prose is close; and merging across sources is the
 *   other tiers' job, with their own calibration. The label equality also
 *   makes the verdict arithmetic trivial: a merged blocking group keeps one
 *   blocking claim, so it floors the verdict exactly once, and a wrong merge
 *   can never soften a verdict (the survivor carries the same label every
 *   copy did).
 * - **Different paths, both anchored.** A same-path pair belongs to tier 1;
 *   an unanchored (pr-level) claim has no occurrence list to speak of.
 * - **Identical text, or near-identical above the STRICT floor.** Identical
 *   subject/discussion/failure-scenario text merges outright (the measured
 *   41440 shape; short identical bodies must not fail on a bigram count).
 *   Anything else must clear `describesSameDefect` with the claims' lines
 *   stripped, which forces the stricter OTHER_LINE_FLOOR: equal line numbers
 *   in different files are coincidence, not anchor evidence, and must not
 *   buy the laxer exact-anchor tier. Any doubt posts separately, matching
 *   the dedup philosophy (a missed merge costs a duplicate comment; a wrong
 *   one drops a finding).
 *
 * The survivor is the first occurrence in diff order (the staged files.json
 * order, when provided; claim order otherwise), so the comment lands where a
 * reader meets the pattern first. Its discussion gains one trailing line
 * naming the other occurrences (path, and line where known); those
 * occurrences are prose, not anchors, so the change-provenance gate applies
 * to the survivor's own anchor only, which every copy already passed
 * individually before dedup ran. Merged-away copies are recorded for
 * dispatch-result.json like the other tiers' merges.
 */

import {dedupeClaims, describesSameDefect, type ClaimMerge} from "./dedup";
import {isRecord, type Claim, type ProposedCluster} from "./dispatch-contracts";
import {type ClusterRejection} from "./dedup-cluster";

/** One cross-file merge, for the run artifact (`crossFileMerges`). */
export type CrossFileMerge = {
    survivor: string;
    source: string;
    label: string;
    path: string;
    line: number;
    merged: {id: string; path: string; line?: number}[];
    via: "cross-file";
};

/** The normalized text identity of a claim, for the exact-equality fast path. */
const exactKey = (claim: Claim): string =>
    [claim.subject, claim.discussion, claim.failure_scenario]
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();

/**
 * Whether two same-source, same-label claims on different files carry the
 * same finding. Exact text equality merges outright; otherwise the pair must
 * clear the similarity floors with lines stripped, so the strict
 * different-line tier applies whatever the line numbers are.
 */
const sameCrossFileFinding = (a: Claim, b: Claim): boolean =>
    exactKey(a) === exactKey(b) ||
    describesSameDefect({...a, line: undefined}, {...b, line: undefined});

const mergeableAcrossFiles = (a: Claim, b: Claim): boolean =>
    a.source === b.source &&
    a.label === b.label &&
    a.path !== undefined &&
    b.path !== undefined &&
    a.path !== b.path &&
    a.line !== undefined &&
    b.line !== undefined &&
    sameCrossFileFinding(a, b);

/**
 * Merge one source's cross-file duplicates. Runs AFTER `dedupeClaims` (the
 * cross-source tiers settle first, so a survivor here already speaks for
 * whatever they folded into it) and before open-thread suppression and
 * validation, so merged copies are neither separately validated nor
 * separately posted.
 *
 * `pathOrder` is the diff's file order (staged files.json); the survivor is
 * the group's first occurrence in that order, with claim order breaking ties
 * and standing in entirely when the order is absent or does not know a path.
 */
export const mergeCrossFileDuplicates = (
    claims: Claim[],
    pathOrder: readonly string[] = [],
): {claims: Claim[]; merges: CrossFileMerge[]} => {
    const orderOf = new Map<string, number>();
    pathOrder.forEach((path, index) => {
        if (!orderOf.has(path)) {
            orderOf.set(path, index);
        }
    });
    const rank = (index: number): [number, number] => {
        const path = claims[index].path;
        return [
            path !== undefined && orderOf.has(path)
                ? (orderOf.get(path) as number)
                : Number.MAX_SAFE_INTEGER,
            index,
        ];
    };
    const firstInDiffOrder = (indexA: number, indexB: number): number => {
        const [pathA, claimA] = rank(indexA);
        const [pathB, claimB] = rank(indexB);
        if (pathA !== pathB) {
            return pathA < pathB ? indexA : indexB;
        }
        return claimA < claimB ? indexA : indexB;
    };

    // Union-find over pairwise-mergeable claims, mirroring tier 1's shape.
    const parent = claims.map((_, index) => index);
    const find = (index: number): number => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    for (let i = 0; i < claims.length; i += 1) {
        for (let j = i + 1; j < claims.length; j += 1) {
            if (mergeableAcrossFiles(claims[i], claims[j])) {
                parent[find(j)] = find(i);
            }
        }
    }
    const groups = new Map<number, number[]>();
    claims.forEach((_, index) => {
        const root = find(index);
        groups.set(root, [...(groups.get(root) ?? []), index]);
    });

    const drop = new Set<number>();
    const replacement = new Map<number, Claim>();
    const merges: CrossFileMerge[] = [];
    for (const group of [...groups.values()].sort((a, b) => a[0] - b[0])) {
        if (group.length < 2) {
            continue;
        }
        const survivorIndex = group.reduce(firstInDiffOrder);
        const survivor = claims[survivorIndex];
        // Star guard, as in tier 1: only a copy mergeable against the
        // survivor itself merges. Union-find alone chains A~B~C through a
        // bridging claim, and collapsing the chain would silently drop a
        // finding the survivor's text does not cover.
        const merged = group
            .filter(
                (index) =>
                    index !== survivorIndex &&
                    mergeableAcrossFiles(survivor, claims[index]),
            )
            .sort((a, b) => (firstInDiffOrder(a, b) === a ? -1 : 1));
        if (merged.length === 0) {
            continue;
        }
        for (const index of merged) {
            drop.add(index);
        }
        const occurrence = (claim: Claim): string =>
            claim.line === undefined
                ? `\`${claim.path}\``
                : `\`${claim.path}\` (line ${claim.line})`;
        const alsoApplies = `\n\nAlso applies to ${merged
            .map((index) => occurrence(claims[index]))
            .join(", ")}.`;
        replacement.set(survivorIndex, {
            ...survivor,
            discussion: `${survivor.discussion}${alsoApplies}`,
        });
        merges.push({
            survivor: survivor.id,
            source: survivor.source,
            label: survivor.label,
            path: survivor.path as string,
            line: survivor.line as number,
            merged: merged.map((index) => {
                const claim = claims[index];
                return {
                    id: claim.id,
                    path: claim.path as string,
                    ...(claim.line !== undefined ? {line: claim.line} : {}),
                };
            }),
            via: "cross-file",
        });
    }
    return {
        claims: claims
            .map((claim, index) => replacement.get(index) ?? claim)
            .filter((_, index) => !drop.has(index)),
        merges,
    };
};

/**
 * The composed dedup entry point dispatch calls: the cross-source tiers
 * (`dedupeClaims`) settle first, then the cross-file pass runs over their
 * survivors, so this pass can only ever remove comments the tiers left
 * standing, never a merge they made. `stagedFiles` is the raw parsed
 * files.json (diff order); a missing or malformed staging degrades to claim
 * order, never to a skipped merge.
 */
export const dedupeClaimsWithCrossFile = (
    claims: Claim[],
    proposals: readonly ProposedCluster[],
    stagedFiles: unknown,
): {
    claims: Claim[];
    merges: ClaimMerge[];
    clusterRejections: ClusterRejection[];
    crossFileMerges: CrossFileMerge[];
} => {
    const deduped = dedupeClaims(claims, proposals);
    const pathOrder = (Array.isArray(stagedFiles) ? stagedFiles : [])
        .map((entry) => (isRecord(entry) ? entry["path"] : undefined))
        .filter((path): path is string => typeof path === "string");
    const crossFile = mergeCrossFileDuplicates(deduped.claims, pathOrder);
    return {
        claims: crossFile.claims,
        merges: deduped.merges,
        clusterRejections: deduped.clusterRejections,
        crossFileMerges: crossFile.merges,
    };
};
