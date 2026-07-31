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

import type {ClaimMerge, ClusterRejection} from "./dedup";
import {type Claim, type ProposedCluster} from "./dispatch-contracts";

export const CLUSTERER = "claim-clusterer";

/** Dedup tier 2 telemetry (dedup.ts owns the rules; this is the audit). */
export type DispatchClustering = {
    /** Claims the clusterer was given: the pre-merge candidate count. */
    candidates: number;
    /** Well-formed clusters it proposed. */
    proposed: number;
    /** Groups that merged with a tier-2 contribution (`via` is not similarity). */
    clusterMerges: number;
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
 * two claims from two different sources. A single reviewer's findings are never
 * merged into each other (dedup.ts' rule, both tiers), so a one-source run has
 * no candidate pair at all.
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
    const sources = new Set(candidates.map((claim) => claim.source));
    if (candidates.length < 2 || sources.size < 2) {
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
              rejected: merged.clusterRejections,
              ...(step.unavailable ? {unavailable: true} : {}),
          }
        : undefined;
