/**
 * Cross-source duplicate-claim merge (the #245 ledger item), applied to the
 * built claims BEFORE the claim-validator dispatch: trial run 29897276810
 * posted the same AddDate months-vs-days defect four times (correctness,
 * completeness, first-principles, and a skill-auditor out-of-lane handoff),
 * and every copy was separately validated — validation is the single largest
 * sub-agent cost line, so duplicates are merged before it, not after.
 *
 * Merges arrive from TWO tiers, and the split is the module's central idea.
 *
 * 1. **Text similarity** (below): claims from DIFFERENT sources, anchored on
 *    the same path, whose text clearly describes the same defect (token-set
 *    similarity plus a shared-phrase floor, calibrated on the real claim sets
 *    of runs 29897276810, 29943085279 and 30301235749). Still no line window:
 *    run 29943085279's missing-deletion-test defect posted twice with anchors
 *    43 lines apart in expiration_test.go (:15 and :58), so proximity can
 *    never be required. An IDENTICAL anchor is used the other way round, as
 *    evidence: two sources landing on the same `(path, line)` clear a lower
 *    text floor than two sources landing on different lines.
 * 2. **Model-proposed defect clusters** ({@link verifiableClusters}): the
 *    `claim-clusterer` sub-agent reads the candidate set and names the groups
 *    that describe ONE defect, each grounded in the code element its members
 *    share. This module verifies that assertion and owns every merge rule; the
 *    model contributes identity only.
 *
 * They run in that ORDER, and {@link dedupeClaims} explains why at length: tier
 * 1 settles completely, and tier 2 only ever merges the comments it left
 * standing. That is the whole of what makes tier 2 additive — no per-member
 * check can promise it — and it is why a run with the clusterer can never post
 * more comments than the same run without it.
 *
 * Why a second tier at all — the limit of tier 1, measured. Run 30587343777
 * (webapp#41204, a FIRST review at `depth: full`, so no re-review artifact)
 * had four sources flag one wrong doc comment (`// Keeps at most 10 samples
 * per key.` above `const maxSamples = 25`) at window.go :8, :9, :8, :8, and
 * merged none of them. Replaying that run's own claims.json: THREE of the four
 * share the exact anchor and still score 0.060-0.068 Jaccard on a 0.14 floor
 * with 0-1 shared bigrams on a floor of 4 — an order of magnitude below the
 * tier, not a thin margin. Each reviewer wrote the same defect in different
 * words ("wrong cap (10 vs 25)", "per-key cap is 10 but maxSamples is 25", a
 * verbatim quote of the comment), and the terser the claim the less text
 * arithmetic has to work with. The floor that admits 0.06 admits everything.
 *
 * And the discriminator cannot be recovered by reweighting the text, because
 * the pairs this module deliberately KEEPS apart share more salient tokens
 * than the real duplicates do: run 29943085279's AddDate arithmetic issue and
 * its "central behavior never exercised" thought sit on one line and share
 * AddDate, MemoryTTLDays, 180 and 15. Duplicates are "same ask, different
 * words"; those pairs are "same facts, different ask" (a bug versus its
 * missing test). Telling those apart is a semantic judgment, so tier 2 asks a
 * model for it rather than pretending a fourth threshold would find it.
 *
 * Nor by asking each finder for an identity key of its own, which would
 * cluster deterministically at zero dispatch and was the first thing tried on
 * paper. A finder mints its key blind: it has not seen the other reviewers'
 * findings, so two of them agreeing on one defect would have to independently
 * choose the SAME string, which is the semantic-agreement problem the text
 * floors already lose, moved into a shorter string with less to work with
 * (`maxSamples`, "the doc/constant mismatch" and "window.go:8 comment" are all
 * defensible keys for run 30587343777's one defect). Where a blind key DOES
 * agree is the case that must not merge: the AddDate pair above would both key
 * on `AddDate`, so the scheme collides hardest exactly where "same facts,
 * different ask" needs separating. The clusterer's `evidence` is not that key
 * and cannot be produced by a finder, because it is chosen AFTER reading the
 * candidate set; comparison is what makes it possible, which is why it can be
 * verified against every member's text here rather than merely trusted.
 *
 * The unit of identity, restated: the DEFECT, not the anchor. Tier 2 needs no
 * line agreement at all, which is what finally makes the
 * same-defect-different-anchor shape mergeable (one missing-test defect drew
 * comments at three anchors in run 29943085279; tier 1 can only reach the
 * pairs that also clear its looser text floor). The line survives as evidence
 * inside tier 1 and as the survivor's posting anchor, and nothing more.
 *
 * The survivor is the highest-severity copy, it gains a structured
 * `also_flagged_by` record (naming each other source, its anchor when it
 * differs, and the subject of any copy tier 2 absorbed, whose ask the
 * survivor's own prose is not known to restate; the posting surface
 * renders the record into the comment's collapsed attribution footer,
 * attribution.ts, so a validator discussion rewrite cannot drop it), and
 * every merge is recorded for
 * dispatch-result.json with the tier that found it (per group and per absorbed
 * copy), so the merge rate is readable from the artifact rather than from what
 * survives on the PR.
 *
 * Determinism boundary: every merge RULE is code — pure text arithmetic, no
 * filesystem. The one model input is tier 2's identity assertion, and it
 * enters through {@link verifiableClusters}, which trusts none of it: the ids
 * must exist, the paths and sources must satisfy the same constraints tier 1
 * enforces, the model's own grounding evidence must appear in every member's
 * text unless the member sits on the survivor's exact line, and only a
 * NON-BLOCKING copy may be absorbed on a model's word
 * ({@link clusterMemberRejection} carries the reasoning). What a tier-2 error
 * can cost is bounded by code even where its judgment cannot be checked.
 */

