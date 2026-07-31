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
 * The unit of identity, restated: the DEFECT, not the anchor. Tier 2 needs no
 * line agreement at all, which is what finally makes the
 * same-defect-different-anchor shape mergeable (one missing-test defect drew
 * comments at three anchors in run 29943085279; tier 1 can only reach the
 * pairs that also clear its looser text floor). The line survives as evidence
 * inside tier 1 and as the survivor's posting anchor, and nothing more.
 *
 * The survivor is the highest-severity copy, its discussion gains an "also
 * flagged by" note (naming each other source's anchor when it differs, and
 * quoting the subject of any copy tier 2 absorbed, whose ask the survivor's own
 * prose is not known to restate), and every merge is recorded for
 * dispatch-result.json with the tier that found it (per group and per absorbed
 * copy), so the merge rate is readable from the artifact rather than from what
 * survives on the PR.
 *
 * Determinism boundary: every merge RULE is code — pure text arithmetic, no
 * filesystem. The one model input is tier 2's identity assertion, and it
 * enters through {@link verifiableClusters}, which trusts none of it: the ids
 * must exist, the paths and sources must satisfy the same constraints tier 1
 * enforces, the model's own grounding evidence must appear in every member's
 * text, and only a NON-BLOCKING copy may be absorbed on a model's word
 * ({@link clusterMemberRejection} carries the reasoning). What a tier-2 error
 * can cost is bounded by code even where its judgment cannot be checked.
 */

import {isRecord, type Claim, type ProposedCluster} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";
// The identity of the review bot, shared with the producer that stages the
// threads this module filters (stage-pr.ts). `threads.ts` owns a GitHub fetch
// but runs nothing at import time and reaches the network only through an
// injected port, so the determinism boundary above still holds here.
import {isReviewBotAuthor} from "./threads";

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
    }[];
    path: string;
    line: number;
    via: MergeVia;
    /** The clusterer's grounding evidence, when tier 2 found this group. */
    evidence?: string;
};

/**
 * One member a proposed cluster named that did NOT merge, with the rule that
 * rejected it. Recorded per run because an empty rejection list and an empty
 * proposal list mean opposite things, and the module has already been burned
 * by that ambiguity once (see {@link stagedThreadShapeFailure}): a clusterer
 * naming ids that do not exist is a prompt or staging failure, and it must not
 * read as "no duplicates found".
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
 * Similarity floors, in two tiers. An identical `(path, line)` from two
 * sources is itself evidence of one defect, so that tier's token floors sit
 * just under the weakest real duplicate (run 30301235749's terse correctness
 * one-liner against the discursive holistic copy: 0.149 Jaccard, 0.346
 * overlap) and the shared-bigram floor carries the precision alone. A
 * DIFFERENT line is weak evidence of two defects, so that tier pays for the
 * looser anchor with a higher bigram floor: run 30301235749 merged the
 * skill-auditor's AddDate handoff at expiration.go:38 into the test-adequacy
 * missing-test todo at :62 on five shared bigrams, and both real
 * different-line duplicates (run 29943085279's expiration_test.go :15/:58
 * pair, and the bundled test-adequacy bridge) share six or more.
 *
 * Every floor is a minimum over real trial claims, so the margins are thin
 * by construction: the exact-anchor tier separates on bigrams 4 vs 3, the
 * other-line tier on 6 vs 5. Re-derive them from `dedup.test.ts`'s fixtures
 * rather than nudging them by feel.
 */
const EXACT_ANCHOR_FLOOR = {jaccard: 0.14, overlap: 0.34, sharedBigrams: 4};
const OTHER_LINE_FLOOR = {jaccard: 0.2, overlap: 0.35, sharedBigrams: 6};

const STOPWORDS = new Set(
    "the a an and or of to in is are was be for on with that this it as not no by at from so its their they".split(
        " ",
    ),
);

const contentTokens = (text: string): string[] => {
    const tokens: string[] = [];
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (word.length >= 3 && !STOPWORDS.has(word)) {
            tokens.push(word);
        }
    }
    return tokens;
};

const bigrams = (tokens: string[]): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i += 1) {
        set.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return set;
};

