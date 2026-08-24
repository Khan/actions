/**
 * Dedup tier 2: the `claim-clusterer`'s proposed defect clusters, code-verified.
 *
 * The model contributes IDENTITY and nothing else — which candidate claims
 * describe one defect, and the code element they share. Every merge rule lives
 * here and in `dedup.ts`; nothing the clusterer says is taken on trust. See
 * `dedup.ts`'s header for why a second tier exists at all (tier 1's text floors
 * are an order of magnitude away from the real four-way duplicate of run
 * 30587343777, and the discriminator is semantic, not arithmetic).
 *
 * Split from `dedup.ts` because that file sits at the shared 1000-line cap and
 * this is its newest separable concern; the tests were already named for the
 * split (`dedup-cluster.test.ts`), and `dispatch-cluster.ts` owns the dispatch
 * and telemetry side of the same tier.
 *
 * Verification runs in TWO passes, and the split matters:
 *
 * 1. {@link verifiableClusters}, at parse time: id resolution, anchors, one
 *    cluster per claim, and the STRUCTURAL rules (shared path, distinct
 *    sources, at most one blocking member) against the proposal's own anchor.
 *    This is what keeps an illegal member from out-ranking a legal one inside
 *    the proposal and taking the merge down with it.
 * 2. {@link clusterMemberRejection}, per member against the group's ACTUAL
 *    survivor, which is a claim tier 1 may have elected after the proposal was
 *    made. Re-checking there is what keeps the guarantee honest; the parse-time
 *    screen narrows what may be proposed, it does not replace the final check.
 *
 * Neither pass is what keeps tier 2 from SUBTRACTING a merge — from leaving a
 * run with more comments than tier 1 alone would have posted. No per-member
 * screen can: a member can be legal in every respect and still displace the
 * survivor of a tier-1 group it was clustered into, orphaning that group's
 * other copies. That guarantee lives in `dedup.ts`, in the order the tiers run
 * (tier 1 settles first, tier 2 sees only what it left standing), and its
 * reasoning is written down there.
 */

import {type Claim, type ProposedCluster} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";

/**
 * One member a proposed cluster named that did NOT merge, with the rule that
 * rejected it. Recorded per run because an empty rejection list and an empty
 * proposal list mean opposite things, and the module has already been burned
 * by that ambiguity once (see `dedup.ts`'s `stagedThreadShapeFailure`):
 * a clusterer naming ids that do not exist is a prompt or staging failure, and
 * it must not read as "no duplicates found".
 */
export type ClusterRejection = {
    id: string;
    reason:
        | "unknown-id"
        | "no-anchor"
        | "other-path"
        | "same-source"
        | "blocking-member"
        | "ungrounded"
        | "already-clustered"
        | "cluster-collapsed";
};

/**
 * Whether a token names something in the code rather than in English: an
 * interior case change (`maxSamples`, `AddDate`, `TrimTo`), an all-caps
 * initialism (`TTL`), an underscore (`created_at`, `expiration_test`), or a
 * multi-digit literal (`10`, `25`, `180`).
 *
 * This is the vocabulary tier 2's grounding check runs over, and it is
 * deliberately narrow. A single-digit number is noise (`0` appears in half of
 * all claims), and a bare lowercase word is English until proven otherwise —
 * `cutoff` and `samples` would ground almost any two claims about the same
 * file, which is precisely the confusion between "same code area" and "same
 * defect" that this tier exists to avoid. A defect nameable only in such words
 * is not model-mergeable; it falls back to tier 1, and a missed merge costs a
 * duplicate comment while a wrong one drops a reviewer's distinct finding.
 */
const isSalientToken = (raw: string): boolean =>
    /[a-z][A-Z]/.test(raw) ||
    /^[A-Z]{2,}$/.test(raw) ||
    raw.includes("_") ||
    /^\d{2,}$/.test(raw);

/**
 * One canonical form per code name: lowercased with underscores folded out, so
 * `PreFlightModerationCheck` and `pre_flight_moderation_check` read as one
 * token. Run 32390393344 (webapp#41609) is why: its two claims named the same
 * config key in Go casing and JSON casing, and a comparison keyed on casing
 * style tests how a name was spelled, not what it names. Salience is still
 * judged on the RAW spelling above (the underscore or the interior case change
 * is often the evidence of code-ness that folding would erase).
 */
const canonicalToken = (raw: string): string =>
    raw.toLowerCase().replace(/_/g, "");

