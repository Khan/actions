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
 * footer's HTML. Escape the HTML-significant characters so the plan-side
 * artifact stays inert; GitHub renders the entities back as the literal
 * characters. NOT a structural defense on its own: gh-aw's ingest sanitizer
 * decodes HTML entities in everything the agent queues (mirrored by
 * sanitizer-normalize.ts's decodeHtmlEntities), so an escaped tag posts as
 * a live one. {@link neutralizeThenEscape} is the composition that
 * actually protects a raw-HTML line; this escape is only its second half.
 */
export const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The two structure-closing tags, open or close form, any attributes,
 * bracket-spelled or entity-spelled: the ingest sanitizer's decode
 * collapses `&lt;` AND double-encoded `&amp;lt;` to `<` in one pass
 * (sanitizer-normalize.ts mirrors it), so an entity-spelled tag in model
 * prose posts live on every surface, escaped or not.
 */
const STRUCTURAL_TAG_RE =
    /(?:<|&(?:amp;)?lt;)(\/?\s*(?:details|summary)\b[^>]*?)(?:>|&(?:amp;)?gt;)/gi;

/**
 * A GFM code span: two backtick runs of EXACTLY equal length (the
 * lookarounds pin both ends of both runs, so an opener can neither start
 * mid-run nor close against a longer run's tail).
 */
const CODE_SPAN_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/**
 * Rewrite a `details`/`summary` tag in model-authored text to the ingest
 * sanitizer's parenthesised form (`</details>` becomes `(/details)`, the
 * shape foldXmlTags gives every DISALLOWED tag). Entity-escaping cannot
 * protect a posted surface from these two tags: the sanitizer decodes
 * `&lt;/details&gt;` back to the literal tag, and both tags are on its
 * allowed list, so the tag posts live and closes the enclosing collapsed
 * block right there (Khan/actions#401's re-review posted its whole
 * collapsed-observations list outside the block this way: the top-ranked
 * subject quoted a bare `</details>`).
 *
 * MARKDOWN surfaces only (the collapsed list entries, the recap's kept
 * lines): there, a backtick code span is not parsed as HTML on GitHub, so
 * `` `</details>` `` is how a finding legitimately names the tag and
 * passes through verbatim. The span match mirrors GFM's rule, an opening
 * backtick run closes only against a run of the SAME length, so a
 * mismatched pair (`` a `</details>`` b ``) forms no code span and its tag
 * is rewritten (never left live). Raw-HTML surfaces must use
 * {@link neutralizeThenEscape} instead: inside a `<summary>` or the
 * footer's `<sub>` line no markdown is processed at all, backticks render
 * literally, and a "code span" there is live HTML. Scoped to the two
 * structure-closing tags on purpose: other allowed tags (`sub`, `b`) can
 * only mis-style text, and rewriting them would mangle far more legitimate
 * prose than they endanger.
 */
export const neutralizeStructuralTags = (text: string): string => {
    let out = "";
    let last = 0;
    for (const match of text.matchAll(CODE_SPAN_RE)) {
        out +=
            text.slice(last, match.index).replace(STRUCTURAL_TAG_RE, "($1)") +
            match[0];
        last = match.index + match[0].length;
    }
    return out + text.slice(last).replace(STRUCTURAL_TAG_RE, "($1)");
};

/**
 * The composed treatment for model-authored text interpolated into a
 * RAW-HTML line (the collapsed section's `<summary>`, the attribution
 * footer's `<sub>`, both emitted with no preceding blank line, so GitHub
 * processes no markdown inside them): every `details`/`summary` tag is
 * rewritten, code spans included, because backticks there are literal
 * characters, not spans (Khan/actions#402 review 5071533178), then
 * {@link escapeHtml} for plan-side inertness. `maxChars` truncates AFTER
 * the rewrite and before the escape: slicing the raw text can cut a tag
 * in half, and the sanitizer's tag fold then eats from the fragment to
 * the enclosing block's own closer, while a sliced `(/details)` is inert.
 */
export const neutralizeThenEscape = (
    text: string,
    maxChars?: number,
): string => {
    const neutral = text.replace(STRUCTURAL_TAG_RE, "($1)");
    return escapeHtml(
        maxChars !== undefined && neutral.length > maxChars
            ? `${neutral.slice(0, maxChars)}...`
            : neutral,
    );
};

const flaggedBy = (entry: AlsoFlagged): string => {
    const anchor =
        entry.line === undefined
            ? entry.source
            : `${entry.source} (at line ${entry.line})`;
    return entry.subject === undefined
        ? anchor
        : `${anchor}: ${neutralizeThenEscape(entry.subject)}`;
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
): string => {
    const segments = [`found by ${source}`];
    if (alsoFlaggedBy.length > 0) {
        segments.push(
            `also flagged by ${alsoFlaggedBy.map(flaggedBy).join("; ")}`,
        );
    }
    return renderCollapsedFooter(segments.join(" | "));
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
        .replace(/^[ \t]*<sub>[^<]*<\/sub>[ \t]*$/gm, "")
        .replace(/<sub>\([^<]*\)<\/sub>[ \t]*$/gm, "");
