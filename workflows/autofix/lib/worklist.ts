/**
 * The work list: which of the reviewer's open threads this autofix run acts on.
 *
 * Input is the same staged shape the reviewer already produces — the unresolved
 * `github-actions[bot]` threads of `review.md` Step 3 Phase 2 ({@link
 * StagedThread}) — so autofix reads the reviewer's own artifact rather than
 * re-deriving one, and the Conventional-Comment label on each thread is parsed
 * with the reviewer's own parser ({@link parseLeadingLabel}). The label
 * taxonomy has exactly one owner (`render-comment.ts`) and this module is not
 * it.
 *
 * **The fail-closed direction is inverted from the reviewer's.** In
 * `rereview.ts` an unparseable label is treated as blocking, because there the
 * safe default is to KEEP a thread the bot cannot classify. Here the safe
 * default is the opposite: a thread whose label will not parse is EXCLUDED,
 * because the risk being managed is an agent editing code on the strength of a
 * finding it could not classify. Same principle, opposite outcome; both are
 * "do the conservative thing", and conflating them would have autofix acting on
 * exactly the threads the reviewer flagged as least trustworthy.
 *
 * Outdated threads are excluded for the same reason: a null anchor means the
 * line the finding was written about is gone from the diff, so there is nothing
 * to act on and any edit would be guesswork.
 */

import {bodyItemId} from "./collapsed.ts";
import type {CollapsedObservation} from "./collapsed.ts";
import type {DiffChangedLines} from "../../review/lib/diff.ts";
import {parseLeadingLabel} from "../../review/lib/rereview.ts";
import type {StagedThread} from "../../review/lib/rereview.ts";

/** One thread selected for fixing, flattened for the prompt and the ledger. */
export type WorkItem = {
    /** GraphQL thread id; the stable identity recorded in the commit trailer. */
    threadId: string;
    path: string;
    line: number;
    /** The Conventional-Comment label parsed off the bot's opening comment. */
    label: string;
    /** The bot's opening comment, verbatim; the statement of the finding. */
    body: string;
    /** Permalink to the thread's opening comment, when staged. */
    url?: string;
};

/** A thread that will NOT be fixed, and why; surfaced in the run summary. */
export type SkippedThread = {
    threadId: string;
    path: string;
    reason:
        | "out-of-scope"
        | "outdated-anchor"
        | "unparseable-label"
        /** The file changed after the review that raised this finding. */
        | "stale-path"
        /** Somebody other than the reviewer opened it; not v1's to act on. */
        | "not-reviewer-thread"
        /** A body-sourced observation whose anchor an open thread already
         * covers; the thread is the work item, the body line is its echo. */
        | "thread-covered";
    /** The parsed label when there was one; absent for unparseable. */
    label?: string;
};

export type WorkList = {
    items: WorkItem[];
    skipped: SkippedThread[];
};

/**
 * Select the threads in scope for this run.
 *
 * `findingLabels` is the union the scope resolver computed; a thread is in
 * scope when its parsed label is in that set. Selection is stable: threads keep
 * their staged order, so the plan artifact and the prompt agree run to run.
 */