/** The code-naming tokens in a text, canonicalized for comparison. */
export const salientTokens = (text: string): Set<string> => {
    const tokens = new Set<string>();
    for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? []) {
        if (isSalientToken(raw)) {
            const canonical = canonicalToken(raw);
            // A token of underscores alone (`_`, `__`) is salient on its raw
            // spelling but folds to the empty string, which would then ground
            // any two claims that each quote one (e.g. Go's blank identifier).
            if (canonical !== "") {
                tokens.add(canonical);
            }
        }
    }
    return tokens;
};

/** Everything a claim says, for the grounding check (evidence lives anywhere). */
const claimText = (claim: Claim): string =>
    `${claim.subject} ${claim.discussion} ${claim.failure_scenario}`;

const sharesSalientToken = (
    evidenceTokens: ReadonlySet<string>,
    claim: Claim,
): boolean => {
    const tokens = salientTokens(claimText(claim));
    for (const token of evidenceTokens) {
        if (tokens.has(token)) {
            return true;
        }
    }
    return false;
};

/**
 * The structural half of the tier-2 rules, checked against a reference claim:
 *
 * - **same path**, as in tier 1. Cross-file merging stays out of both tiers;
 *   its own calibration is a separate question and a missed merge is cheap.
 * - **different source**, as in tier 1: a reviewer does not duplicate itself,
 *   and collapsing two of one reviewer's findings would silently drop one.
 * - **non-blocking**: tier 2 may absorb an advisory copy into any survivor,
 *   but a BLOCKING claim only ever merges on tier 1's text floor. This is the
 *   risk grading, and the one place the tiers deliberately differ in power
 *   rather than in method. The model owns identity here, so a wrong grouping IS
 *   possible in a way no code check catches: "same facts, different ask" (run
 *   30301235749's AddDate handoff and the missing-test todo it rode both name
 *   `AddDate`, so grounding cannot separate them; only the clusterer's
 *   judgment does). Capping what such an error can cost is therefore part of
 *   the design: since the survivor is always the highest-severity copy, a false
 *   tier-2 merge can lose an advisory comment and can never lose a blocking
 *   finding or soften the verdict. The price is real and accepted: one defect
 *   flagged blocking by two sources in different words still posts twice
 *   unless tier 1 reaches it.
 *
 * Deliberately absent: any line REQUIREMENT, and any text-similarity floor.
 * Both are what tier 2 exists to get past. (An exactly shared line does count
 * FOR a member, as grounding; see {@link clusterMemberRejection}.)
 */
const structuralRejection = (
    reference: Claim,
    member: Claim,
): "other-path" | "same-source" | "blocking-member" | undefined => {
    if (member.path !== reference.path) {
        return "other-path";
    }
    if (member.source === reference.source) {
        return "same-source";
    }
    if (isBlockingLabel(member.label)) {
        return "blocking-member";
    }
    return undefined;
};

/**
 * The per-member rules a model-proposed merge must satisfy, checked against
 * the group's ACTUAL survivor (which union with tier 1 can change after the
 * proposal was made, so re-checking here rather than at parse time is what
 * keeps the guarantee honest): the structural rules above, plus
 *
 * - **grounded**, by either of two paths:
 *
 *   An exactly shared anchor: the member sits on the survivor's own line (the
 *   paths already match structurally). A cross-source pair on the identical
 *   line is the one identity assertion this module can verify without any
 *   vocabulary at all, and the vocabulary path cannot be the only one: the
 *   evidence is model prose with free word choice, and run 32390393344
 *   (webapp#41609) showed it grading the clusterer's phrasing rather than the
 *   claims. There the clusterer correctly grouped two same-line copies of one
 *   finding, wrote its evidence in the hunk's identifiers
 *   (`_configIncludesModeration`), and both claims spoke config-side
 *   (`pre_flight_moderation_check`), zero shared tokens, true merge vetoed.
 *   Only claims the model PROPOSED reach this check, so a same-line neighbour
 *   it never named cannot ride in on its anchor.
 *
 *   Failing that, the vocabulary tripwire as before: the cluster's evidence
 *   must name at least one code element ({@link isSalientToken}), the SURVIVOR
 *   must mention one (tier 1 can have elected a comment the proposal never
 *   saw, and absorbing a member into an unrelated comment is the failure mode
 *   this end catches), and the member must mention one too. A group whose
 *   members share no named code with the identity the model asserted is not
 *   an identity claim this module can check, so it does not merge. Grounding
 *   the member against the survivor's own text instead would NOT be safe:
 *   run 30587343777's cap survivor names `staleAfter` in a while-here aside,
 *   and the distinct staleAfter finding would ground against it (the pinned
 *   counterexample in dedup-cluster.test.ts).
 */
