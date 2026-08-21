/**
 * Open-thread suppression (trial suggestion g): drop candidate claims that
 * describe a defect a still-open bot thread already tracks, so a re-review
 * cannot re-post a finding whose thread the humans have not resolved yet.
 * Split from `dedup.ts` for its max-lines budget (the dedup-text.ts
 * precedent); dedup.ts owns the cross-source MERGE tiers, this module owns
 * the thread-versus-candidate comparison, and the two share only the
 * text-similarity primitives and calibrated floors in dedup-text.ts.
 *
 * `suppressOpenThreadDuplicates` is the entry point; dedup-adjudicated.ts
 * reuses the matcher against the ADJUDICATED corpus (bot threads a human
 * resolved) and carries the justification for that pass's differences.
 */

import {stripFooters} from "./attribution";
import {
    bigrams,
    contentTokens,
    intersectionSize,
    OTHER_LINE_FLOOR,
    PR_LEVEL_FLOOR,
} from "./dedup-text";
import {isRecord, type Claim} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";
// The identity of the review bot, shared with the producer that stages the
// threads this module filters (stage-pr.ts). `threads.ts` owns a GitHub fetch
// but runs nothing at import time and reaches the network only through an
// injected port, so dedup.ts's determinism boundary still holds here.
import {isReviewBotAuthor} from "./threads";

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
    path?: string; // absent for a pr-level claim (no anchor)
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
    /**
     * Present (and true) when the matched thread is from the ADJUDICATED
     * corpus (a bot thread a human resolved) rather than an open one; see
     * dedup-adjudicated.ts. Audit-trail only: an adjudicated suppression can
     * never floor the verdict, because that pass never suppresses a blocking
     * candidate and submission.ts's floor requires the CANDIDATE's label to
     * be blocking too.
     */
    adjudicated?: true;
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
export const threadOpenerIsBlocking = (body: string): boolean => {
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
 * the collapsed attribution/version footers (attribution.ts's strip), the
 * leading `**label:**` template (tolerating the markdown-stripped form
 * the staged bodies sometimes carry) and everything from the first code
 * fence on (a suggestion block) are dropped, as are rule-quote lines:
 * boilerplate shared by ALL bot comments would inflate similarity between
 * unrelated findings.
 */
const threadProse = (body: string): string =>
    stripFooters(body)
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
export const stagedResolvedState = (thread: Record<string, unknown>): unknown =>
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
    // This match has no line window at all (see
    // `suppressOpenThreadDuplicates`), so it pays for the loose anchor with
    // the higher bigram floor, exactly as a cross-source pair on mismatched
    // lines does; a pathless (pr-level) claim has no anchor evidence at all
    // and pays one tier more. Erring strict is the safe direction: a
    // missed suppression posts a duplicate, a false one drops a finding.
    const floor = claim.path === undefined ? PR_LEVEL_FLOOR : OTHER_LINE_FLOOR;
    return (
        jaccard >= floor.jaccard &&
        overlap >= floor.overlap &&
        sharedBigrams >= floor.sharedBigrams
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
 *
 * `ignorePath` drops the same-path key on the CLAIM side and keeps every
 * floor as is. The ONLY caller is the adjudicated pass
 * (dedup-adjudicated.ts, which carries the measured justification), and it
 * exempts pathless claims before calling, so under `ignorePath` every claim
 * that reaches here is pathed and pays {@link OTHER_LINE_FLOOR}; the
 * {@link PR_LEVEL_FLOOR} branch is live only for the path-keyed callers.
 * Keeping OTHER_LINE_FLOOR for the cross-file comparisons is itself
 * measured, not reused by analogy: on the frozen webapp#41290 family corpus
 * every cross-file pair that clears this floor is a true family match, the
 * strongest cross-file NEGATIVE scores jaccard 0.168 against the 0.2 floor
 * (its bigram counts reach 13, so jaccard is the guard that holds), and the
 * weakest true cross-file match sits at exactly 7 shared bigrams, so the
 * pr-level tier's floor of 8 would trade a measured true variant for no
 * measured precision. Re-derive from that corpus before touching either
 * number. The THREAD side keeps a key even here: a corpus member with no
 * usable path never matches, because under the path key such a thread could
 * never reach a pathed claim (the fail-closed degradation
 * {@link openThreadsFromStaged} documents), and dropping the claim-side key
 * must not flip that thread into a wildcard suppressor. The open corpus
 * stays path-keyed: its members carry no human judgment, so a false
 * cross-file match there would hide an undecided finding on nothing but the
 * bot's own earlier text.
 */
export const bestOpenThreadMatch = (
    claim: Claim,
    threads: readonly OpenThread[],
    options?: {ignorePath?: boolean},
): OpenThread | undefined => {
    let best: {thread: OpenThread; score: OpenThreadScore} | undefined;
    // A pathless (pr-level) claim compares against EVERY open thread.
    for (const thread of threads) {
        if (
            (options?.ignorePath !== true
                ? claim.path !== undefined && thread.path !== claim.path
                : // A thread with no usable path stays inert (see the doc
                  // above): fail-closed, never a PR-wide wildcard.
                  thread.path === undefined || thread.path === "") ||
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
 * same defect briefly had two open threads). The match is same-path plus
 * the calibrated #245 text-similarity floor (a pathless pr-level claim
 * skips the path gate and pays the stricter {@link PR_LEVEL_FLOOR}),
 * deliberately with NO line window:
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
        const match = bestOpenThreadMatch(claim, threads);
        if (match === undefined) {
            kept.push(claim);
            continue;
        }
        suppressed.push({
            id: claim.id,
            source: claim.source,
            label: claim.label,
            ...(claim.path !== undefined ? {path: claim.path} : {}),
            ...(claim.line !== undefined ? {line: claim.line} : {}),
            thread_id: match.thread_id,
            threadBlocking: threadOpenerIsBlocking(match.body),
        });
    }
    return {kept, suppressed};
};
