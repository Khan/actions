/**
 * The A/B's cross-source dedup stage: production's pre-validation merge
 * (`dedupeClaims` plus, when the arm's `review.md` defines the clusterer,
 * tier 2's dispatch), run over an arm's live findings.
 *
 * Split out of `live-producer.ts` for the same reason `dispatch-cluster.ts` is
 * split out of `dispatch.ts` — the producer sits at the shared 1000-line cap,
 * and the clustering step is the newest separable stage rather than the one
 * with the most tangled callers.
 */

import {dedupeClaims, type ClaimMerge} from "../lib/dedup";
import type {ClusterRejection} from "../lib/dedup-cluster";
import {
    buildClaims as buildLibClaims,
    parseClustererOutput,
    type Candidate,
    type ProposedCluster,
} from "../lib/dispatch-contracts";
import {hasClusterableCandidatePair} from "../lib/dispatch-cluster";
import type {ExtractedAgent} from "./agent-extract";
// Type-only, so the producer/dedup pair carries no runtime import cycle.
import type {LiveFinding, PerAgentReport} from "./live-producer";

/** What an arm's dedup stage did, for the A/B report. */
export type LiveDedupReport = {
    /** Claims entering the merge (the pre-merge candidate count). */
    candidates: number;
    /** Merged groups, as `dispatch-result.json` records them. */
    merges: ClaimMerge[];
    /** Well-formed clusters the clusterer proposed (0 when it did not run). */
    proposed: number;
    /** Proposed members the merge rules rejected. */
    rejected: ClusterRejection[];
    /** The arm's review.md defines no clusterer: tier 1 only, by construction. */
    clustererAbsent: boolean;
    /**
     * The clusterer was dispatched and returned nothing usable (no output, or
     * an output that would not parse as the contract). Distinct from a
     * clusterer that ran and proposed nothing, which is the same `proposed: 0`
     * and the same zero merges: production keeps the two apart for the same
     * reason (`DispatchClustering.unavailable`), because a paid-for parse
     * failure rendered as "0 by clusterer at $X" reads as a negative result
     * from the one row the graduation decision turns on.
     */
    clustererFailed: boolean;
};

/**
 * Run production's cross-source merge over an arm's live findings.
 *
 * Why this exists at all: the A/B never ran dedup, so a change to it was
 * unmeasurable by construction — the pipeline the eval measured posted every
 * duplicate that production merges, and no report column moved when the merge
 * rules changed. Both arms run tier 1 (it is shared code, and production has
 * had it since #245); tier 2 is carried by the arm's OWN review.md, exactly
 * like the provenance gate's anchor-snap emulation, so a baseline built from a
 * ref that predates the `claim-clusterer` agent runs tier 1 alone and the arm
 * delta prices the clusterer and nothing else.
 *
 * The claim projection is the LIB's `buildClaims`, not the producer's
 * validator-contract one: the merge compares `subject` against
 * `failure_scenario` (falling back to `discussion`), and the eval's own
 * projection puts the whole prose in `subject` and the evidence trace in
 * `discussion`. Feeding that shape to the floors would measure a similarity
 * arithmetic production never runs.
 *
 * What is shared with production and what is not, since fidelity is the whole
 * point: the merge rules (`dedupeClaims`) and the dispatch precondition
 * (`hasClusterableCandidatePair`) are the SAME code `runClusterStep` runs. What
 * this function re-implements is the plumbing that step cannot lend: the
 * dispatch goes through the eval's own agent runner and per-agent cost report,
 * and the survivor's merged prose is written back onto a `LiveFinding` rather
 * than onto a staged claims.json. That is the seam to keep in step by hand
 * (the provenance gate's anchor-snap emulation has the same shape); a rule
 * change does not need mirroring here, a change to WHEN the step runs does.
 */
export const dedupeLiveFindings = async (
    findings: LiveFinding[],
    clusterer: ExtractedAgent | undefined,
    io: {
        dispatch: (
            agent: ExtractedAgent,
            parse: (output: string) => ProposedCluster[],
        ) => Promise<{
            report: PerAgentReport;
            parsed?: ProposedCluster[];
        }>;
        write: (name: string, content: string) => void;
    },
): Promise<{
    kept: LiveFinding[];
    dedup: {report?: PerAgentReport; result: LiveDedupReport};
}> => {
    const claims = buildLibClaims(findings as Candidate[]);
    const clusterable = hasClusterableCandidatePair(claims);
    let proposals: ProposedCluster[] = [];
    let report: PerAgentReport | undefined;
    let clustererFailed = false;
    if (clusterable && clusterer !== undefined) {
        io.write("candidates.json", JSON.stringify(claims, null, 2));
        const dispatched = await io.dispatch(clusterer, parseClustererOutput);
        report = dispatched.report;
        proposals = dispatched.parsed ?? [];
        clustererFailed = dispatched.parsed === undefined;
    }
    const merged = dedupeClaims(claims, proposals);
    const dropped = new Set(
        merged.merges.flatMap((merge) => merge.merged.map((m) => m.id)),
    );
    const survivors = new Map(
        merged.claims.map((claim) => [claim.id, claim] as const),
    );
    const kept = findings
        .filter((live) => !dropped.has(live.finding.id))
        .map((live) => {
            const survivor = survivors.get(live.finding.id);
            if (
                survivor === undefined ||
                !merged.merges.some(
                    (merge) => merge.survivor === live.finding.id,
                )
            ) {
                return live;
            }
            // The survivor's claim carries the "also flagged by" note (the lib
            // projection puts the prose in `discussion`) and may have adopted a
            // merged copy's suggestion; both must reach the rendered comment.
            return {
                ...live,
                finding: {
                    ...live.finding,
                    model_authored_prose: survivor.discussion,
                    ...(survivor.suggestion !== undefined
                        ? {suggested_patch: survivor.suggestion}
                        : {}),
                },
            };
        });
    return {
        kept,
        dedup: {
            ...(report !== undefined ? {report} : {}),
            result: {
                candidates: claims.length,
                merges: merged.merges,
                proposed: proposals.length,
                rejected: merged.clusterRejections,
                clustererAbsent: clusterer === undefined,
                clustererFailed,
            },
        },
    };
};
