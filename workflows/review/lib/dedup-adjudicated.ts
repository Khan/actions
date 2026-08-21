/**
 * Adjudicated-thread suppression: the human-resolution memory the open-thread
 * corpus cannot carry. Split from `dedup.ts` for its max-lines budget
 * (following the precedent dedup-cluster.ts set) and because it is one
 * self-contained concern: what a HUMAN resolving a bot thread means for later
 * runs.
 *
 * Before this module, resolving a bot thread was quietly the opposite of
 * settling it. threads.json stages only UNRESOLVED threads, and the
 * open-thread suppression corpus is built from exactly that file, so a
 * resolution removed the defect from the suppression shield and the next run
 * was free to re-derive the same concern with fresh wording as a brand-new
 * thread, which every later accountability recap then enumerated as "still
 * unaddressed". Observed on webapp#41290: the author replied to and resolved
 * SIX variants of one concern at moderation_helpers.go:135 over two days, and
 * a seventh rephrasing posted anyway. From the author's side that is
 * indistinguishable from the bot ignoring every resolution.
 *
 * The corpus this module consumes is staged by stage-pr.ts (step 5b',
 * adjudicated-threads.json): bot-opened threads whose `resolvedBy` is a
 * human, plus bot-opened threads whose OPENING comment carries a 👎 (the
 * same judgment through the other feedback channel the bot advertises; the
 * thumbs sweep asks "why?" on exactly that signal, and until this module the
 * answer dead-ended in counters). The resolver identity is the resolution
 * membership rule, not resolution alone; a thread the BOT resolved is the
 * reconciler marking a defect FIXED, and a fixed defect that reappears is a
 * fresh finding that must post.
 */

import {
    bestOpenThreadMatch,
    openThreadsFromStaged,
    stagedResolvedState,
    stagedThreadShapeFailure,
    suppressOpenThreadDuplicates,
    threadOpenerIsBlocking,
    type OpenThread,
    type ThreadSuppression,
} from "./dedup-threads";
import {isRecord, type Claim} from "./dispatch-contracts";
import {isBlockingLabel} from "./render-comment";
import {isReviewBotAuthor} from "./threads";

/**
 * Build the adjudicated-corpus suppression inputs from staged
 * adjudicated-threads.json. Same {@link OpenThread} shape as the open corpus,
 * because the matcher ({@link bestOpenThreadMatch}) is shared.
 *
 * The guards mirror `openThreadsFromStaged`'s, with the resolution checks
 * INVERTED and strengthened: membership requires an explicit `resolved: true`
 * AND a non-empty human `resolvedBy`, OR an explicit positive
 * `openerDownvotes` count, because this corpus grants the strongest
 * suppression in the pipeline (a defect a human marked settled stays settled
 * across rephrasings) and must never be manufacturable from a malformed
 * staging. Each guard fails closed toward NOT suppressing: a thread without
 * a bot opener, without either signal, or whose resolver is absent,
 * unattributable (""), or the bot itself contributes nothing, and the worst
 * case is a duplicate comment.
 */
