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
 * Validation asymmetry, accepted deliberately: the validator sees only the
 * survivor, and its verdict speaks for copies anchored on OTHER files whose
 * contents it never re-checked. The cross-source tiers have the same
 * one-validation-per-group shape without the cross-file exposure (their
 * copies share a path). What bounds the cost here: every copy passed the
 * change-provenance gate on its own anchor before dedup ran, the merge
 * floors above demand identical-or-near-identical text from ONE source, and
 * the occurrence list is prose ("Also applies to..."), not an anchored
 * claim, so a wrong merge publishes a weaker statement about the other file
 * than a separate comment would have. A refuted survivor drops its whole
 * group; that is the same failure direction as tier 1 and costs a missed
 * comment only when the SAME text was somehow valid on the sibling file.
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

import {
    describesSameDefect,
    type stagedThreadShapeFailure,
    type ThreadSuppression,
} from "./dedup";
import {suppressTrackedDuplicates} from "./dedup-adjudicated";
import {isRecord, type Claim} from "./dispatch-contracts";

/**
 * The occurrence list a merge appends to its survivor's discussion. One
 * renderer for the merge site and {@link reapplyCrossFileOccurrences}, so
 * the re-apply check can never miss the line over a formatting drift.
 */
const alsoAppliesLine = (
    occurrences: readonly {path?: string; line?: number}[],
): string =>
    `\n\nAlso applies to ${occurrences
        .map((occurrence) =>
            occurrence.line === undefined
                ? `\`${occurrence.path}\``
                : `\`${occurrence.path}\` (line ${occurrence.line})`,
        )
        .join(", ")}.`;

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
 * whatever they folded into it) and AFTER open-thread suppression, but
 * before validation, so merged copies are still neither separately
 * validated nor separately posted (suppression also precedes validation, so
 * the cost saving is identical).
 *
 * The position after suppression is load-bearing, not stylistic. For the
 * OPEN corpus `bestOpenThreadMatch` only matches a thread to a claim on the
 * thread's own path, so if this merge ran first, an open thread on the
 * survivor's file would suppress the survivor and silently drop every other
 * file's occurrence with it: an author who copies a flawed file A into a new
 * sibling B, with A's finding already tracked in an open thread, would never
 * hear about B, on this run or any later one. Running after suppression, A's
 * copy exits through the thread and B posts alone. The inverse cost, an open
 * thread that was itself a merged comment already naming B, is one duplicate
 * comment on B: the failure direction this module's rules already prefer.
 * The ADJUDICATED pass matches cross-file on purpose (`ignorePath`,
 * dedup-adjudicated.ts), so there B's near-identical copy exits through A's
 * settled thread too, before this merge ever sees the pair. That is that
 * corpus's semantics (a human declined the same non-blocking ask, and a
 * blocking re-presentation still posts), not a leak in this ordering, and
 * the ordering stays load-bearing for the open corpus either way;
 * dedup-crossfile.test.ts pins both directions.
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
        replacement.set(survivorIndex, {
            ...survivor,
            discussion: `${survivor.discussion}${alsoAppliesLine(
                merged.map((index) => claims[index]),
            )}`,
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
 * The composed suppression-then-merge step dispatch calls, in this order
 * because the ordering is load-bearing (see {@link mergeCrossFileDuplicates}):
 * both thread-suppression passes first ({@link suppressTrackedDuplicates}:
 * the open corpus, then the adjudicated one), so a file's copy suppressed by
 * an OPEN thread exits through it and the other files' occurrences still
 * post (an adjudicated thread reaches near-identical sibling copies too,
 * deliberately; see {@link mergeCrossFileDuplicates}'s ordering note); the
 * cross-file merge second, over the survivors. `stagedOpen`,
 * `stagedAdjudicated`, and `stagedFiles` are the raw staged values; a
 * missing or malformed files.json degrades to claim order, never to a
 * skipped merge.
 */
export const suppressThenMergeCrossFile = (
    claims: Claim[],
    stagedOpen: unknown,
    stagedAdjudicated: unknown,
    resolvedIds: ReadonlySet<string>,
    stagedFiles: unknown,
): {
    claims: Claim[];
    suppressed: ThreadSuppression[];
    shapeFailure: ReturnType<typeof stagedThreadShapeFailure>;
    crossFileMerges: CrossFileMerge[];
} => {
    const suppression = suppressTrackedDuplicates(
        claims,
        stagedOpen,
        stagedAdjudicated,
        resolvedIds,
    );
    const pathOrder = (Array.isArray(stagedFiles) ? stagedFiles : [])
        .map((entry) => (isRecord(entry) ? entry["path"] : undefined))
        .filter((path): path is string => typeof path === "string");
    const crossFile = mergeCrossFileDuplicates(suppression.kept, pathOrder);
    return {
        claims: crossFile.claims,
        suppressed: suppression.suppressed,
        shapeFailure: suppression.shapeFailure,
        crossFileMerges: crossFile.merges,
    };
};

/**
 * Re-append each merged survivor's occurrence list after validation. A
 * validator `corrected.discussion` replaces the survivor's free text
 * wholesale (applyVerifications), which silently erased the "Also applies
 * to" line and with it every merged-away file's finding from the posted
 * output. The merge record carries the occurrences, so the line is re-built
 * from data rather than preserved by hope; a survivor whose discussion
 * still carries the exact line (validator confirmed without correcting) is
 * left alone, and a survivor validation dropped stays dropped (the
 * documented group-drop failure direction).
 */
export const reapplyCrossFileOccurrences = (
    claims: Claim[],
    merges: readonly CrossFileMerge[],
): Claim[] => {
    const lineFor = new Map<string, string>(
        merges.map((merge) => [merge.survivor, alsoAppliesLine(merge.merged)]),
    );
    return claims.map((claim) => {
        const line = lineFor.get(claim.id);
        return line === undefined || claim.discussion.includes(line)
            ? claim
            : {...claim, discussion: `${claim.discussion}${line}`};
    });
};
