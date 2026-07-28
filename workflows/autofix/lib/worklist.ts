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
        | "stale-path";
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
): WorkList => {
    const inScope = new Set(findingLabels);
    const items: WorkItem[] = [];
    const skipped: SkippedThread[] = [];

    for (const thread of threads) {
        const opener = thread.comments?.[0]?.body ?? "";
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