import {type AlsoFlagged} from "./attribution";
import {
    bigrams,
    contentTokens,
    EXACT_ANCHOR_FLOOR,
    intersectionSize,
    OTHER_LINE_FLOOR,
} from "./dedup-text";
import {type Claim, type ProposedCluster} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";
import {
    clusterMemberRejection,
    salientTokens,
    verifiableClusters,
    type ClusterRejection,
} from "./dedup-cluster";

/** Which tier identified a merged group (dispatch-result.json audit). */
export type MergeVia = "similarity" | "clusterer" | "both";

export type ClaimMerge = {
    survivor: string;
    merged: {
        id: string;
        source: string;
        label: string;
        /** The merged copy's own anchor, when it differs from the survivor's. */
        line?: number;
        /**
         * Present when THIS copy was absorbed on the clusterer's assertion
         * rather than on the text floor; absent means tier 1 merged it. Per
         * member because a group's own `via` can be `both`, and a reader
         * counting tier 2's contribution from the group would then attribute
         * tier 1's members to the clusterer.
         */
        via?: "clusterer";
        /**
         * Which path grounded a clusterer-absorbed copy: the exactly shared
         * anchor, or the evidence's vocabulary. Present exactly when `via`
         * is. The planned audit of "ungrounded" rejections reads
         * dispatch-result.json, and without this field an anchor-grounded
         * merge is indistinguishable there from an evidence-grounded one
         * (the stamped evidence string may have contributed nothing).
         */
        groundedBy?: "anchor" | "evidence";
    }[];
    path: string;
    line: number;
    via: MergeVia;
    /** The clusterer's grounding evidence, when tier 2 found this group. */
    evidence?: string;
};

const comparisonKey = (text: string): string =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

