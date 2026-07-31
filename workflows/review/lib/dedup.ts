/**
 * Cross-source duplicate-claim merge (the #245 ledger item), applied to the
 * built claims BEFORE the claim-validator dispatch: trial run 29897276810
 * posted the same AddDate months-vs-days defect four times (correctness,
 * completeness, first-principles, and a skill-auditor out-of-lane handoff),
 * and every copy was separately validated — validation is the single largest
 * sub-agent cost line, so duplicates are merged before it, not after.
 *
 * The merge is deliberately conservative: only claims from DIFFERENT sources,
 * anchored on the same path, whose text clearly describes the same defect
 * (token-set similarity plus a shared-phrase floor, calibrated on the real
 * claim sets of runs 29897276810, 29943085279 and 30301235749). Still no
 * line window: run 29943085279's missing-deletion-test defect posted twice
 * with anchors 43 lines apart in expiration_test.go (:15 and :58), so
 * proximity can never be required. An IDENTICAL anchor is used the other
 * way round, as evidence: two sources landing on the same `(path, line)`
 * clear a lower text floor than two sources landing on different lines.
 * The survivor is the highest-severity copy, its discussion gains an "also
 * flagged by" note, and every merge is recorded for dispatch-result.json.
 *
 * Determinism boundary: pure text arithmetic; no model call, no filesystem.
 */

import {isRecord, type Claim} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";
// The identity of the review bot, shared with the producer that stages the
// threads this module filters (stage-pr.ts). `threads.ts` owns a GitHub fetch
// but runs nothing at import time and reaches the network only through an
// injected port, so the determinism boundary above still holds here.
import {isReviewBotAuthor} from "./threads";

export type ClaimMerge = {
    survivor: string;
    merged: {id: string; source: string; label: string}[];
    path: string;
    line: number;
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
     * candidate is dropped before validation ever sees it.
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

/** Whether a claim clearly describes the defect an open thread tracks. */
export const describesOpenThreadDefect = (
    claim: Claim,
    thread: OpenThread,
): boolean => {
    const tokensA = contentTokens(
        `${claim.subject} ${claim.discussion} ${claim.failure_scenario}`,
    );
    const tokensB = contentTokens(threadProse(thread.body));
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    if (setA.size === 0 || setB.size === 0) {
        return false;
    }
    const shared = intersectionSize(setA, setB);
    const jaccard = shared / (setA.size + setB.size - shared);
    const overlap = shared / Math.min(setA.size, setB.size);
    const sharedBigrams = intersectionSize(bigrams(tokensA), bigrams(tokensB));
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
        warning:
            `::warning title=open-thread suppression::${unusableThreads} staged thread(s), none usable ` +
            `(each needs thread_id, an explicit resolved: false, and a bot-authored opener); duplicates may re-post`,
    };
};

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
 * floor more than a stale thread).
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
                : threads.find(
                      (thread) =>
                          thread.path === claim.path &&
                          describesOpenThreadDefect(claim, thread),
                  );
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
 * Merge high-confidence cross-source duplicates, preserving claim order.
 * Non-anchored claims and everything below the similarity floor pass through
 * untouched; when in doubt, don't merge (a false merge silently drops a
 * reviewer's distinct finding, a missed merge only costs a duplicate
 * comment).
 */
export const dedupeClaims = (
    claims: Claim[],
): {claims: Claim[]; merges: ClaimMerge[]} => {
    // Union-find over pairwise-mergeable claims.
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
        // Star guard: only a member that clears the floor against the
        // survivor DIRECTLY merges. Union-find alone chains A~B~C through a
        // bridging claim that bundles two defects (a test-adequacy finding
        // naming both a missing test and an unbounded read links the two
        // distinct correctness findings), and collapsing the chain would
        // silently drop a distinct finding; with no line window bounding
        // groups, a bridge can span a whole file. Chain-only members stay
        // their own claims. Both recorded trial merges are unaffected: run
        // 29897276810's four-way group is pairwise-complete and run
        // 29943085279's is a direct pair.
        const others = group.filter(
            (index) =>
                index !== survivorIndex &&
                describesSameDefect(survivor, claims[index]),
        );
        if (others.length === 0) {
            continue;
        }
        for (const index of others) {
            drop.add(index);
        }
        const otherClaims = others.map((index) => claims[index]);
        const sources = [
            ...new Set(otherClaims.map((claim) => claim.source)),
        ].filter((source) => source !== survivor.source);
        const alsoFlagged =
            sources.length === 0
                ? ""
                : `\n\nAlso flagged by ${sources.join(", ")}.`;
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
        merges.push({
            survivor: survivor.id,
            merged: otherClaims.map((claim) => ({
                id: claim.id,
                source: claim.source,
                label: claim.label,
            })),
            path: survivor.path as string,
            line: survivor.line as number,
        });
    }
    return {
        claims: claims
            .map((claim, index) => replacement.get(index) ?? claim)
            .filter((_, index) => !drop.has(index)),
        merges,
    };
};