const intersectionSize = <T>(a: Set<T>, b: Set<T>): number => {
    let count = 0;
    for (const item of a) {
        if (b.has(item)) {
            count += 1;
        }
    }
    return count;
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

/* -------------------------------------------------------------------------- */
/* Tier 2: model-proposed defect clusters, code-verified                      */
/* -------------------------------------------------------------------------- */

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

/** The code-naming tokens in a text, lowercased for comparison. */
const salientTokens = (text: string): Set<string> => {
    const tokens = new Set<string>();
    for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? []) {
        if (isSalientToken(raw)) {
            tokens.add(raw.toLowerCase());
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
 * The per-member rules a model-proposed merge must satisfy, checked against
 * the group's ACTUAL survivor (which union with tier 1 can change after the
 * proposal was made, so re-checking here rather than at parse time is what
 * keeps the guarantee honest):
 *
 * - **same path**, as in tier 1. Cross-file merging stays out of both tiers;
 *   its own calibration is a separate question and a missed merge is cheap.
 * - **different source**, as in tier 1: a reviewer does not duplicate itself,
 *   and collapsing two of one reviewer's findings would silently drop one.
 * - **grounded**: the cluster's evidence must name at least one code element
 *   ({@link isSalientToken}) and the member must mention one of them. This is
 *   the hallucination tripwire — a group whose members share no named code
 *   with the identity the model asserted is not an identity claim this module
 *   can check, so it does not merge.
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
 * Deliberately absent: any line requirement, and any text-similarity floor.
 * Both are what tier 2 exists to get past.
 */
const clusterMemberRejection = (
    survivor: Claim,
    member: Claim,
    evidenceTokens: ReadonlySet<string>,
): ClusterRejection["reason"] | undefined => {
    if (member.path !== survivor.path) {
        return "other-path";
    }
    if (member.source === survivor.source) {
        return "same-source";
    }
    if (isBlockingLabel(member.label)) {
        return "blocking-member";
    }
    return sharesSalientToken(evidenceTokens, member)
        ? undefined
        : "ungrounded";
};

/**
 * Resolve the clusterer's proposals against the claim set: map ids to claims,
 * hold each claim to at most one cluster (first proposal wins, in the model's
 * own output order, so the result is deterministic), and drop what cannot
 * anchor a comment. Every drop is recorded.
 *
 * A cluster is kept here only as a MEMBERSHIP hint; the merge rules that
 * decide what actually collapses run later against the group's survivor
 * ({@link clusterMemberRejection}).
 */
const verifiableClusters = (
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
        const members: number[] = [];
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
            members.push(index);
        }
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
/* -------------------------------------------------------------------------- */
/* Open-thread suppression (trial suggestion g)                               */
/* -------------------------------------------------------------------------- */

/** One still-open bot thread a candidate claim may duplicate. */
export type OpenThread = {
    thread_id: string;
    path?: string;
    /** The thread's opening comment body (the bot's original finding). */
    body: string;
};

export type ThreadSuppression = {
    id: string;
    source: string;
    label: string;
    path: string;
    line?: number;
    thread_id: string;
    /**
     * Whether the matched thread's OPENING comment carries a blocking label.
     * The verdict floor keys on this, not on the candidate's own label: the
     * thread's severity survived last run's validation, while a suppressed
     * candidate is dropped before validation ever sees it. Read off the
     * BEST-matching thread ({@link bestOpenThreadMatch}), since among several
     * threads that clear the floor their labels can differ.
     */
    threadBlocking: boolean;
};

/**
 * Whether an open thread's opener is a blocking finding, read from the
 * leading `**label:**` template (tolerating the markdown-stripped form the
 * staged bodies sometimes carry) and classified by {@link isBlockingLabel},
 * the single owner of that rule, so a label the taxonomy blocks on cannot be
 * missed here (`issue (blocking, best-practice)` is a blocking label too, and
 * a hand-rolled `\(blocking\)` match silently reads it as advisory). Spacing
 * inside the parentheses is normalized before the lookup; a body with no
 * recognizable label reads as non-blocking, since an unvalidated floor is the
 * failure mode this guards.
 */
const threadOpenerIsBlocking = (body: string): boolean => {
    const label = /^\s*\*{0,2}([a-z]+ \([^)]*\))\*{0,2}:?/i.exec(body)?.[1];
    return (
        label !== undefined &&
        isBlockingLabel(
            label
                .toLowerCase()
                .replace(/\s+/g, " ")
                .replace(/\s*,\s*/g, ", "),
        )
    );
};

/**
 * The prose of a previously-posted bot comment, for similarity comparison:
 * the leading `**label:**` template (tolerating the markdown-stripped form
 * the staged bodies sometimes carry) and everything from the first code
 * fence on (a suggestion block) are dropped, as are rule-quote lines:
 * boilerplate shared by ALL bot comments would inflate similarity between
 * unrelated findings.
 */
const threadProse = (body: string): string =>
    body
        .split("```")[0]
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join(" ")
        .replace(/^\s*\*{0,2}[a-z]+ \([^)]*\)\*{0,2}:?\*{0,2}\s*/i, "");