/**
 * The text a claim is compared on: its subject plus its failure scenario,
 * EXCEPT when the failure scenario only restates the subject, in which case
 * the discussion prose stands in for it.
 *
 * That exception is the whole reason run 30301235749 merged nothing at
 * expiration.go:38. A label-shape reviewer that omits `failure_scenario`
 * gets its own subject back as one (`dispatch-contracts`' salvage, added so
 * a missing field could not void a whole dimension), so the default
 * correctness pass (whose findings carry a one-line title and all of their
 * evidence in `discussion`) arrived here as eleven content tokens repeated
 * twice. Against the four discursive copies of the same TTL-unit defect it
 * scored 0.13-0.23 Jaccard on a 0.2 floor and 0-3 shared bigrams on a floor
 * of 4, and the run posted three blocking comments and a note for one
 * defect. Reading `discussion` for those claims (and only those: feeding it
 * to every claim pulls run 29943085279's distinct same-line issue/thought
 * pair up to ten shared bigrams, past every real duplicate) restores the
 * evidence the reviewer actually wrote.
 */
const comparedText = (claim: Claim): string => {
    const subject = comparisonKey(claim.subject);
    const failure = comparisonKey(claim.failure_scenario);
    return subject.startsWith(failure) || failure.startsWith(subject)
        ? `${claim.subject} ${claim.discussion}`
        : `${claim.subject} ${claim.failure_scenario}`;
};

/** Whether two claims clearly describe the same defect (text similarity). */
export const describesSameDefect = (a: Claim, b: Claim): boolean => {
    const tokensA = contentTokens(comparedText(a));
    const tokensB = contentTokens(comparedText(b));
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    if (setA.size === 0 || setB.size === 0) {
        return false;
    }
    const shared = intersectionSize(setA, setB);
    const jaccard = shared / (setA.size + setB.size - shared);
    const overlap = shared / Math.min(setA.size, setB.size);
    const sharedBigrams = intersectionSize(bigrams(tokensA), bigrams(tokensB));
    const floor =
        a.line !== undefined && a.line === b.line
            ? EXACT_ANCHOR_FLOOR
            : OTHER_LINE_FLOOR;
    return (
        jaccard >= floor.jaccard &&
        overlap >= floor.overlap &&
        sharedBigrams >= floor.sharedBigrams
    );
};

/**
 * Same path, any line distance: run 29943085279 posted the
 * missing-deletion-test defect at expiration_test.go:15 and :58 (43 lines
 * apart), and the old two-line window kept both copies separate; the
 * similarity floors carry the precision, tiered on whether the two anchors
 * are identical. Cross-FILE merging stays out: that same run flagged the
 * defect in expiration.go too (:62, :38) and a floor loose enough to catch
 * a cross-file pair needs its own strictly higher calibration; a missed
 * merge only costs a duplicate comment.
 */
const mergeable = (a: Claim, b: Claim): boolean =>
    a.source !== b.source &&
    a.path !== undefined &&
    a.path === b.path &&
    a.line !== undefined &&
    b.line !== undefined &&
    describesSameDefect(a, b);

/**
 * Survivor choice within a duplicate group: the highest-severity copy
 * (blocking label beats non-blocking), then higher confidence, then dispatch
 * order (the array follows the Step 3 dispatch ranking, so the default
 * correctness pass wins ties).
 */
const survivorFirst = (
    indexA: number,
    indexB: number,
    claims: Claim[],
): number => {
    const a = claims[indexA];
    const b = claims[indexB];
    const blockingA = isBlockingLabel(a.label) ? 1 : 0;
    const blockingB = isBlockingLabel(b.label) ? 1 : 0;
    if (blockingA !== blockingB) {
        return blockingA > blockingB ? indexA : indexB;
    }
    if (a.confidence !== b.confidence) {
        return a.confidence > b.confidence ? indexA : indexB;
    }
    return indexA < indexB ? indexA : indexB;
};

