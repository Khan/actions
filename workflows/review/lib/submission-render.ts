/**
 * Claim rendering for the submission plan (split from `submission.ts` by its
 * max-lines budget, the dispatch-contracts precedent): the Conventional
 * Comment renderer driven by a claim's post-validation label, the pr-level
 * body fold, the drop-in-suggestion gate, and the label-token vocabulary
 * helpers. Everything here sits inside the determinism boundary: CODE owns
 * the wrapping and the gates, MODELS own the prose, which is copied
 * verbatim with one exception: `details`/`summary` tags in a collapsed
 * entry's subject are rewritten to their parenthesised form
 * (neutralizeStructuralTags, attribution.ts), since a live one closes the
 * section's collapse at that bullet.
 */

import {neutralizeStructuralTags} from "./attribution";
import type {Claim} from "./dispatch-contracts";
import type {AlsoFlagged} from "./attribution";
import {attributionLine, renderAttributionFooter} from "./attribution";
import {
    containsBlockClose,
    ensureTerminalPunctuation,
    renderContextFold,
    renderRuleQuote,
    shouldFoldContext,
} from "./render-comment";

/**
 * How many lines a committable suggestion may replace the anchored line
 * with; anything longer is a sketch, not a drop-in.
 */
const MAX_SUGGESTION_LINES = 8;

/**
 * The base token of a Conventional-Comment label (`nitpick` from
 * `nitpick (non-blocking)`). Same parse {@link labelAdmitsSketch} uses;
 * factored so the two agree on what a label's token IS.
 */