/**
 * Whether a staged thread carries a "still open" state. `stage-pr.ts` writes
 * `resolved: false` on every thread it stages; the `get_review_comments`
 * spelling (`is_resolved`) and the camelCase form are still accepted, because
 * a staging assembled from that tool's output (the eval's producers, and any
 * hand-built staging used to reproduce a run) inherits its shape. Absent
 * reads as unknown, not as open.
 */
const stagedResolvedState = (thread: Record<string, unknown>): unknown =>
    thread["resolved"] ?? thread["is_resolved"] ?? thread["isResolved"];

/**
 * Build the suppression inputs from staged threads.json. `stage-pr.ts` is the
 * producer (one GraphQL fetch, partitioned by opener), and it selects the
 * bot's threads through the SAME {@link isReviewBotAuthor} predicate this
 * filter admits them by, which is the point of the shared constant: the two
 * layers spelling the identity separately is precisely how suppression became
 * unreachable for a release (Khan/actions#302). The guards below nonetheless
 * stay, because they are the properties suppression depends on and a producer
 * bug must degrade to a duplicate comment rather than to a dropped finding:
 * - the opener is the bot's, in either spelling. A human thread must never
 *   silently kill a candidate, and its free-text opener would also read as
 *   non-blocking and skip the verdict floor.
 * - the thread is still open, per the staged `resolved` flag. An
 *   already-resolved thread would otherwise suppress a genuine regression
 *   re-flag with nothing to check it against.
 * Threads in resolvedIds (reconciler-resolved this run) are exempt as well: a
 * fixed defect posting again is a fresh finding. Fails closed on each: a
 * thread without a bot-authored opener, or without an explicit
 * `resolved: false`, never suppresses (worst case is a duplicate comment).
 *
 * `path` is read from the thread and falls back to the opening comment: the
 * code producer carries `path` per thread, while `get_review_comments` carries
 * it per comment, so a staging built from that tool inherits the other shape.
 * The fallback is not cosmetic: {@link suppressOpenThreadDuplicates} matches
 * on `path`, so a thread staged without one silently suppresses nothing.
 */
export const openThreadsFromStaged = (
    threads: unknown,
    resolvedIds: ReadonlySet<string>,
): OpenThread[] =>
    (Array.isArray(threads) ? threads : [])
        .filter(isRecord)
        .flatMap((thread) => {
            const comments = thread["comments"];
            const opener =
                Array.isArray(comments) && isRecord(comments[0])
                    ? comments[0]
                    : undefined;
            const author = opener?.["author"];
            if (
                typeof thread["thread_id"] !== "string" ||
                resolvedIds.has(thread["thread_id"]) ||
                stagedResolvedState(thread) !== false ||
                typeof author !== "string" ||
                !isReviewBotAuthor(author)
            ) {
                return [];
            }
            const path =
                typeof thread["path"] === "string"
                    ? thread["path"]
                    : typeof opener?.["path"] === "string"
                    ? (opener["path"] as string)
                    : undefined;
            return [
                {
                    thread_id: thread["thread_id"],
                    ...(path !== undefined ? {path} : {}),
                    body:
                        typeof opener["body"] === "string"
                            ? opener["body"]
                            : "",
                },
            ];
        });