export const adjudicatedThreadsFromStaged = (threads: unknown): OpenThread[] =>
    (Array.isArray(threads) ? threads : [])
        .filter(isRecord)
        .flatMap((thread) => {
            const comments = thread["comments"];
            const opener =
                Array.isArray(comments) && isRecord(comments[0])
                    ? comments[0]
                    : undefined;
            const author = opener?.["author"];
            const resolvedBy = thread["resolvedBy"];
            const humanResolved =
                stagedResolvedState(thread) === true &&
                typeof resolvedBy === "string" &&
                resolvedBy !== "" &&
                !isReviewBotAuthor(resolvedBy);
            const downvotes = thread["openerDownvotes"];
            const downvoted = typeof downvotes === "number" && downvotes > 0;
            if (
                typeof thread["thread_id"] !== "string" ||
                (!humanResolved && !downvoted) ||
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

/**
 * Drop candidate claims that re-derive a defect a human already ADJUDICATED.
 *
 * Two deliberate asymmetries against `suppressOpenThreadDuplicates`:
 *
 * - A BLOCKING candidate is never suppressed here. The open corpus can
 *   suppress blockers because the matched thread is still open and floors the
 *   verdict in the candidate's stead; an adjudicated thread is closed and
 *   floors nothing, so suppressing a blocker on it would let a re-confirmed
 *   blocking defect vanish without a trace. This is also the regression
 *   escape hatch the old "resolved threads never suppress" rule protected: a
 *   fixed-then-regressed defect worth stopping the PR for re-presents at
 *   blocking severity and posts.
 * - There is no verdict-floor bookkeeping. The suppression record carries
 *   `adjudicated: true` and the matched thread's opener severity for the
 *   audit trail, but submission.ts's floor requires the CANDIDATE to be
 *   blocking, which no claim suppressed here is.
 *
 * The match is the shared matcher with the PATH KEY DROPPED (`ignorePath`;
 * same #245 similarity floors via {@link bestOpenThreadMatch}, whose doc
 * carries the cross-file floor calibration): an adjudicated defect's
 * rephrasing routinely re-anchors on another file (the spec instead of the
 * implementation, the test instead of the function), and the path key is
 * what let the webapp#41290 families re-post for two weeks. Measured on that
 * frozen corpus (Khan/plans,
 * pr-review-agent/records/family-corpus-41290.json: 12 adjudicated threads,
 * 33 labeled candidates): path-keyed scores 2/12 recall, key dropped scores
 * 6/12 with correct family attribution on every match, and BOTH make the
 * same single false suppression (folding two distinct same-path findings
 * whose wording shares the file's vocabulary), so the widening tripled
 * recall and added zero false suppressions there.
 *
 * What licenses the reach is the corpus's membership rule plus the blocking
 * exemption, not a claim that false matches are free: a false match drops a
 * non-blocking finding whose text sits within the floors of one a human
 * explicitly settled, and a defect that matters enough to block re-presents
 * at blocking severity and posts. The reach deliberately includes the
 * sibling-copy shape (webapp#41440: one source stamping near-identical text
 * across sibling files): with a settled thread on file A, file B's copy now
 * exits through the same thread instead of posting alone
 * (dedup-crossfile.ts documents the interaction with its merge ordering).
 * The human declined that exact ask once, and the path key never protected
 * the matching same-file case (a fresh same-file instance of a settled
 * defect was already suppressed), so this widens the reach of an accepted
 * risk rather than adding a new class. The OPEN corpus keeps its path key:
 * its members carry no human judgment, so a false cross-file match there
 * would hide an undecided finding on nothing but the bot's own earlier
 * text.
 */
export const suppressAdjudicatedDuplicates = (
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
            claim.path === undefined || isBlockingLabel(claim.label)
                ? undefined
                : bestOpenThreadMatch(claim, threads, {ignorePath: true});
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
            adjudicated: true,
        });
    }
    return {kept, suppressed};
};

/**
 * Both thread-suppression passes in dispatch order, as ONE call: the open
 * corpus first (its matches carry the verdict-floor bookkeeping), then the
 * adjudicated corpus over what survived. Extracted here rather than inlined
 * in dispatch.ts for that file's max-lines budget, and so the pass ORDER is a
 * property of this module rather than of the call site: a candidate matching
 * BOTH corpora must be attributed to the OPEN thread, whose blocking state
 * the verdict floor reads.
 *
 * Inputs are the raw staged values (threads.json, adjudicated-threads.json
 * parsed or undefined when absent); every shape guard lives in the two corpus
 * builders, so an older staging without the adjudicated file degrades to an
 * empty corpus and suppresses nothing. `shapeFailure` is the open corpus's
 * total-failure tripwire, surfaced unchanged (see `stagedThreadShapeFailure`).
 */
export const suppressTrackedDuplicates = (
    claims: Claim[],
    stagedOpen: unknown,
    stagedAdjudicated: unknown,
    resolvedIds: ReadonlySet<string>,
): {
    kept: Claim[];
    suppressed: ThreadSuppression[];
    shapeFailure: ReturnType<typeof stagedThreadShapeFailure>;
} => {
    const openThreads = openThreadsFromStaged(stagedOpen, resolvedIds);
    const open = suppressOpenThreadDuplicates(claims, openThreads);
    const adjudicated = suppressAdjudicatedDuplicates(
        open.kept,
        adjudicatedThreadsFromStaged(stagedAdjudicated),
    );
    return {
        kept: adjudicated.kept,
        suppressed: [...open.suppressed, ...adjudicated.suppressed],
        shapeFailure: stagedThreadShapeFailure(
            stagedOpen,
            openThreads,
            resolvedIds,
        ),
    };
};