/**
 * Merge cross-source duplicates, preserving claim order: the similarity tier
 * FIRST and on its own, then the defect clusters the clusterer proposed
 * (verified here, never trusted) over whatever tier 1 left standing.
 * Non-anchored claims and everything neither tier identifies pass through
 * untouched; when in doubt, don't merge (a false merge silently drops a
 * reviewer's distinct finding, a missed merge only costs a duplicate comment).
 *
 * The pass ORDER is the guarantee, not an implementation detail. Tier 2 may add
 * merges and must never subtract them, and that only holds by construction if
 * tier 1's groups are settled before a model-proposed cluster can touch them.
 * A single union-find over both tiers cannot promise it however carefully each
 * member is screened: unioning even a perfectly legal cluster member changes
 * who wins the group's survivor election, and the star guard below then orphans
 * the tier-1 duplicates that were mergeable against the OLD survivor and not
 * against the new one. Concretely, with `b`, `c` and `d` all tier-1 mergeable
 * against `a` and a higher-confidence `x` clustered with `b` alone, the merged
 * group elects `x`, absorbs `b`, and leaves `a`, `c` and `d` posting three
 * comments where tier 1 alone posted one.
 *
 * So: tier 1 runs to completion, and what it leaves standing — each surviving
 * comment, plus every claim it declined to fold in — is the only thing tier 2
 * gets to see. A cluster member tier 1 already absorbed is read at the comment
 * it now posts under (its head), and a head absorbed by tier 2 carries its own
 * tier-1 copies along, because this pass merges COMMENTS and that comment
 * already speaks for them. A cluster whose members tier 1 has already collapsed
 * into one head therefore merges nothing and rejects nothing: it asserted an
 * identity the text floors had reached first.
 *
 * `clusterRejections` is the tier-2 audit trail (see {@link ClusterRejection});
 * it is empty both when the clusterer proposed nothing and when everything it
 * proposed merged, so read it beside the proposal count, never alone.
 */
