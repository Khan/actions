/**
 * The Step 3 defect-clustering step: dedup tier 2's dispatch and its audit
 * record. Split out of `dispatch.ts` for the reason `dispatch-roster.ts` and
 * `dispatch-contracts.ts` were, its max-lines budget (the shared
 * `@khanacademy/eslint-config` caps a file at 1000 and this concern took it
 * over), and following the same precedent: one concern per module, no
 * behaviour change.
 *
 * What lives here is only the *plumbing* — stage the candidates, dispatch the
 * `claim-clusterer`, parse its contract, and turn the outcome into telemetry.
 * Every rule about what may merge, and every check on what the model asserted,
 * lives in `dedup.ts` beside the similarity tier it extends.
 *
 * Determinism boundary: the sub-agent is a model; the skip rule, the parse,
 * and the record are pure code. No prose about the code under review.
 */

import type {ClaimMerge} from "./dedup";
import type {ClusterRejection} from "./dedup-cluster";
import {type Claim, type ProposedCluster} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";

export const CLUSTERER = "claim-clusterer";

/**
 * Whether the candidate set holds a pair tier 2 could legally merge, which is
 * the dispatch precondition: two ANCHORED claims on the SAME path from
 * DIFFERENT sources, at least one of them non-blocking. Every conjunct is one
 * of `dedup.ts`' own rules (a cluster member needs an anchor, cross-file
 * merging is out of both tiers, a reviewer never duplicates itself, and only a
 * non-blocking copy may be absorbed on a model's word; the survivor being the
 * most severe copy, a blocking-only pair has nothing absorbable).
 *
 * With no such pair the clusterer cannot produce a merge whatever it proposes,
 * so the dispatch is pure spend on a serial step. Computed from the candidates
 * already in hand, so the check itself costs nothing.
 *
 * Exported because the live A/B's producer gates on the same precondition; a
 * drift there would have an arm paying for (or skipping) a dispatch production
 * would not.
 */
export const hasClusterableCandidatePair = (
    candidates: readonly Claim[],
): boolean => {
    const anchored = candidates.filter(
        (claim) => claim.path !== undefined && claim.line !== undefined,
    );
    return anchored.some((a, index) =>
        anchored
            .slice(index + 1)
            .some(
                (b) =>
                    a.path === b.path &&
                    a.source !== b.source &&
                    (!isBlockingLabel(a.label) || !isBlockingLabel(b.label)),
            ),
    );
};

/** Dedup tier 2 telemetry (dedup.ts owns the rules; this is the audit). */
export type DispatchClustering = {
    /** Claims the clusterer was given: the pre-merge candidate count. */
    candidates: number;
    /** Well-formed clusters it proposed. */
    proposed: number;
    /** Groups that merged with a tier-2 contribution (`via` is not similarity). */
    clusterMerges: number;
    /**
     * Copies tier 2 is what absorbed, counted per copy rather than per group.
     * Both numbers are recorded because they answer different questions and
     * differ on any run with a `both` group: `clusterMerges` is how many
     * comments tier 2 had a hand in, this is how many duplicate comments it
     * removed. The live A/B's `clusterMerged` column is THIS quantity — the
     * one the graduation decision reads — so a run's artifact and the report
     * that graduated the tier cannot be compared and found to disagree.
     */
    clusterMerged: number;
    /** Proposed members that did not merge, with the rule that stopped them. */
    rejected: ClusterRejection[];
    /** The clusterer ran and returned nothing usable (tier 1 only this run). */
    unavailable?: boolean;
};

/** The dispatcher seams this step needs (closures over the run). */
export type ClusterStepIo = {
    /** Dispatch one agent, returning its final text (null when it failed). */
    dispatch: (name: string) => Promise<string | null>;
    /** Parse a contract with the dispatcher's one corrective re-dispatch. */
    parse: (name: string, output: string) => Promise<ProposedCluster[] | null>;
    /** Stage the candidate set the clusterer reads. */
    write: (content: string) => void;
    /** Emit a run warning (the console seam, so this module stays pure). */
    warn: (message: string) => void;
};

export type ClusterStep = {
    proposals: ProposedCluster[];
    dispatched: boolean;
    unavailable: boolean;
};

/**
 * Dispatch the clusterer over the PRE-merge candidate set. Staged as its own
 * file rather than reusing `claims.json`, which by contract is the POST-merge
 * set the validator reads.
 *
 * Skipped, with no spend, unless there is something only this tier can find:
 * a pair {@link hasClusterableCandidatePair} would let merge. A one-source run
 * has no candidate pair at all (dedup.ts never merges a reviewer's findings
 * into each other, in either tier), and neither does a run whose only
 * cross-source pairs sit in different files or are blocking on both sides.
 *
 * Failure is soft in both directions. A missing definition (an extraction
 * failure, since review.md and this lib ship at one pinned ref) or an unusable
 * output leaves `proposals` empty, which degrades exactly to tier 1 — today's
 * behavior. It deliberately does NOT become a skipped dimension: that list
 * renders author-facing "not assessed this run" note lines about review
 * dimensions, and duplicate hygiene is not a dimension of the review. It
 * surfaces as a run warning and in the artifact's `clustering` block instead.
 */
export const runClusterStep = async (
    candidates: Claim[],
    io: ClusterStepIo,
): Promise<ClusterStep> => {
    if (!hasClusterableCandidatePair(candidates)) {
        return {proposals: [], dispatched: false, unavailable: false};
    }
    io.write(JSON.stringify(candidates, null, 2));
    const output = await io.dispatch(CLUSTERER);
    const parsed = output === null ? null : await io.parse(CLUSTERER, output);
    if (parsed === null) {
        io.warn(
            `::warning title=defect clustering::${CLUSTERER} output unavailable ` +
                `over ${candidates.length} candidate(s); cross-source duplicates ` +
                `merge on text similarity alone this run`,
        );
        return {proposals: [], dispatched: true, unavailable: true};
    }
    return {proposals: parsed, dispatched: true, unavailable: false};
};

/**
 * The run's clustering record, or undefined when the step never ran (nothing
 * to cluster). `candidates` beside `clusterMerges` is what makes the merge rate
 * readable from the artifact, which is the number to trust: duplicate comments
 * that survive are later satisfied by one autofix edit, so the PR itself hides
 * the symptom this tier exists to fix.
 */
export const clusteringRecord = (
    step: ClusterStep,
    candidates: number,
    merged: {merges: ClaimMerge[]; clusterRejections: ClusterRejection[]},
): DispatchClustering | undefined =>
    step.dispatched
        ? {
              candidates,
              proposed: step.proposals.length,
              clusterMerges: merged.merges.filter(
                  (merge) => merge.via !== "similarity",
              ).length,
              clusterMerged: merged.merges.reduce(
                  (sum, merge) =>
                      sum +
                      merge.merged.filter((copy) => copy.via === "clusterer")
                          .length,
                  0,
              ),
              rejected: merged.clusterRejections,
              ...(step.unavailable ? {unavailable: true} : {}),
          }
        : undefined;