export const clusterMemberRejection = (
    survivor: Claim,
    member: Claim,
    evidenceTokens: ReadonlySet<string>,
): ClusterRejection["reason"] | undefined => {
    const structural = structuralRejection(survivor, member);
    if (structural !== undefined) {
        return structural;
    }
    if (member.line !== undefined && member.line === survivor.line) {
        return undefined;
    }
    const evidenceUsable =
        evidenceTokens.size > 0 && sharesSalientToken(evidenceTokens, survivor);
    return evidenceUsable && sharesSalientToken(evidenceTokens, member)
        ? undefined
        : "ungrounded";
};

/**
 * Hold one proposal's members to the structural rules at parse time.
 *
 * This is not the survivor election — that happens after tier 1 has had its
 * say, and {@link clusterMemberRejection} re-runs against whatever claim wins
 * it. It is the narrower guarantee that a member tier 2 could never absorb
 * cannot cost the merge the proposal was RIGHT about: a cross-path or
 * same-source member left in the proposal can out-rank the legal members and
 * become the group's survivor, at which point they are rejected against it and
 * the whole proposal comes to nothing.
 *
 * The anchor is the proposal's own blocking member if it has one, else the
 * first member the id screen kept (the model's output order, the tiebreak the
 * proposal loop already uses). Only the severity rule is asymmetric — path
 * equality and source inequality read the same whichever member is anchor — so
 * this is exactly the "at most one blocking member, and it is the one that
 * could survive" reading of the rule, and nothing more: a proposal pairing an
 * advisory copy with a blocking one is legal and must stay so, since that is
 * the merge tier 2 exists to make.
 *
 * Offending members are dropped, not the whole proposal: a proposal naming one
 * bad member alongside a legal pair still merges the pair, and the >= 2
 * collapse rule takes care of what is left.
 *
 * The rules are checked against the anchor only, exactly as
 * {@link clusterMemberRejection} checks them against the survivor — this is a
 * filter on what may be proposed, not a stricter tier. Two copies from ONE
 * source can therefore still ride into a cluster anchored on a third; that is
 * the pre-existing shape of the source rule in both tiers, unchanged here.
 */
const structurallyVerified = (
    members: number[],
    claims: Claim[],
    rejections: ClusterRejection[],
): number[] => {
    if (members.length === 0) {
        return [];
    }
    const anchor =
        members.find((index) => isBlockingLabel(claims[index].label)) ??
        members[0];
    const kept: number[] = [];
    for (const index of members) {
        if (index === anchor) {
            kept.push(index);
            continue;
        }
        const reason = structuralRejection(claims[anchor], claims[index]);
        if (reason !== undefined) {
            rejections.push({id: claims[index].id, reason});
            continue;
        }
        kept.push(index);
    }
    return kept;
};

/**
 * Resolve the clusterer's proposals against the claim set: map ids to claims,
 * hold each claim to at most one cluster (first proposal wins, in the model's
 * own output order, so the result is deterministic), drop what cannot anchor a
 * comment, and hold what is left to the structural rules
 * ({@link structurallyVerified}). Every drop is recorded.
 *
 * What survives is a MEMBERSHIP hint whose members are all legally absorbable
 * relative to one another; which of them actually collapses is decided later,
 * per member, against the group's survivor ({@link clusterMemberRejection}).
 */
export const verifiableClusters = (
    claims: Claim[],
    proposals: readonly ProposedCluster[],
): {
    /** Claim index -> cluster ordinal. */
    clusterOf: Map<number, number>;
    /** Cluster ordinal -> the model's grounding evidence. */
    evidence: string[];
    rejections: ClusterRejection[];
} => {
    const indexById = new Map<string, number>();
    claims.forEach((claim, index) => {
        if (!indexById.has(claim.id)) {
            indexById.set(claim.id, index);
        }
    });
    const clusterOf = new Map<number, number>();
    const evidence: string[] = [];
    const rejections: ClusterRejection[] = [];
    for (const proposal of proposals) {
        const named: number[] = [];
        for (const id of proposal.ids) {
            const index = indexById.get(id);
            if (index === undefined) {
                rejections.push({id, reason: "unknown-id"});
                continue;
            }
            if (clusterOf.has(index)) {
                rejections.push({id, reason: "already-clustered"});
                continue;
            }
            const claim = claims[index];
            if (claim.path === undefined || claim.line === undefined) {
                rejections.push({id, reason: "no-anchor"});
                continue;
            }
            named.push(index);
        }
        const members = structurallyVerified(named, claims, rejections);
        if (members.length < 2) {
            for (const index of members) {
                rejections.push({
                    id: claims[index].id,
                    reason: "cluster-collapsed",
                });
            }
            continue;
        }
        const ordinal = evidence.length;
        evidence.push(proposal.evidence);
        for (const index of members) {
            clusterOf.set(index, ordinal);
        }
    }
    return {clusterOf, evidence, rejections};
};