/** How strongly a claim's text matches one open thread's opener. */
type OpenThreadScore = {
    jaccard: number;
    overlap: number;
    sharedBigrams: number;
};

const openThreadScore = (claim: Claim, thread: OpenThread): OpenThreadScore => {
    const tokensA = contentTokens(
        `${claim.subject} ${claim.discussion} ${claim.failure_scenario}`,
    );
    const tokensB = contentTokens(threadProse(thread.body));
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    if (setA.size === 0 || setB.size === 0) {
        return {jaccard: 0, overlap: 0, sharedBigrams: 0};
    }
    const shared = intersectionSize(setA, setB);
    return {
        jaccard: shared / (setA.size + setB.size - shared),
        overlap: shared / Math.min(setA.size, setB.size),
        sharedBigrams: intersectionSize(bigrams(tokensA), bigrams(tokensB)),
    };
};

/** Whether a claim clearly describes the defect an open thread tracks. */
export const describesOpenThreadDefect = (
    claim: Claim,
    thread: OpenThread,
): boolean => {
    const {jaccard, overlap, sharedBigrams} = openThreadScore(claim, thread);
    // The different-line tier: this match has no line window at all (see
    // `suppressOpenThreadDuplicates`), so it pays for the loose anchor with
    // the higher bigram floor, exactly as a cross-source pair on mismatched
    // lines does. Erring strict is the safe direction: a missed suppression
    // posts a duplicate comment, a false one silently drops a finding.
    return (
        jaccard >= OTHER_LINE_FLOOR.jaccard &&
        overlap >= OTHER_LINE_FLOOR.overlap &&
        sharedBigrams >= OTHER_LINE_FLOOR.sharedBigrams
    );
};

/**
 * The open thread a candidate BEST matches, not merely the first one it clears
 * the floor against.
 *
 * More than one open thread can describe the same area of a file, and taking
 * the first match in staging order reads `threadBlocking` off a thread that is
 * not the candidate's counterpart. Measured on webapp#41204 run 30650642317,
 * the first live run where suppression fired: the fresh test-adequacy todo
 * ("no test covers Record's documented zero-valued-Window guarantee") cleared
 * the floor against BOTH the blocking nil-map panic thread and its own exact
 * counterpart, a non-blocking nitpick whose opener reads "The documented
 * zero-value-Window guarantee has no test". Staging order put the blocking
 * thread first because it was the older one, so the suppression recorded
 * `threadBlocking: true` and added a second entry to submission.ts's verdict
 * floor. That run's verdict was already floored correctly by another
 * suppression, so nothing was mis-decided, but the direction is the dangerous
 * one: attributing a candidate to a blocking thread that is not its match
 * forces REQUEST_CHANGES on thinner evidence than the both-sides-blocking rule
 * intends.
 *
 * Ranked on `jaccard` first because it is the length-normalized metric: raw
 * `sharedBigrams` grows with the opener's length, and `overlap` divides by the
 * smaller token set, which favors the longer, more discursive thread. On the
 * observed pair both jaccard (0.253 vs 0.218) and bigrams (13 vs 12) pick the
 * true counterpart while overlap alone (0.468 vs 0.511) picks the wrong one,
 * so bigrams break jaccard ties and overlap never ranks. Strictly-better
 * comparisons keep staging order as the final tiebreak, so an exact scoring
 * tie behaves as it did before.
 */
const bestOpenThreadMatch = (
    claim: Claim,
    threads: readonly OpenThread[],
): OpenThread | undefined => {
    let best: {thread: OpenThread; score: OpenThreadScore} | undefined;
    for (const thread of threads) {
        if (
            thread.path !== claim.path ||
            !describesOpenThreadDefect(claim, thread)
        ) {
            continue;
        }
        const score = openThreadScore(claim, thread);
        const better =
            best === undefined ||
            score.jaccard > best.score.jaccard ||
            (score.jaccard === best.score.jaccard &&
                score.sharedBigrams > best.score.sharedBigrams);
        if (better) {
            best = {thread, score};
        }
    }
    return best?.thread;
};