export const buildWorkList = (
    threads: readonly StagedThread[],
    findingLabels: readonly string[],
    botLogin: string | undefined = "github-actions[bot]",
): WorkList => {
    const inScope = new Set(findingLabels);
    const items: WorkItem[] = [];
    const skipped: SkippedThread[] = [];

    for (const thread of threads) {
        const first = thread.comments?.[0];
        // Whose thread this is decides whether autofix may touch it at all, and
        // that must be enforced here rather than left to staging. A human can
        // open a thread whose first line happens to read `**issue (blocking):**`
        // (quoting the reviewer, for instance), and nothing else downstream
        // would stop it becoming a work item that an agent then edits code for.
        // v1 acts on reviewer feedback only; the source axis is not implemented.
        // Suffix-insensitive for the same reason staging is: REST spells an
        // App's login `github-actions[bot]`, GraphQL spells it
        // `github-actions`, and a staged thread can carry either.
        const strip = (login: string): string =>
            login.endsWith("[bot]")
                ? login.slice(0, -"[bot]".length).toLowerCase()
                : login.toLowerCase();
        if (
            first === undefined ||
            strip(first.author) !== strip(botLogin ?? "github-actions[bot]")
        ) {
            skipped.push({
                threadId: thread.thread_id,
                path: thread.path,
                reason: "not-reviewer-thread",
            });
            continue;
        }
        const opener = first.body;
        const label = parseLeadingLabel(opener);

        if (label === null) {
            skipped.push({
                threadId: thread.thread_id,
                path: thread.path,
                reason: "unparseable-label",
            });
            continue;
        }
        if (!inScope.has(label)) {
            skipped.push({
                threadId: thread.thread_id,
                path: thread.path,
                reason: "out-of-scope",
                label,
            });
            continue;
        }
        // `line` is null for a thread GitHub marks outdated (the anchored line
        // left the diff) and for file-level threads, which have no line to fix.
        // Checked by type rather than against null so a malformed staging (the
        // JSON is read off disk) lands here instead of downstream.
        if (typeof thread.line !== "number") {
            skipped.push({
                threadId: thread.thread_id,
                path: thread.path,
                reason: "outdated-anchor",
                label,
            });
            continue;
        }

        items.push({
            threadId: thread.thread_id,
            path: thread.path,
            line: thread.line,
            label,
            body: opener,
            ...(thread.url === undefined ? {} : {url: thread.url}),
        });
    }

    return {items, skipped};
};

/**
 * Select the body-sourced observations in scope for this run (the collapsed
 * entries of the latest review body; see `collapsed.ts` for why those exist
 * and why latest-only). Same in-scope rule as {@link buildWorkList}, plus
 * two extra guards:
 *
 *   - An observation whose `path:line` an open staged thread already covers
 *     is skipped as `thread-covered`, so one finding cannot become two work
 *     items when a re-review posts what an earlier run collapsed. Staged
 *     threads are the reviewer's own unresolved threads (staging filters to
 *     bot-opened ones), so this is a bot-thread dedup guard; deference to
 *     open HUMAN conversations happens on the reviewer's side, at its
 *     skip-lines rule, before a finding ever posts or collapses.
 *   - The anchor must land on a CHANGED line of the staged head diff:
 *     added, or adjacent to a removal (the provenance gate's
 *     change-anchored union; a deletion-anchored observation about a
 *     dropped guard legitimately anchors beside the removal). Threads get
 *     their invalidation for free from GitHub, which nulls an outdated
 *     thread's line; a body item's line is a number parsed out of review
 *     text with nothing else to invalidate it, and the file-level
 *     stale-path check upstream runs only when review currency is
 *     verifiable, which in production it usually is not (posted reviews
 *     lose their fingerprint stamp). An anchor the current diff does not
 *     vouch for is skipped as `outdated-anchor`, the same fail-closed
 *     direction the thread path takes.
 *
 * Body items carry a synthetic `review-body:` id ({@link bodyItemId});
 * there is no thread to reply on, so the prompt reports their fixes in the
 * run summary instead (autofix.md Step 6).
 */
export const buildBodyWorkList = (
    observations: readonly CollapsedObservation[],
    findingLabels: readonly string[],
    threads: readonly StagedThread[],
    changedLines: DiffChangedLines,
): WorkList => {
    const inScope = new Set(findingLabels);
    const covered = new Set(
        threads
            .filter((thread) => typeof thread.line === "number")
            .map((thread) => `${thread.path}:${thread.line}`),
    );
    const items: WorkItem[] = [];
    const skipped: SkippedThread[] = [];
    for (const observation of observations) {
        const id = bodyItemId(observation);
        if (!inScope.has(observation.label)) {
            skipped.push({
                threadId: id,
                path: observation.path,
                reason: "out-of-scope",
                label: observation.label,
            });
            continue;
        }
        if (covered.has(`${observation.path}:${observation.line}`)) {
            skipped.push({
                threadId: id,
                path: observation.path,
                reason: "thread-covered",
                label: observation.label,
            });
            continue;
        }
        const file = changedLines[observation.path];
        if (
            !(file?.added ?? []).includes(observation.line) &&
            !(file?.removedAdjacent ?? []).includes(observation.line)
        ) {
            skipped.push({
                threadId: id,
                path: observation.path,
                reason: "outdated-anchor",
                label: observation.label,
            });
            continue;
        }
        items.push({
            threadId: id,
            path: observation.path,
            line: observation.line,
            label: observation.label,
            body: observation.subject,
        });
    }
    return {items, skipped};
};