export const labelToken = (label: string): string =>
    (label.trim().split(/[\s(:]/, 1)[0] ?? "").toLowerCase();

/**
 * A pr-level claim's discussion folds into the body verbatim only up to
 * this length; past it, the body carries the claim's subject line and the
 * full discussion moves into a <details> block. webapp#41290 review
 * 4867627688 folded a ~2,600-char single-paragraph finding directly into
 * the body, burying the accountability section and the note lines around
 * it; a short paragraph is the most a fold can carry without doing that.
 */
export const MAX_VERBATIM_FOLD_CHARS = 400;

/**
 * Render a pr-level claim for the review body: verbatim while it reads as
 * a short paragraph, subject line plus a collapsed full finding once it
 * does not. Same block-close guard as renderContextFold on the text that
 * lands INSIDE the block: the discussion interpolates unescaped, so a
 * literal closing tag there would end the block early and spill the rest
 * of the finding (and the body sections after it) out of the collapse,
 * and such a claim posts flat instead (PR #408 round 2). The subject is
 * deliberately not guarded: it renders on the line above the open tag,
 * at the body's top level with no block open (submission.ts joins each
 * pr-level fold into coreBody directly), so a stray closing tag there has
 * nothing to end, and guarding it would only buy the flat fallback, which
 * is the burial MAX_VERBATIM_FOLD_CHARS exists to prevent (PR #408 canary
 * round).
 */
export const renderPrLevelFold = (claim: Claim): string => {
    if (
        claim.discussion.length <= MAX_VERBATIM_FOLD_CHARS ||
        containsBlockClose(claim.discussion)
    ) {
        return `**${claim.label}:** ${claim.discussion}`;
    }
    return [
        // The same visible-line normalization renderContextFold applies:
        // both renderers put a bare subject directly above a collapsed
        // block, and the subject contract ("the only text visible when
        // the discussion folds") governs pr-level findings too (PR #408
        // review).
        `**${claim.label}:** ${ensureTerminalPunctuation(claim.subject)}`,
        "<details>",
        "<summary>Full finding</summary>",
        "",
        claim.discussion,
        "",
        "</details>",
    ].join("\n");
};

/**
 * The one-line source tag for collapsed/hold list entries: the same
 * attribution the full comments carry, in the smallest form that fits a
 * one-liner (a whole collapsed footer per list entry would bury the list).
 * `<sub>` is sanitizer-allowed, and attribution.ts's stripFooters removes
 * the span before any text-similarity comparison against posted bodies.
 */
export const sourceTag = (claim: Claim): string =>
    `<sub>(${claim.source})</sub>`;

const lineHasCodeSignal = (line: string): boolean =>
    /\w\(/.test(line) || // a call
    /[{};]/.test(line) || // block/statement punctuation
    /:=|=>|->/.test(line) || // assignment/arrow operators
    /^\s*(\/\/|#|\/\*|\*)/.test(line) || // a comment marker
    /^\t/.test(line); // code-convention indentation

const looksLikeProse = (line: string): boolean => {
    // Deliberately NOT vetoed by lineHasCodeSignal: run 29901690493 posted
    // "Use ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays), and add a test
    // that ..." as a committable fence because the embedded call defeated
    // the prose check. A sentence that names code is still a sentence.
    const words = line.trim().split(/\s+/);
    if (words.length < 6) {
        return false;
    }
    const plain = words.filter((word) =>
        /^\(?[A-Za-z][A-Za-z']*[.,;:!?)]?$/.test(word),
    );
    return plain.length / words.length >= 0.75;
};

/**
 * Whether a claim's suggestion is plausibly a committable replacement of
 * the anchored line: small and code-shaped. Trial run 29897276810 posted an
 * English sentence and a 30-line test function inside `suggestion` fences
 * (Khan/webapp#41009 comments r3628128268 / r3628128224), both of which a
 * single click would have committed verbatim into the file.
 */
export const isDropInSuggestion = (suggestion: string): boolean => {
    const lines = suggestion.replace(/\n$/, "").split("\n");
    const content = lines.filter((line) => line.trim() !== "");
    if (content.length === 0 || lines.length > MAX_SUGGESTION_LINES) {
        return false;
    }
    return content.some(lineHasCodeSignal) && !content.some(looksLikeProse);
};

/**
 * The base label tokens whose comments propose a fix, and so may carry a
 * sketch block. `issue` and `suggestion` are the fix-proposing labels;
 * `todo (blocking)` is verdict-equivalent to `issue (blocking)` (see
 * render-comment.ts), so stripping its fix would remove the sketch from a
 * blocking finding. `question`, `thought`, `note`, and `nitpick` raise a
 * point rather than propose a fix: measured on Khan/webapp (2026-08-11/12),
 * 31 of 57 posted comments carried a sketch, including questions and
 * thoughts whose sketch restated the prose without adding information.
 *
 * Deliberate consequence: a dispute-capped claim relabeled to
 * `question (non-blocking)` by applyVerifications keeps its `suggestion`
 * field but posts without the sketch block. The gate is about information
 * loss, not the label's tone: a sketch restates prose (the measured
 * sample), so dropping it under a non-fix label costs length, not content,
 * whereas a drop-in fence IS the fix in committable form and renders under
 * any label (see renderClaimComment). So a disputed claim keeps its
 * one-click fix and loses only the restatement.
 */
const SKETCH_LABEL_TOKENS: ReadonlySet<string> = new Set([
    "issue",
    "todo",
    "suggestion",
]);

/**
 * Whether a claim's label admits a sketch block. Matches on the base label
 * token so every variant counts (`suggestion (non-blocking, documentation)`
 * is a suggestion). An unparseable label is sketch-eligible: fail toward
 * more information, never toward silently dropping an authored fix.
 */
export const labelAdmitsSketch = (label: string): boolean => {
    const token = labelToken(label);
    return token === "" || SKETCH_LABEL_TOKENS.has(token);
};

/**
 * Render one claim as its Conventional Comment (the renderComment layout,
 * driven by the claim's post-validation label rather than a recomputed one).
 * A suggestion only becomes a committable `suggestion` fence when it is
 * plausibly drop-in; otherwise it renders as a plain fenced sketch, and only
 * under a fix-proposing label ({@link labelAdmitsSketch}): a question or
 * thought proposes no fix, so a sketch under it adds length, not
 * information.
 *
 * A claim whose discussion clears the context-fold bar posts as the
 * summary-plus-fold shape instead ({@link shouldFoldContext} over the
 * claim's `subject`): the visible line is the subject (terminal punctuation
 * ensured by renderContextFold), and the discussion,
 * rule quote, sketch, and attribution collapse into one details block. The
 * committable suggestion fence stays outside the fold either way, so the
 * one-click apply never hides. `attribution` is optional so the eval
 * renderer and tests can pin the bare layout; when present it lands inside
 * the fold as a `<sub>` line, or (unfolded) as the classic collapsed
 * footer, keeping every posted comment attributed through exactly one of
 * the two shapes.
 */
export const renderClaimComment = (
    claim: Claim,
    attribution?: {source: string; alsoFlaggedBy?: readonly AlsoFlagged[]},
): string => {
    const attributionText =
        attribution === undefined
            ? undefined
            : attributionLine(attribution.source, attribution.alsoFlaggedBy);
    const dropIn =
        claim.suggestion !== undefined && isDropInSuggestion(claim.suggestion);
    const sketch =
        claim.suggestion !== undefined &&
        !dropIn &&
        labelAdmitsSketch(claim.label)
            ? [
                  "A sketch, not a committable replacement:",
                  "",
                  "````",
                  claim.suggestion,
                  "````",
              ].join("\n")
            : undefined;

    if (
        shouldFoldContext(claim.subject, claim.discussion) &&
        // The rule quote and sketch land inside the block, so they get the
        // same block-close guard the prose does (attribution is escaped by
        // construction).
        (claim.rule_quote === undefined ||
            !containsBlockClose(claim.rule_quote)) &&
        (sketch === undefined || !containsBlockClose(sketch))
    ) {
        return renderContextFold({
            label: claim.label,
            summary: claim.subject,
            prose: claim.discussion,
            insideFold: [
                ...(claim.rule_quote !== undefined
                    ? [renderRuleQuote(claim.rule_quote)]
                    : []),
                ...(sketch !== undefined ? [sketch] : []),
                ...(attributionText !== undefined
                    ? [`<sub>${attributionText}</sub>`]
                    : []),
            ],
            outsideFold: dropIn
                ? [
                      ["```suggestion", claim.suggestion as string, "```"].join(
                          "\n",
                      ),
                  ]
                : [],
        });
    }

    const lines: string[] = [`**${claim.label}:** ${claim.discussion}`];
    if (claim.rule_quote !== undefined) {
        lines.push("", renderRuleQuote(claim.rule_quote));
    }
    if (claim.suggestion !== undefined) {
        if (dropIn) {
            lines.push("", "```suggestion", claim.suggestion, "```");
        } else if (sketch !== undefined) {
            lines.push("", sketch);
        }
    }
    if (attribution !== undefined) {
        lines.push(
            "",
            renderAttributionFooter(
                attribution.source,
                attribution.alsoFlaggedBy,
            ),
        );
    }
    return lines.join("\n");
};

/* -------------------------------------------------------------------------- */
/* The collapsed-entry line grammar                                           */
/* -------------------------------------------------------------------------- */

/**
 * Render one claim as a collapsed-section (or hold-comment) list entry:
 *
 *     - `path:line` label: subject <sub>(source)</sub>
 *
 * (pr-level claims omit the backticked anchor). This line is a PARSED
 * surface, not only a rendered one: the autofix's body-sourced work list
 * reads these entries back off posted review bodies with
 * {@link COLLAPSED_ENTRY_RE}, so the renderer and the regex live side by
 * side and a round-trip test in workflows/autofix/lib/collapsed.test.ts
 * pins the contract. Change one, change both.
 *
 * The subject is model-authored text inside the section's <details>
 * block, so it is structurally neutralized: a bare `</details>` in any
 * entry closes the section at that bullet and spills the rest of the
 * list out of the collapse (Khan/actions#401's re-review), and escaping
 * cannot help because the ingest sanitizer decodes entities
 * ({@link neutralizeStructuralTags}).
 */
export const renderCollapsedLine = (claim: Claim): string =>
    claim.path !== undefined && claim.line !== undefined
        ? `- \`${claim.path}:${claim.line}\` ${
              claim.label
          }: ${neutralizeStructuralTags(claim.subject)} ${sourceTag(claim)}`
        : `- ${claim.label}: ${neutralizeStructuralTags(
              claim.subject,
          )} ${sourceTag(claim)}`;

/**
 * The parse of one {@link renderCollapsedLine} entry, anchored form only
 * (the body-sourced work list needs a file and line to act on). Groups:
 * path, line, label, subject, optional source.
 */
export const COLLAPSED_ENTRY_RE =
    /^- `([^`\s:]+):(\d+)` ([a-z]+ \([^)]*\)): (.*?)(?: <sub>\(([^)]+)\)<\/sub>)?$/;

/**
 * The parse of the collapsed section's `<summary>` line (matched loosely,
 * prefix only: the count and the named-top tag vary per run, and a
 * one-entry section renders `<details open>` with a count-only summary;
 * keying on the `<summary>` text matches both forms). Lives beside the
 * renderer for the same no-drift reason as {@link COLLAPSED_ENTRY_RE}.
 */
export const COLLAPSED_SUMMARY_RE =
    /<summary>(?:Non-blocking|Lower-confidence) observations \(/;
