/**
 * Claim rendering for the submission plan (split from `submission.ts` by its
 * max-lines budget, the dispatch-contracts precedent): the Conventional
 * Comment renderer driven by a claim's post-validation label, the pr-level
 * body fold, the drop-in-suggestion gate, and the label-token vocabulary
 * helpers. Everything here sits inside the determinism boundary: CODE owns
 * the wrapping and the gates, MODELS own the prose, which is copied
 * verbatim.
 */

import type {Claim} from "./dispatch-contracts";

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
 * does not.
 */
export const renderPrLevelFold = (claim: Claim): string => {
    if (claim.discussion.length <= MAX_VERBATIM_FOLD_CHARS) {
        return `**${claim.label}:** ${claim.discussion}`;
    }
    return [
        `**${claim.label}:** ${claim.subject}`,
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
 */
export const renderClaimComment = (claim: Claim): string => {
    const lines: string[] = [`**${claim.label}:** ${claim.discussion}`];
    if (claim.rule_quote !== undefined) {
        const [first, ...rest] = claim.rule_quote.split("\n");
        lines.push(
            "",
            `> **Rule:** ${first}`,
            ...rest.map((line) => (line === "" ? ">" : `> ${line}`)),
        );
    }
    if (claim.suggestion !== undefined) {
        if (isDropInSuggestion(claim.suggestion)) {
            lines.push("", "```suggestion", claim.suggestion, "```");
        } else if (labelAdmitsSketch(claim.label)) {
            lines.push(
                "",
                "A sketch, not a committable replacement:",
                "",
                "````",
                claim.suggestion,
                "````",
            );
        }
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
 */
export const renderCollapsedLine = (claim: Claim): string =>
    claim.path !== undefined && claim.line !== undefined
        ? `- \`${claim.path}:${claim.line}\` ${claim.label}: ${
              claim.subject
          } ${sourceTag(claim)}`
        : `- ${claim.label}: ${claim.subject} ${sourceTag(claim)}`;

/**
 * The parse of one {@link renderCollapsedLine} entry, anchored form only
 * (the body-sourced work list needs a file and line to act on). Groups:
 * path, line, label, subject, optional source.
 */
export const COLLAPSED_ENTRY_RE =
    /^- `([^`\s:]+):(\d+)` ([a-z]+ \([^)]*\)): (.*?)(?: <sub>\(([^)]+)\)<\/sub>)?$/;
