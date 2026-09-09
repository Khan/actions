/**
 * Parsing the reviewer's collapsed observations out of review bodies.
 *
 * The reviewer's posting surface collapses over-budget and reduced-depth
 * non-blocking findings into the review body's single collapsed
 * `review details` fold, under a bold heading, one terse line each
 * (`submission.ts`). Before this module, those findings were
 * invisible to autofix: the work list reads posted threads, a collapsed
 * finding never becomes a thread, and so the reviewer's budget quietly
 * shrank autofix's scope (the documentation autofix's whole selection key is
 * the label on posted threads). This module gives the plan a second, read-only
 * source: the collapsed entries of the LATEST bot review body.
 *
 * Latest-review-only is deliberate, and strictly: only the NEWEST review's
 * body is read (ordered by submittedAt where present, staging order
 * otherwise), and a newest review with no collapsed section yields no body
 * items at all. Each review's collapsed section states that run's
 * still-unposted findings against that run's head; an entry from an older
 * review describes a tree the review currency machinery does not vouch for
 * (the staleness check is keyed to the latest stamped review; older bodies
 * are not re-validated here even now that stamps survive posting,
 * webapp#41742, because the newest review supersedes them). An
 * older unfixed observation drops out of scope until a review re-derives
 * it, which is the same self-healing bet the reviewer's own corpus memory
 * makes.
 *
 * Section slicing runs from the heading match — the current bold header
 * ({@link COLLAPSED_HEADING_RE}) or the legacy `<summary>` line
 * ({@link LEGACY_COLLAPSED_SUMMARY_RE}) — to the next `</details>`. On a
 * current body that closing tag belongs
 * to the enclosing `review details` fold rather than a per-section block,
 * so the slice additionally covers the config and fingerprint `<sub>` lines
 * that follow the entries — neither matches the entry grammar, so they are
 * skipped like any other unparseable line. How the section is located, and
 * why prose quoting the markup cannot forge the work list, is
 * {@link locateSection}'s docstring.
 *
 * The line grammar parsed here is `submission.ts`'s render, one entry per
 * line:
 *
 *     - `path:line` label: subject <sub>(source)</sub>
 *
 * (pr-level entries omit the backticked anchor; they are skipped here, since
 * autofix needs a file and line to act on). An unparseable line is skipped,
 * never thrown on: the body is a posted artifact, and a render change should
 * degrade autofix's scope, not crash the run.
 */

import {
    COLLAPSED_ENTRY_RE,
    COLLAPSED_HEADING_RE,
    LEGACY_COLLAPSED_SUMMARY_RE,
} from "../../review/lib/submission-render.ts";
import {REVIEW_DETAILS_OPEN_RE} from "../../review/lib/attribution.ts";
import {STAMP_MARKER} from "../../review/lib/rereview-mode.ts";
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
 * The observations section's text, from its heading to the close of the
 * block that carries it, or null when the body has none.
 *
 * The threat model: a pr-level finding's discussion is copied into the body
 * verbatim and unescaped, ABOVE the tail fold, so any markup this function
 * keys on can also appear there as a quote. The defenses, in the order the
 * code applies them:
 *
 *   1. The LAST `review details` opener ({@link REVIEW_DETAILS_OPEN_RE},
 *      whitespace-tolerant and line-anchored — autofix pins its own release,
 *      so the body may have been rendered and ingest-rewritten by a newer
 *      review release) names the real tail fold: body assembly renders it
 *      after everything else, so quoted openers always sit above it. Only
 *      that fold's interior is searched for the bold heading.
 *   2. A last fold with no heading but carrying the fingerprint stamp
 *      ({@link STAMP_MARKER}) is a current-shape body that collapsed
 *      nothing: stop, so a quoted LEGACY heading above the fold cannot win
 *      either. (A current body missing its stamp — a staging failure the
 *      author cannot cause — falls through and keeps that legacy exposure.)
 *   3. Otherwise the body is legacy-shaped (its own wrapped footer fold
 *      never carries a heading or a stamp) or pre-fold: the legacy
 *      `<summary>` carrier is searched whole-body, LAST match winning,
 *      since legacy bodies put pr-level prose above their observations
 *      fold too.
 */
const locateSection = (body: string): string | null => {
    let lastOpenEnd = -1;
    for (const open of body.matchAll(REVIEW_DETAILS_OPEN_RE)) {
        lastOpenEnd = open.index + open[0].length;
    }
    if (lastOpenEnd !== -1) {
        const close = body.indexOf("</details>", lastOpenEnd);
        const fold = body.slice(
            lastOpenEnd,
            close === -1 ? body.length : close,
        );
        const heading = fold.search(COLLAPSED_HEADING_RE);
        if (heading !== -1) {
            return fold.slice(heading);
        }
        if (fold.includes(STAMP_MARKER)) {
            return null;
        }
    }
    let legacy = -1;
    for (const open of body.matchAll(
        new RegExp(LEGACY_COLLAPSED_SUMMARY_RE.source, "g"),
    )) {
        legacy = open.index;
    }
    if (legacy === -1) {
        return null;
    }
    const close = body.indexOf("</details>", legacy);
    return body.slice(legacy, close === -1 ? body.length : close);
};

/**
 * Parse the collapsed observations from the NEWEST review's body (ordered
 * by submittedAt where present, staging order otherwise). A newest body
 * with no collapsed section yields no observations; older bodies are never
 * consulted (the module header carries the staleness reasoning). Only
 * {@link locateSection}'s slice is parsed, so an entry-shaped line
 * elsewhere in the body cannot mint a work item.
 */
export const parseCollapsedObservations = (
    priorReviews: readonly PriorReview[],
): CollapsedObservation[] => {
    // Defensive ordering, shared semantics with rereview-mode's stamp scan:
    // entries without a submittedAt keep their staging order.
    // Undefined submittedAt sorts OLDEST (empty string precedes every ISO
    // timestamp), which keeps the comparator total and transitive on a
    // mixed array; the old both-defined-only comparison made "newest"
    // implementation-defined under Array.prototype.sort.
    const ordered = [...priorReviews].sort((a, b) => {
        const left = a.submittedAt ?? "";
        const right = b.submittedAt ?? "";
        return left < right ? -1 : left > right ? 1 : 0;
    });
    const section = locateSection(ordered[ordered.length - 1]?.body ?? "");
    if (section === null) {
        return [];
    }
    const observations: CollapsedObservation[] = [];
    for (const raw of section.split("\n")) {
        const match = COLLAPSED_ENTRY_RE.exec(raw.trim());
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
};

/**
 * The synthetic work-item id for a body-sourced observation. Prefixed so
 * every consumer (the trailer ledger, the prompt's reply step) can tell it
 * from a GraphQL thread id: there is no thread to reply on, and the run
 * summary is where a body-sourced fix reports. The label's base token rides
 * the id because two distinct in-scope observations can share an anchor
 * (dedup merges same-defect claims only) and the trailer ledger diffs these
 * ids; same-label same-anchor collisions remain possible and are accepted.
 */
export const bodyItemId = (observation: CollapsedObservation): string =>
    `review-body:${observation.path}:${observation.line}:${
        observation.label.split(" ", 1)[0]
    }`;

/** Whether a work-item id names a body-sourced observation. */
export const isBodyItemId = (id: string): boolean =>
    id.startsWith("review-body:");
