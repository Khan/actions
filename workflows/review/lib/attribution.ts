/**
 * The collapsed footer surfaces: one shared `<details>` wrapper for the
 * run-level version/config footer (version-footer.ts) and the per-comment
 * reviewer attribution, plus the strip that keeps footer boilerplate out of
 * text-similarity comparisons.
 *
 * Why collapsed: both footers are metadata, not review content. Rendered
 * open they add a visible line to every posted surface; wrapped in
 * `<details>` they collapse to one small summary chip the author can expand.
 * `details`, `summary`, and `sub` are all on gh-aw's ingest-sanitizer
 * allowed-tag list (`SANITIZER_ALLOWED_TAGS`, sanitizer-normalize.ts mirrors
 * sanitize_content_core.cjs v0.83.4), so the block survives ingest
 * verbatim; that is the same property that made version-footer.ts pick
 * `<sub>` over the hidden HTML marker the sanitizer deletes.
 *
 * Why attribution is rendered HERE (code, at the posting surface) and not
 * carried in a claim's `discussion`: dedup runs before the claim-validator,
 * whose `corrected.discussion` rewrite replaces the prose wholesale, so a
 * merge note appended to `discussion` can be silently dropped. The
 * structured `also_flagged_by` field on the claim survives every rewrite
 * (applyVerifications never touches it), and this module turns it into text
 * only when the comment is composed. Determinism boundary: everything here
 * is code-owned wrapping around code-recorded facts (source names, line
 * numbers) plus a merged copy's `subject` quoted verbatim; no prose about
 * the code under review is synthesised.
 */

import {CONTEXT_FOLD_OPEN} from "./render-comment";

/**
 * One duplicate copy dedup folded into a surviving claim: the reviewer that
 * produced it, its own anchor line when it differs from the survivor's, and
 * (for a tier-2, clusterer-merged copy only) its subject, verbatim, because
 * the survivor's prose is not known to restate that ask (see dedup.ts).
 */
export type AlsoFlagged = {
    source: string;
    line?: number;
    subject?: string;
};

/** The code-owned summary chip both collapsed footers render under. */
export const FOOTER_SUMMARY = "review details";

/**
 * Wrap one `<sub>` content line in the shared collapsed `<details>` block.
 * The shape is fixed so {@link stripFooters} can remove it mechanically.
 */
export const renderCollapsedFooter = (content: string): string =>
    [
        `<details><summary><sub>${FOOTER_SUMMARY}</sub></summary>`,
        `<sub>${content}</sub>`,
        "</details>",
    ].join("\n");

/**
 * A merged copy's `subject` is model-authored text interpolated into the
 * footer's HTML. Unescaped, a subject containing a literal `</details>`
 * closes the collapsed block early and truncates {@link stripFooters}'s
 * non-greedy match. Escape the HTML-significant characters; GitHub renders
 * the entities back as the literal characters.
 */
export const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const flaggedBy = (entry: AlsoFlagged): string => {
    const anchor =
        entry.line === undefined
            ? entry.source
            : `${entry.source} (at line ${entry.line})`;
    return entry.subject === undefined
        ? anchor
        : `${anchor}: ${escapeHtml(entry.subject)}`;
};

/**
 * The per-comment attribution footer: which reviewer produced the finding,
 * and (when cross-source dedup merged duplicates into it) which other
 * reviewers flagged the same defect, each with its differing anchor line and
 * (tier-2 copies) its own ask. Segments join with ` | ` like the version
 * footer; merged entries join with `; ` because a quoted subject can carry
 * commas.
 */
export const renderAttributionFooter = (
    source: string,
    alsoFlaggedBy: readonly AlsoFlagged[] = [],
): string => renderCollapsedFooter(attributionLine(source, alsoFlaggedBy));

/**
 * The bare attribution text, without the collapsed-footer wrapper: a
 * context-folded comment (submission-render.ts) carries it as a `<sub>`
 * line INSIDE its own fold instead of appending a second details block
 * (two stacked expandos per comment read as clutter). stripFooters'
 * whole-line `<sub>` strip removes that form too, so the boilerplate stays
 * out of text-similarity comparisons either way.
 */
export const attributionLine = (
    source: string,
    alsoFlaggedBy: readonly AlsoFlagged[] = [],
): string => {
    const segments = [`found by ${source}`];
    if (alsoFlaggedBy.length > 0) {
        segments.push(
            `also flagged by ${alsoFlaggedBy.map(flaggedBy).join("; ")}`,
        );
    }
    return segments.join(" | ");
};

/**
 * The collapsed-footer block, tolerant of the whitespace GitHub round-trips
 * may introduce; non-greedy so it stops at the block's own `</details>` (a
 * footer never nests another details block).
 */
const FOOTER_BLOCK_RE = new RegExp(
    `<details>\\s*<summary>\\s*<sub>${FOOTER_SUMMARY}</sub>\\s*</summary>[\\s\\S]*?</details>`,
    "gi",
);

/**
 * The context fold's wrapper pair (render-comment.ts's CONTEXT_FOLD_OPEN
 * line through the first closing tag on its own line), capturing the inner
 * content so {@link stripFooters} can unwrap rather than delete it. A fold
 * never nests another details block, so the non-greedy close is its own.
 * Interpolates the renderer's own constant, like FOOTER_BLOCK_RE above, so
 * a chip rename cannot silently desync the strip.
 */
const CONTEXT_FOLD_RE = new RegExp(
    `^${CONTEXT_FOLD_OPEN.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
    )}[ \\t]*\\n([\\s\\S]*?)\\n</details>[ \\t]*$`,
    "gm",
);

/**
 * Drop footer boilerplate from a previously-posted bot comment before
 * text-similarity comparison (dedup-threads.ts's `threadProse`). Every posted
 * comment carries the same summary chip, `found by <source>` prefix, and
 * version segments; tokens shared by ALL bot comments would inflate
 * similarity between unrelated findings, exactly like the label template
 * and rule-quote lines `threadProse` already strips. Removes the collapsed
 * block and the two residual bare `<sub>…</sub>` shapes this codebase has
 * posted: a whole-line span (the pre-collapse version-footer line) and a
 * parenthesized span at end of line (the source tag on collapsed
 * one-liners). Deliberately NOT a blanket `<sub>…</sub>` strip: a posted
 * comment whose own discussion quotes a `<sub>` span mid-prose (even in
 * backticks) is review content, and deleting it would distort the
 * similarity text.
 */
export const stripFooters = (body: string): string =>
    body
        .replace(FOOTER_BLOCK_RE, "")
        // The context fold's WRAPPER lines only (render-comment.ts's
        // CONTEXT_FOLD_OPEN through its own closing tag, non-greedy): the
        // prose inside the fold is review content and must stay
        // comparable, which is exactly why the fold does not reuse the
        // `review details` chip this function removes wholesale. Other
        // details blocks (the review body's collapsed-observations
        // section) keep their wrappers: only the context chip matches.
        .replace(CONTEXT_FOLD_RE, "$1")
        .replace(/^[ \t]*<sub>[^<]*<\/sub>[ \t]*$/gm, "")
        .replace(/<sub>\([^<]*\)<\/sub>[ \t]*$/gm, "");