export const dedupeClaims = (
    claims: Claim[],
    proposals: readonly ProposedCluster[] = [],
): {
    claims: Claim[];
    merges: ClaimMerge[];
    clusterRejections: ClusterRejection[];
} => {
    const {clusterOf, evidence, rejections} = verifiableClusters(
        claims,
        proposals,
    );
    const clusterRejections = [...rejections];

    /** Claim index -> the claim whose comment it posts under after tier 1. */
    const head = claims.map((_, index) => index);
    /** Survivor index -> the copies folded into it, with the tier that did it. */
    const absorbed = new Map<
        number,
        {
            index: number;
            via?: "clusterer";
            groundedBy?: "anchor" | "evidence";
        }[]
    >();
    /** Survivor index -> the clusterer's grounding evidence, when tier 2 fired. */
    const groundedIn = new Map<number, string>();

    // ---- Tier 1: union-find over pairwise-mergeable claims.
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
            if (mergeable(claims[i], claims[j])) {
                parent[find(j)] = find(i);
            }
        }
    }
    const groups = new Map<number, number[]>();
    claims.forEach((_, index) => {
        const root = find(index);
        groups.set(root, [...(groups.get(root) ?? []), index]);
    });
    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }
        const survivorIndex = group.reduce((best, index) =>
            survivorFirst(best, index, claims),
        );
        // Star guard: only a member {@link mergeable} against the survivor
        // merges. Union-find alone chains A~B~C through a bridging claim that
        // bundles two defects (a test-adequacy finding naming both a missing
        // test and an unbounded read links the two distinct correctness
        // findings), and collapsing the chain would silently drop a distinct
        // finding; with no line window bounding groups, a bridge can span a
        // whole file. Chain-only members stay their own claims. Both recorded
        // trial merges are unaffected: run 29897276810's four-way group is
        // pairwise-complete and run 29943085279's is a direct pair.
        const merged = group.filter(
            (index) =>
                index !== survivorIndex &&
                mergeable(claims[survivorIndex], claims[index]),
        );
        if (merged.length === 0) {
            continue;
        }
        for (const index of merged) {
            head[index] = survivorIndex;
        }
        absorbed.set(
            survivorIndex,
            merged.map((index) => ({index})),
        );
    }

    // ---- Tier 2: the verified clusters, over tier 1's heads.
    //
    // Each named member is read at its head, and a head takes the LOWEST
    // ordinal that reaches it, so a head is a candidate in exactly one cluster
    // however tier 1 has reshaped things and nothing can be absorbed twice.
    // Rejections stay keyed to the ids the clusterer actually named.
    const clusterHead = new Map<number, number>();
    const namedByHead = new Map<number, string[]>();
    for (const [index, ordinal] of clusterOf) {
        const owner = head[index];
        const seen = clusterHead.get(owner);
        clusterHead.set(
            owner,
            seen === undefined ? ordinal : Math.min(seen, ordinal),
        );
        namedByHead.set(owner, [
            ...(namedByHead.get(owner) ?? []),
            claims[index].id,
        ]);
    }
    const headsByOrdinal = new Map<number, number[]>();
    for (const [owner, ordinal] of clusterHead) {
        headsByOrdinal.set(ordinal, [
            ...(headsByOrdinal.get(ordinal) ?? []),
            owner,
        ]);
    }
    for (const ordinal of [...headsByOrdinal.keys()].sort((a, b) => a - b)) {
        const heads = (headsByOrdinal.get(ordinal) as number[]).sort(
            (a, b) => a - b,
        );
        if (heads.length < 2) {
            continue;
        }
        const survivorIndex = heads.reduce((best, index) =>
            survivorFirst(best, index, claims),
        );
        const survivor = claims[survivorIndex];
        // The grounding rules (both ends of the vocabulary check, and the
        // shared-anchor path that needs no vocabulary) live in
        // clusterMemberRejection, per member: the survivor-end test cannot sit
        // out here as a group-level gate or it would veto a member the anchor
        // path grounds (run 32390393344's pair, where the survivor shares no
        // token with the evidence and the member sits on its exact line).
        const groupEvidence = evidence[ordinal];
        const evidenceTokens = salientTokens(groupEvidence);
        const into = absorbed.get(survivorIndex) ?? [];
        for (const index of heads) {
            if (index === survivorIndex) {
                continue;
            }
            // The structural rules re-run here, not only in the parse-time
            // screen: they were checked against the proposal's own anchor, and
            // the head that survived tier 1 need not be the claim the model
            // named.
            const reason = clusterMemberRejection(
                survivor,
                claims[index],
                evidenceTokens,
            );
            if (reason !== undefined) {
                for (const id of namedByHead.get(index) ?? []) {
                    clusterRejections.push({id, reason});
                }
                continue;
            }
            // The head comes over with everything tier 1 folded into it: this
            // pass merges COMMENTS, and that comment already speaks for its own
            // absorbed copies. Dropping them here instead would leave them
            // posting on their own — tier 2 subtracting a tier-1 merge.
            // Mirrors the first grounding test in clusterMemberRejection: a
            // member on the survivor's exact line was admitted by the anchor
            // before any vocabulary ran, everything else by the evidence.
            into.push({
                index,
                via: "clusterer",
                groundedBy:
                    claims[index].line !== undefined &&
                    claims[index].line === survivor.line
                        ? "anchor"
                        : "evidence",
            });
            into.push(...(absorbed.get(index) ?? []));
            absorbed.delete(index);
            groundedIn.set(survivorIndex, groupEvidence);
        }
        if (into.length > 0) {
            absorbed.set(survivorIndex, into);
        }
    }

    // ---- Render one merge per surviving comment, in claim order.
    const drop = new Set<number>();
    const replacement = new Map<number, Claim>();
    const merges: ClaimMerge[] = [];
    const entries = [...absorbed.entries()].filter(
        ([, list]) => list.length > 0,
    );
    entries.sort(
        ([a, listA], [b, listB]) =>
            Math.min(a, ...listA.map((copy) => copy.index)) -
            Math.min(b, ...listB.map((copy) => copy.index)),
    );
    for (const [survivorIndex, list] of entries) {
        const survivor = claims[survivorIndex];
        const others = [...list].sort((a, b) => a.index - b.index);
        for (const {index} of others) {
            drop.add(index);
        }
        const otherClaims = others.map(({index}) => claims[index]);
        // One entry per other source, first copy wins, naming that copy's
        // anchor when it is not the survivor's. With tier 2 merging across
        // anchors, "also flagged by test-adequacy" alone would hide that the
        // second reviewer was looking at a different line, which is exactly
        // the context an author needs to judge a same-defect-different-anchor
        // merge (and to spot a wrong one).
        //
        // A tier-2 copy also carries its own SUBJECT, and only a tier-2 copy
        // does. What the record must not lose is an ask the survivor's prose
        // does not already make: run 30587343777's `conventions` copy of the
        // wrong-cap defect asked for the symbol-name prefix, not for the
        // number, and one rewritten comment discharges both only if the author
        // is told about both. Tier 1 needs no such quote by construction: a
        // copy merged there cleared the text floor AGAINST the survivor, which
        // is exactly the evidence that it restates the survivor's own words;
        // repeating four near-identical subjects would move the duplicate
        // noise into the surviving comment rather than remove it. Tier 2 is
        // the case where that evidence is missing (the floor is what it could
        // not clear), so there the quote is the only thing carrying the ask.
        //
        // Recorded as the structured `also_flagged_by` field, NOT appended to
        // `discussion`: dedup runs before the claim-validator, whose
        // `corrected.discussion` rewrite replaces the prose wholesale, so a
        // note riding the discussion could silently vanish. The posting
        // surface (submission.ts) renders the field into the comment's
        // collapsed attribution footer.
        const sources: AlsoFlagged[] = [];
        for (const {index, via} of others) {
            const claim = claims[index];
            if (
                claim.source === survivor.source ||
                sources.some((seen) => seen.source === claim.source)
            ) {
                continue;
            }
            sources.push({
                source: claim.source,
                ...(claim.line !== undefined && claim.line !== survivor.line
                    ? {line: claim.line}
                    : {}),
                ...(via === "clusterer"
                    ? {subject: claim.subject.replace(/\s+/g, " ").trim()}
                    : {}),
            });
        }
        const adoptedSuggestion =
            survivor.suggestion === undefined
                ? otherClaims.find((claim) => claim.suggestion !== undefined)
                      ?.suggestion
                : undefined;
        const adoptedDispute =
            survivor.author_dispute === undefined
                ? otherClaims.find(
                      (claim) => claim.author_dispute !== undefined,
                  )?.author_dispute
                : undefined;
        replacement.set(survivorIndex, {
            ...survivor,
            ...(sources.length > 0 ? {also_flagged_by: sources} : {}),
            ...(adoptedSuggestion !== undefined
                ? {suggestion: adoptedSuggestion}
                : {}),
            ...(adoptedDispute !== undefined
                ? {author_dispute: adoptedDispute}
                : {}),
        });
        const clusterCount = others.filter(
            (copy) => copy.via === "clusterer",
        ).length;
        const via: MergeVia =
            clusterCount === 0
                ? "similarity"
                : clusterCount === others.length
                ? "clusterer"
                : "both";
        const groupEvidence = groundedIn.get(survivorIndex);
        merges.push({
            survivor: survivor.id,
            merged: others.map(({index, via: copyVia, groundedBy}) => {
                const claim = claims[index];
                return {
                    id: claim.id,
                    source: claim.source,
                    label: claim.label,
                    ...(claim.line !== undefined && claim.line !== survivor.line
                        ? {line: claim.line}
                        : {}),
                    ...(copyVia === "clusterer" ? {via: copyVia} : {}),
                    ...(groundedBy === undefined ? {} : {groundedBy}),
                };
            }),
            path: survivor.path as string,
            line: survivor.line as number,
            via,
            ...(groupEvidence === undefined ? {} : {evidence: groupEvidence}),
        });
    }
    return {
        claims: claims
            .map((claim, index) => replacement.get(index) ?? claim)
            .filter((_, index) => !drop.has(index)),
        merges,
        clusterRejections,
    };
};
