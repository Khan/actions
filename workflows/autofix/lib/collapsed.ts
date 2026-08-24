/**
 * Parsing the reviewer's collapsed observations out of review bodies.
 *
 * The reviewer's posting surface collapses over-budget and reduced-depth
 * non-blocking findings into a `<details>` block in the review body, one
 * terse line each (`submission.ts`). Before this module, those findings were
 * invisible to autofix: the work list reads posted threads, a collapsed
 * finding never becomes a thread, and so the reviewer's budget quietly
 * shrank autofix's scope (the documentation autofix's whole selection key is
 * the label on posted threads). This module gives the plan a second, read-only
 * source: the collapsed entries of the LATEST bot review body.
 *
 * Latest-only is deliberate. Each review's collapsed section states that
 * run's still-unposted findings against that run's head; an entry from an
 * older review describes a tree the review currency machinery does not vouch
 * for, and the staleness check (fingerprint vs. current diff) is keyed to the
 * latest stamped review. An older unfixed observation drops out of scope
 * until a review re-derives it, which is the same self-healing bet the
 * reviewer's own corpus memory makes.
 *
 * The line grammar parsed here is `submission.ts`'s render, one entry per
 * line inside the `<details>` block:
 *
 *     - `path:line` label: subject <sub>(source)</sub>
 *
 * (pr-level entries omit the backticked anchor; they are skipped here, since
 * autofix needs a file and line to act on). An unparseable line is skipped,
 * never thrown on: the body is a posted artifact, and a render change should
 * degrade autofix's scope, not crash the run.
 */

import type {PriorReview} from "../../review/lib/rereview-mode.ts";

/** One collapsed observation, parsed off the latest review body. */
export type CollapsedObservation = {
    path: string;
    line: number;
    /** The Conventional-Comment label the entry carries. */
    label: string;
    /** The finding's one-line subject (the claim, not the full discussion). */
    subject: string;
    /** The producing reviewer from the `<sub>(source)</sub>` tag, if present. */
    source?: string;
};

/**
 * The collapsed-section summaries `submission.ts` renders. Matched loosely
 * (prefix only): the count and the top-entry tag vary per run.
 */
const SECTION_SUMMARY =
    /<summary>(?:Non-blocking|Lower-confidence) observations \(/;

/** One collapsed entry line; the grammar `submission.ts` renders. */
const ENTRY =
    /^- `([^`\s:]+):(\d+)` ([a-z]+ \([^)]*\)): (.*?)(?: <sub>\(([^)]+)\)<\/sub>)?$/;

/**
 * Parse the collapsed observations from the latest review body that carries
 * a collapsed section. Reviews are taken in the input order `prior-reviews`
 * staging preserves (ascending submission), scanned from the end; bodies
 * with no collapsed section are skipped, so a bare re-approve does not erase
 * the scope the previous review stated.
 */
export const parseCollapsedObservations = (
    priorReviews: readonly PriorReview[],
): CollapsedObservation[] => {
    for (let i = priorReviews.length - 1; i >= 0; i--) {
        const body = priorReviews[i]?.body ?? "";
        if (!SECTION_SUMMARY.test(body)) {
            continue;
        }
        const observations: CollapsedObservation[] = [];
        for (const raw of body.split("\n")) {
            const match = ENTRY.exec(raw.trim());
            if (match === null) {
                continue;
            }
            observations.push({
                path: match[1],
                line: Number(match[2]),
                label: match[3],
                subject: match[4],
                ...(match[5] === undefined ? {} : {source: match[5]}),
            });
        }
        return observations;
    }
    return [];
};

/**
 * The synthetic work-item id for a body-sourced observation. Prefixed so
 * every consumer (the trailer ledger, the prompt's reply step) can tell it
 * from a GraphQL thread id: there is no thread to reply on, and the run
 * summary is where a body-sourced fix reports.
 */
export const bodyItemId = (observation: CollapsedObservation): string =>
    `review-body:${observation.path}:${observation.line}`;

/** Whether a work-item id names a body-sourced observation. */
export const isBodyItemId = (id: string): boolean =>
    id.startsWith("review-body:");