/**
 * Whether staged threads ALL failed {@link openThreadsFromStaged}'s filter, so
 * suppression could not run at all. Lives here beside the filter because it is
 * the filter's own failure mode; the caller only logs what this returns.
 *
 * An empty {@link ThreadSuppression} list cannot distinguish "nothing to
 * suppress" from "suppression silently did nothing", and that ambiguity is how
 * the author-spelling mismatch above reached production: it survived a whole
 * three-round seeded lifecycle (webapp#41197) posting duplicate comments while
 * every run reported an empty suppression list and looked correct.
 *
 * Kept after the producer became code, not deleted. A conforming `stage-pr.ts`
 * run can no longer trip it (it stages only bot-opened, unresolved threads,
 * selected by this filter's own predicate, and a mass reconciler-resolve is
 * excluded per id below), which is the point: a fire now means either that the
 * producer and this consumer have drifted apart inside one repo (a code bug,
 * still the exact failure class #302 was), or that the staging came from
 * somewhere else (the eval's live producer, a hand-built reproduction).
 * A tripwire that cannot fire on today's code costs one comparison and is the
 * only thing standing between the next shape drift and another silent release.
 *
 * Threads the reconciler resolved this run are excluded, since those are
 * legitimately unusable — counted per thread against `resolvedIds` rather than
 * by list length, because the reconciler's `resolve` list is never validated
 * against the staged `thread_id`s: a long resolve list would otherwise mask a
 * total shape failure in a short staging, silencing this very warning.
 *
 * Deliberate limit: ONE usable thread returns undefined, so partial shape
 * drift (some threads malformed, others fine) stays invisible. This is a
 * total-failure tripwire, not a per-thread audit; the per-thread version wants
 * a rejection reason on each dropped thread, which is more machinery than the
 * failure it would catch currently justifies.
 */
export const stagedThreadShapeFailure = (
    threads: unknown,
    openThreads: readonly OpenThread[],
    resolvedIds: ReadonlySet<string>,
): {unusableThreads: number; warning: string} | undefined => {
    if (openThreads.length > 0) {
        return undefined;
    }
    const unusableThreads = (Array.isArray(threads) ? threads : [])
        .filter(isRecord)
        .filter((thread) => {
            const id = thread["thread_id"];
            return typeof id !== "string" || !resolvedIds.has(id);
        }).length;
    if (unusableThreads === 0) {
        return undefined;
    }
    return {
        unusableThreads,
        warning: threadSuppressionUnavailableWarning(unusableThreads),
    };
};

/**
 * The tripwire's run-log line, built from the count alone.
 *
 * Shared with `dispatch-gate.ts`, which re-emits it from a real workflow step.
 * The dispatcher runs inside the agent's Bash tool, where a `::warning` is only
 * text: measured on webapp#41204 run 30654454047, a mis-staged run reported
 * `threadSuppressionUnavailable` on dispatch-result.json and printed this line
 * into the run log and the step summary, yet raised no annotation on any of the
 * six jobs, while the pre-agent staging step's own `::warning` in the same run
 * did annotate. The gate rebuilds the line from `unusableThreads` rather than
 * forwarding the stored string, so a `dispatch-result.json` an agent could
 * rewrite cannot inject workflow commands into a trusted step; that is also why
 * this takes a number rather than free text.
 */
export const threadSuppressionUnavailableWarning = (
    unusableThreads: number,
): string =>
    `::warning title=open-thread suppression::${unusableThreads} staged thread(s), none usable ` +
    `(each needs thread_id, an explicit resolved: false, and a bot-authored opener); duplicates may re-post`;

