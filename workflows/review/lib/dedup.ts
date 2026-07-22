/**
 * Cross-source duplicate-claim merge (the #245 ledger item), applied to the
 * built claims BEFORE the claim-validator dispatch: trial run 29897276810
 * posted the same AddDate months-vs-days defect four times (correctness,
 * completeness, first-principles, and a skill-auditor out-of-lane handoff),
 * and every copy was separately validated — validation is the single largest
 * sub-agent cost line, so duplicates are merged before it, not after.
 *
 * The merge is deliberately conservative: only claims from DIFFERENT sources,
 * anchored on the same path, whose subject and failure scenario clearly
 * describe the same defect (token-set similarity plus a shared-phrase floor,
 * thresholds calibrated on that run's real outputs, where same-defect pairs
 * scored >= 0.20 Jaccard and different-defect pairs on the same lines scored
 * <= 0.05). No line window: run 29943085279's missing-deletion-test defect
 * posted four times with anchors 43 lines apart in expiration_test.go (:15
 * and :58), so the similarity floor carries the precision alone. The
 * survivor is the highest-severity copy, its discussion gains an "also
 * flagged by" note, and every merge is recorded for dispatch-result.json.
 *
 * Determinism boundary: pure text arithmetic; no model call, no filesystem.
 */

import {isRecord, type Claim} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";

export type ClaimMerge = {
    survivor: string;
    merged: {id: string; source: string; label: string}[];
    path: string;
    line: number;
};

/**
 * Similarity floor, calibrated on run 29897276810's thirteen findings:
 * every cross-source same-defect pair cleared all three; every
 * different-defect pair on the same lines missed all three by a wide margin.
 */
const MIN_JACCARD = 0.2;
const MIN_OVERLAP = 0.35;
const MIN_SHARED_BIGRAMS = 4;

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

/** Whether two claims clearly describe the same defect (text similarity). */
export const describesSameDefect = (a: Claim, b: Claim): boolean => {
    const tokensA = contentTokens(`${a.subject} ${a.failure_scenario}`);
    const tokensB = contentTokens(`${b.subject} ${b.failure_scenario}`);
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    if (setA.size === 0 || setB.size === 0) {
        return false;
    }
    const shared = intersectionSize(setA, setB);
    const jaccard = shared / (setA.size + setB.size - shared);
    const overlap = shared / Math.min(setA.size, setB.size);
    const sharedBigrams = intersectionSize(bigrams(tokensA), bigrams(tokensB));
    return (
        jaccard >= MIN_JACCARD &&
        overlap >= MIN_OVERLAP &&
        sharedBigrams >= MIN_SHARED_BIGRAMS
    );
};

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
 * staged bodies sometimes carry). A body with no recognizable label reads
 * as non-blocking: an unvalidated floor is the failure mode this guards.
 */
const threadOpenerIsBlocking = (body: string): boolean =>
    /^\s*\*{0,2}[a-z]+ \(blocking\)/i.test(body);

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
 * Build the suppression inputs from staged threads.json. The staging is
 * prompt-executed (review.md asks the orchestrator for the unresolved
 * github-actions[bot] threads; stage-pr.ts deliberately does not stage
 * threads yet), so the bot-only property is enforced HERE in code: only a
 * thread whose OPENING comment the bot authored may suppress. A mis-staged
 * human thread must never silently kill a candidate, and its free-text
 * opener would also read as non-blocking and skip the verdict floor.
 * Threads in resolvedIds (reconciler-resolved this run) are exempt: a fixed
 * defect posting again is a fresh finding. Fails closed: a thread without a
 * bot-authored opener never suppresses (worst case is a duplicate comment).
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
            if (
                typeof thread["thread_id"] !== "string" ||
                resolvedIds.has(thread["thread_id"]) ||
                opener?.["author"] !== "github-actions[bot]"
            ) {
                return [];
            }
            return [
                {
                    thread_id: thread["thread_id"],
                    ...(typeof thread["path"] === "string"
                        ? {path: thread["path"]}
                        : {}),
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
    return (
        jaccard >= MIN_JACCARD &&
        overlap >= MIN_OVERLAP &&
        sharedBigrams >= MIN_SHARED_BIGRAMS
    );
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

/**
 * Same path, any line distance: run 29943085279 posted the
 * missing-deletion-test defect at expiration_test.go:15 and :58 (43 lines
 * apart), and the old two-line window kept all four copies separate; the
 * similarity floor carries the precision alone. Cross-FILE merging stays
 * out: that same run flagged the defect in expiration.go too (:62, :38) and
 * a floor loose enough to catch a cross-file pair needs its own strictly
 * higher calibration; a missed merge only costs a duplicate comment.
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