/**
 * Drop candidate claims that describe a defect an open bot thread already
 * tracks (trial run S4 r2: the missing-test defect re-flagged at
 * expiration.go:42 while its round-1 thread at :62 was still open, so the
 * same defect briefly had two open threads). The match is same-path plus the
 * calibrated #245 text-similarity floor, deliberately with NO line window:
 * a persisting defect's re-flag routinely lands on a different line
 * of the same file (the observed pair sat 20 lines apart); the similarity
 * floor carries the precision. The caller excludes threads the reconciler
 * resolves this run, so a fixed defect's fresh regression still posts, and
 * each suppression records both the candidate's label and the matched
 * thread's blocking-ness so the verdict cannot flip to APPROVE over a
 * still-open, re-confirmed blocking objection (submission.ts floors only
 * when BOTH are blocking: the thread's severity is the validated one, and
 * the candidate's re-confirmation at blocking severity is what makes the
 * floor more than a stale thread). Which thread a candidate is attributed to
 * is {@link bestOpenThreadMatch}'s call, not staging order's, because
 * `threadBlocking` is read off it.
 */
export const suppressOpenThreadDuplicates = (
    claims: Claim[],
    threads: OpenThread[],
): {kept: Claim[]; suppressed: ThreadSuppression[]} => {
    if (threads.length === 0) {
        return {kept: claims, suppressed: []};
    }
    const kept: Claim[] = [];
    const suppressed: ThreadSuppression[] = [];
    for (const claim of claims) {
        const match =
            claim.path === undefined
                ? undefined
                : bestOpenThreadMatch(claim, threads);
        if (match === undefined) {
            kept.push(claim);
            continue;
        }
        suppressed.push({
            id: claim.id,
            source: claim.source,
            label: claim.label,
            path: claim.path as string,
            ...(claim.line !== undefined ? {line: claim.line} : {}),
            thread_id: match.thread_id,
            threadBlocking: threadOpenerIsBlocking(match.body),
        });
    }
    return {kept, suppressed};
};

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
 * plus, when the clusterer ran, the defect clusters it proposed (verified
 * here, never trusted). Non-anchored claims and everything neither tier
 * identifies pass through untouched; when in doubt, don't merge (a false merge
 * silently drops a reviewer's distinct finding, a missed merge only costs a
 * duplicate comment).
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

    // Union-find over pairwise-mergeable claims, then over each proposed
    // cluster's members. Union is membership only: what actually collapses is
    // decided per member against the group's survivor, below.
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
    const clusterAnchor = new Map<number, number>();
    for (const [index, ordinal] of clusterOf) {
        const anchor = clusterAnchor.get(ordinal);
        if (anchor === undefined) {
            clusterAnchor.set(ordinal, index);
        } else {
            parent[find(index)] = find(anchor);
        }
    }
    const groups = new Map<number, number[]>();
    claims.forEach((_, index) => {
        const root = find(index);
        groups.set(root, [...(groups.get(root) ?? []), index]);
    });

    const drop = new Set<number>();
    const replacement = new Map<number, Claim>();
    const merges: ClaimMerge[] = [];
    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }
        const survivorIndex = group.reduce((best, index) =>
            survivorFirst(best, index, claims),
        );
        const survivor = claims[survivorIndex];
        // The group's cluster evidence (lowest ordinal present, so the choice
        // is deterministic when tier 1 has bridged two clusters). Tokenized
        // once: an evidence string naming no code element grounds nothing, and
        // that check is what makes an unverifiable identity claim inert rather
        // than authoritative.
        const ordinals = group
            .map((index) => clusterOf.get(index))
            .filter((ordinal): ordinal is number => ordinal !== undefined);
        const groupEvidence =
            ordinals.length === 0 ? undefined : evidence[Math.min(...ordinals)];
        const evidenceTokens =
            groupEvidence === undefined
                ? undefined
                : salientTokens(groupEvidence);
        const clusterUsable =
            evidenceTokens !== undefined &&
            evidenceTokens.size > 0 &&
            sharesSalientToken(evidenceTokens, survivor);
        // Star guard: only a member {@link mergeable} against the survivor
        // DIRECTLY merges on tier 1. Union-find alone chains A~B~C through a
        // bridging claim that bundles two defects (a test-adequacy finding
        // naming both a missing test and an unbounded read links the two
        // distinct correctness findings), and collapsing the chain would
        // silently drop a distinct finding; with no line window bounding
        // groups, a bridge can span a whole file. Chain-only members stay
        // their own claims. Both recorded trial merges are unaffected: run
        // 29897276810's four-way group is pairwise-complete and run
        // 29943085279's is a direct pair.
        //
        // The full pairwise predicate, not the text floor alone: a group can
        // now contain a member tier 1 never proposed (a cluster unions on the
        // model's word, which {@link verifiableClusters} does not screen for
        // path or source), and a cross-path or same-source member whose prose
        // happens to clear the floor must not slip in through this branch and
        // be recorded as `via: "similarity"`. It falls through to the tier-2
        // rules below, which reject it by name.
        //
        // A cluster member takes the tier-2 path instead: it did not clear the
        // floor (that is why the clusterer exists), so it merges on the
        // verified rules alone. The evidence check runs against THIS survivor,
        // so a group tier 1 has since reshaped is re-verified, not grandfathered.
        const viaCluster = new Set<number>();
        const others = group.filter((index) => {
            if (index === survivorIndex) {
                return false;
            }
            if (mergeable(survivor, claims[index])) {
                return true;
            }
            if (clusterOf.get(index) === undefined) {
                return false;
            }
            if (!clusterUsable) {
                clusterRejections.push({
                    id: claims[index].id,
                    reason: "ungrounded",
                });
                return false;
            }
            const rejection = clusterMemberRejection(
                survivor,
                claims[index],
                evidenceTokens as ReadonlySet<string>,
            );
            if (rejection !== undefined) {
                clusterRejections.push({
                    id: claims[index].id,
                    reason: rejection,
                });
                return false;
            }
            viaCluster.add(index);
            return true;
        });
        if (others.length === 0) {
            continue;
        }
        for (const index of others) {
            drop.add(index);
        }
        const otherClaims = others.map((index) => claims[index]);
        // One entry per other source, first copy wins, naming that copy's
        // anchor when it is not the survivor's. With tier 2 merging across
        // anchors, "also flagged by test-adequacy" alone would hide that the
        // second reviewer was looking at a different line, which is exactly
        // the context an author needs to judge a same-defect-different-anchor
        // merge (and to spot a wrong one).
        //
        // A tier-2 copy also carries its own SUBJECT, and only a tier-2 copy
        // does. What the note must not lose is an ask the survivor's prose
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
        const sources: {source: string; line?: number; subject?: string}[] = [];
        for (const index of others) {
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
                ...(viaCluster.has(index)
                    ? {subject: claim.subject.replace(/\s+/g, " ").trim()}
                    : {}),
            });
        }
        const flaggedBy = (entry: {source: string; line?: number}): string =>
            entry.line === undefined
                ? entry.source
                : `${entry.source} (at line ${entry.line})`;
        const alsoFlagged =
            sources.length === 0
                ? ""
                : sources.every((entry) => entry.subject === undefined)
                ? `\n\nAlso flagged by ${sources.map(flaggedBy).join(", ")}.`
                : `\n\nAlso flagged by:\n${sources
                      .map(
                          (entry) =>
                              `- ${flaggedBy(entry)}${
                                  entry.subject === undefined
                                      ? ""
                                      : `: ${entry.subject}`
                              }`,
                      )
                      .join("\n")}`;
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
            discussion: `${survivor.discussion}${alsoFlagged}`,
            ...(adoptedSuggestion !== undefined
                ? {suggestion: adoptedSuggestion}
                : {}),
            ...(adoptedDispute !== undefined
                ? {author_dispute: adoptedDispute}
                : {}),
        });
        const clusterCount = others.filter((index) =>
            viaCluster.has(index),
        ).length;
        const via: MergeVia =
            clusterCount === 0
                ? "similarity"
                : clusterCount === others.length
                ? "clusterer"
                : "both";
        merges.push({
            survivor: survivor.id,
            merged: others.map((index) => {
                const claim = claims[index];
                return {
                    id: claim.id,
                    source: claim.source,
                    label: claim.label,
                    ...(claim.line !== undefined && claim.line !== survivor.line
                        ? {line: claim.line}
                        : {}),
                    ...(viaCluster.has(index)
                        ? {via: "clusterer" as const}
                        : {}),
                };
            }),
            path: survivor.path as string,
            line: survivor.line as number,
            via,
            ...(via === "similarity" || groupEvidence === undefined
                ? {}
                : {evidence: groupEvidence}),
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
