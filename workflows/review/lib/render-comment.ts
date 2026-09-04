/**
 * Deterministic, templated rendering of Conventional Comments from the
 * structured finding schema, plus the review-body template.
 *
 * This module sits squarely inside the determinism boundary: CODE
 * owns the label taxonomy, the label-wrapping, and the comment/review-body
 * templates; MODELS own every human-read sentence. The only free text that flows
 * through here is text a lens sub-agent already authored — `model_authored_prose`
 * and the optional `suggested_patch` — copied verbatim. Nothing in this file
 * synthesises, paraphrases, or scores prose about the code under review; if you
 * find yourself composing a sentence about the code here, it belongs in a
 * sub-agent prompt, not in this module. (Fixed template lines, like the
 * skipped-dimension note and the hold-for-human instructions, are code-owned.)
 *
 * The label taxonomy is owned here (not in `verdict.ts`) because the labels are
 * fundamentally a rendering concern — they are the wrapper code puts around a
 * finding. `verdict.ts` consumes {@link isBlockingLabel} to compute the run-level
 * outcome, keeping a single source of truth for "which labels block".
 */

import type {Anchor, Finding, Lens} from "./finding-schema";

/**
 * The review-outcome vocabulary. `APPROVE` / `REQUEST_CHANGES` are #194's
 * mechanical events. `COMMENT` is the middle verdict (PRA-7): the run found
 * medium-importance findings and nothing blocking, so it neither vouches for
 * the change nor demands another round; it IS a GitHub review event, and the
 * findings post exactly as they would on an approval. `HOLD_FOR_HUMAN` is
 * the coverage outcome (missing-core dimension gate + policy-named
 * conflicts); it is NOT a GitHub review event, so the orchestrator surfaces
 * a hold by pulling in a human rather than auto-submitting anything.
 *
 * Defined here (the rendering module) rather than in `verdict.ts` so the import
 * graph has a single direction (`verdict.ts` -> `render-comment.ts`) with no
 * cycle: rendering is the lower-level presentation vocabulary, verdict is the
 * policy computed on top of it.
 */
export type VerdictEvent =
    | "APPROVE"
    | "COMMENT"
    | "REQUEST_CHANGES"
    | "HOLD_FOR_HUMAN";

/**
 * The Conventional-Comment labels that drive REQUEST_CHANGES under #194's
 * mechanical model. Consumed by `verdict.ts`; do not re-implement the rule.
 */
export const BLOCKING_LABELS = [
    "issue (blocking)",
    "issue (blocking, best-practice)",
    "todo (blocking)",
] as const;

/**
 * The label the `documentation` reviewer's findings carry. Named because it is
 * a selection key, not only a description: a documentation-scoped autofix is
 * defined as "the posted threads whose label is this one", so the string is
 * imported rather than re-spelled downstream.
 */
export const DOCUMENTATION_LABEL = "suggestion (non-blocking, documentation)";

/**
 * The label the `maintainability` reviewer's findings carry. Same reasoning as
 * {@link DOCUMENTATION_LABEL}: a selection key for a downstream consumer that
 * reads labels off posted comments, so it is spelled once and imported.
 */
export const MAINTAINABILITY_LABEL =
    "suggestion (non-blocking, maintainability)";

/**
 * The nitpick label. Named for the same reason {@link DOCUMENTATION_LABEL}
 * is: it is a selection key, not only a description — the posting surface
 * (`submission.ts`) never posts nitpick-class findings inline, so the string
 * is imported rather than re-spelled downstream.
 */
export const NITPICK_LABEL = "nitpick (non-blocking)";

/** Every other Conventional-Comment label; none of these block. */
export const NON_BLOCKING_LABELS = [
    "suggestion (non-blocking)",
    "suggestion (non-blocking, best-practice)",
    DOCUMENTATION_LABEL,
    MAINTAINABILITY_LABEL,
    NITPICK_LABEL,
    "question (non-blocking)",
    "thought (non-blocking)",
    "note (non-blocking)",
] as const;

export type BlockingLabel = typeof BLOCKING_LABELS[number];
export type NonBlockingLabel = typeof NON_BLOCKING_LABELS[number];
export type ConventionalLabel = BlockingLabel | NonBlockingLabel;

/**
 * Whether a Conventional-Comment label blocks the merge. Accepts any string so
 * callers can classify labels read off already-posted comments (#194's verdict
 * is a function of the labels actually posted, which may have been corrected by
 * `claim-validator`). An unrecognised label is treated as non-blocking — the
 * safe default: an unknown label never forces REQUEST_CHANGES on its own.
 */
export const isBlockingLabel = (label: string): boolean =>
    (BLOCKING_LABELS as readonly string[]).includes(label);

/**
 * Lenses whose findings render as *best-practice* labels rather than plain
 * correctness labels. The finding schema deliberately keeps a small three-value
 * `severity` (blocking/medium/advisory); the richer Conventional taxonomy is applied
 * here at render time (schema comment on `SEVERITIES`). #194 maps skill/
 * best-practice findings to the `, best-practice` label variants, so among
 * schema findings only the conventions lens gets them (the skill-auditor's
 * violations get theirs on the claims path); the specialist
 * correctness lenses (security, money, concurrency, …), the correctness lens,
 * first-principles, and pattern-triage all render as plain correctness labels.
 *
 * This is a code-owned mapping (extend the set if a future lens is best-practice
 * in nature); it is not model judgement.
 */
const BEST_PRACTICE_LENSES: ReadonlySet<Lens> = new Set<Lens>(["conventions"]);

/**
 * Lenses whose findings render as *documentation* labels. Same code-owned
 * mapping as {@link BEST_PRACTICE_LENSES}, but the variant exists for a second
 * reason beyond describing the finding to a human: it is the **only** channel
 * by which a downstream consumer can tell a documentation thread from any other
 * non-blocking thread.
 *
 * The autofix workflow selects the threads it may act on by parsing the
 * Conventional-Comment label off each posted comment (`parseLeadingLabel`); it
 * reads the PR's threads, not this run's artifact, so nothing else about the
 * finding survives to reach it. A documentation-scoped autofix is therefore
 * exactly "the threads carrying this label", and dropping the variant would
 * silently widen that scope to every nit on the PR.
 */
const DOCUMENTATION_LENSES: ReadonlySet<Lens> = new Set<Lens>([
    "documentation",
]);

/**
 * Lenses whose findings render as *maintainability* labels. Same code-owned
 * mapping and the same reason as {@link DOCUMENTATION_LENSES}: the label is
 * the only channel by which a consumer reading posted threads can tell a
 * maintainability finding (a near-duplicate of an existing helper, dead code
 * left in a touched function, a misleading name) from any other nit, and
 * those are exactly the findings a scoped autofix does well.
 */
const MAINTAINABILITY_LENSES: ReadonlySet<Lens> = new Set<Lens>([
    "maintainability",
]);

/**
 * The Conventional-Comment label a finding renders with. Deterministic function
 * of the finding's `severity` and `lens` only:
 *
 *   - blocking  + best-practice lens  -> `issue (blocking, best-practice)`
 *   - blocking  + other lens          -> `issue (blocking)`
 *   - advisory  + best-practice lens  -> `suggestion (non-blocking, best-practice)`
 *   - advisory  + documentation lens  -> `suggestion (non-blocking, documentation)`
 *   - advisory  + maintainability lens -> `suggestion (non-blocking, maintainability)`
 *   - advisory  + other lens          -> `suggestion (non-blocking)`
 *
 * `medium` severity renders exactly as `advisory` does (the non-blocking
 * rows above). That is the tier's design invariant, not an omission:
 * keeping medium out of the label vocabulary is what leaves the label-keyed
 * machinery (the recap parser, dedup's blocking guards, the flip gate)
 * untouched. The verdict DOES read the tier, but directly (`verdict.ts`
 * consumes the post-veto medium count and demotes a would-be APPROVE to
 * COMMENT), never through labels.
 *
 * There is deliberately **no blocking documentation variant**. The
 * documentation reviewer is advisory-only (its definition permits it one
 * label), so the blocking row is unreachable for it in practice; and minting a
 * blocking docs label would enlarge `BLOCKING_LABELS`, which is the set
 * `autofix: blocking` acts on. A documentation finding that somehow arrives
 * blocking renders as a plain `issue (blocking)`: it keeps its severity and
 * loses only its eligibility for the documentation autofix scope, which is the
 * safe direction (a blocking finding wants a human, not a scoped bulk fix).
 * The same holds for `maintainability`, advisory-only by definition.
 *
 * The finer labels a human reviewer might pick (`todo`, `nitpick`, `question`,
 * `thought`, `note`) are not expressible in the three-value schema, so lenses fold
 * them into the canonical issue/suggestion pair. `verdict.ts` and `review.md`
 * both treat `issue (blocking*)` and `todo (blocking)` identically, so the fold
 * is verdict-preserving.
 */
export const labelForFinding = (finding: Finding): ConventionalLabel => {
    const bestPractice = BEST_PRACTICE_LENSES.has(finding.lens);
    if (finding.severity === "blocking") {
        return bestPractice
            ? "issue (blocking, best-practice)"
            : "issue (blocking)";
    }
    if (DOCUMENTATION_LENSES.has(finding.lens)) {
        return DOCUMENTATION_LABEL;
    }
    if (MAINTAINABILITY_LENSES.has(finding.lens)) {
        return MAINTAINABILITY_LABEL;
    }
    return bestPractice
        ? "suggestion (non-blocking, best-practice)"
        : "suggestion (non-blocking)";
};

/**
 * Split point for "the prose's first sentence": a sentence terminator
 * followed by whitespace. Owned here (the lowest rendering module) and
 * consumed by dispatch-contracts.ts's restatement drop and buildClaims'
 * subject recovery, which must agree with the renderer on what the first
 * sentence IS: the fold's visible line is the claim's `subject` up to
 * terminal punctuation (`ensureTerminalPunctuation` may append one period,
 * and does so identically on the joined prose's opening).
 */
export const FIRST_SENTENCE_SPLIT = /(?<=[.!?])\s/;

/** The prose's first sentence, whole prose when no terminator splits it. */
export const firstSentence = (prose: string): string =>
    prose.split(FIRST_SENTENCE_SPLIT, 1)[0] ?? prose;

/** Trailing closing quotes/brackets/emphasis, which may wrap a terminator. */
const stripClosers = (line: string): string =>
    line.trimEnd().replace(/["'`)\]*_]+$/, "");

/**
 * Ensure the fold's visible line ends in terminal punctuation. Subjects
 * arrive headline-style (the contract never asked for a period and the
 * models rarely supply one); the sentence break `joinProse` inserted
 * where the subject joins the discussion used to be the only repair, and
 * the visible line interpolated the subject verbatim, so agent-settings#105
 * posted "…never spawns on them" directly over a collapsed block and read
 * as a truncated comment. This helper is now the single rule: joinProse
 * calls it for the sentence break and the renderers call it for the
 * visible line, so the two stay byte-comparable by construction. The
 * core-strip (terminal punctuation may sit inside closing quotes/brackets/
 * emphasis) runs before the terminator test and the period lands after
 * the closers, so a trailing code span never breaks. A trailing `:`
 * or `;` counts as terminal here (matching the glue rule joinProse had, so
 * the joined prose never gets a period after a colon), and the fold layer
 * handles that shape instead: {@link shouldFoldContext} posts such a
 * comment flat, since a colon hand-off over a collapsed block is the
 * truncated look this helper exists to remove and a period would misstate
 * the author's sentence. Rendering-only:
 * `claim.subject` itself is untouched, so dedup's prefix-match semantics
 * never see the added period.
 */
export const ensureTerminalPunctuation = (line: string): string => {
    const trimmed = line.trimEnd();
    const core = stripClosers(trimmed);
    return /[.!?:;]$/.test(core) || trimmed === "" ? trimmed : `${trimmed}.`;
};

/**
 * Whether a visible line ends on a colon or semicolon (closers aside): a
 * hand-off into text that is not on the line. {@link shouldFoldContext}
 * refuses to fold such a summary, so the clause and what completes it
 * post together.
 */
export const endsInHandoff = (line: string): boolean =>
    /[:;]$/.test(stripClosers(line));

/**
 * The context fold (PR feedback on webapp#41843: a long comment front-loads
 * its whole mechanism; compressing it after the fact drops exactly the
 * detail a reader needs to check the claim). The posted shape becomes a
 * short visible summary (one sentence by default, the judge's soft cap,
 * not a hard renderer rule) plus one collapsed block carrying the full
 * prose, rule quote, sketch, and attribution, verbatim. The summary chip is
 * deliberately NOT attribution.ts's `review details`: stripFooters removes
 * that block wholesale before dedup-threads' text-similarity comparison,
 * and the context block's prose must stay comparable (only the wrapper
 * lines are stripped, see stripFooters).
 */
export const CONTEXT_FOLD_SUMMARY = "context";

/** The context fold's fixed opening line (stripFooters strips it by shape). */
export const CONTEXT_FOLD_OPEN = `<details><summary><sub>${CONTEXT_FOLD_SUMMARY}</sub></summary>`;

/**
 * The shortness threshold: prose under this never folds, it just posts as
 * today (a two-line comment behind an expando is pure friction). 200 chars
 * is roughly two sentences; code-owned, tuned by eye, not measured.
 */
export const CONTEXT_FOLD_MIN_CHARS = 200;

/**
 * Whether a summary/prose pair renders as the context fold. Requires a
 * summary that actually stands apart (prose equal to its own summary has
 * no context to fold) and prose past the shortness threshold.
 */
export const shouldFoldContext = (summary: string, prose: string): boolean =>
    summary.trim() !== "" &&
    // A multi-line summary defeats the stand-alone-visible-line goal. The
    // authored field is newline-rejected by the schema, but the
    // first-sentence fallback (every lens today) recovers a whole opening
    // block when the prose starts without a sentence terminator (a
    // heading, a bullet list), the same case the restatement drop refuses
    // (dispatch-contracts.ts).
    !summary.includes("\n") &&
    // A summary that hands off mid-thought on a colon or semicolon would
    // post as a hanging clause over the block, the truncated look the
    // punctuation repair exists to remove, and "repairing" it with a
    // period would misstate the author's sentence. Posting flat keeps
    // the clause and its completion together (PR #408 canary round 2).
    !endsInHandoff(summary) &&
    prose.trim() !== summary.trim() &&
    prose.trim().length >= CONTEXT_FOLD_MIN_CHARS &&
    // Model-authored text interpolates into the block unescaped (it is
    // markdown, so entity-escaping would corrupt code spans); a literal
    // closing tag anywhere in it, fenced or not, risks ending the block
    // early and desyncing stripFooters' unwrap, so such prose posts flat.
    // Escaping only the unfenced occurrences would need a markdown parse
    // this module deliberately does not have.
    !containsBlockClose(prose) &&
    !containsBlockClose(summary);

/**
 * Whether model-supplied text would end the context block early. Applied
 * to everything the renderers place INSIDE the block (prose, summary, rule
 * quote, sketch): one occurrence anywhere posts the comment flat.
 * Attribution is exempt by construction (attribution.ts HTML-escapes the
 * interpolated subjects).
 */
export const containsBlockClose = (text: string): boolean =>
    /<\/details>/i.test(text);

/**
 * Assemble the context fold: the visible `**label:** summary` line, then
 * one details block with the full prose and every inside-the-fold extra
 * (rule quote, sketch, attribution line), each separated by blank lines so
 * GitHub renders the markdown inside the HTML block. The prose restating
 * the visible line is fine by design: the fold reads self-contained.
 */
export const renderContextFold = (input: {
    label: string;
    summary: string;
    prose: string;
    insideFold?: readonly string[];
    outsideFold?: readonly string[];
}): string => {
    const inside = (input.insideFold ?? []).filter((block) => block !== "");
    const outside = (input.outsideFold ?? []).filter((block) => block !== "");
    return [
        `**${input.label}:** ${ensureTerminalPunctuation(input.summary)}`,
        [
            CONTEXT_FOLD_OPEN,
            "",
            input.prose,
            // Each inside block gets its own blank-line separation (the
            // join owns it; callers pass bare blocks) so GitHub renders
            // them as paragraphs, not soft-wrapped continuations.
            ...inside.flatMap((block) => ["", block]),
            "",
            "</details>",
        ].join("\n"),
        // Below the block, never between the summary and the block:
        // dedup-threads' threadProse reads a posted opener as everything
        // before the FIRST ``` fence, so a fence above the block would
        // hide the whole discussion from open-thread dedup (PR #401
        // review). The one-click apply still never collapses.
        ...outside,
    ].join("\n\n");
};

/**
 * Render a single finding as a Conventional-Comment body. Shape (per
 * conventionalcomments.org and `review.md` Step 5):
 *
 *     **<label>:** <model_authored_prose>
 *
 *     > **Rule:** <rule_quote>
 *
 *     ```suggestion
 *     <suggested_patch>
 *     ```
 *
 * When the prose clears the context-fold bar ({@link shouldFoldContext},
 * against the finding's `summary` or its first sentence), the body opens
 * with the visible summary line instead and the prose plus rule quote move
 * inside the collapsed block; a committable suggestion fence stays outside
 * the fold (the one-click apply must not hide).
 *
 * The label and the `**…:**` wrapping are code-owned; the prose after it is the
 * model's `model_authored_prose` copied verbatim (it already carries the subject
 * and any discussion). For a skill finding carrying a `rule_quote`, the exact
 * rule text is surfaced as a blockquote — quote-the-rule already puts it in
 * `evidence_trace`, but authors never see evidence traces, so the comment is
 * where the actual rule must appear (the quote itself is skill-file text copied
 * verbatim; only the `> **Rule:**` wrapping and the per-line `> ` prefixes that
 * keep a multi-line quote inside the blockquote are code-owned). The suggestion
 * block is appended only when the finding carries a `suggested_patch`, again
 * copied verbatim. No other text is emitted.
 */
export const renderComment = (finding: Finding): string => {
    const label = labelForFinding(finding);
    const summary =
        finding.summary ?? firstSentence(finding.model_authored_prose);

    if (
        shouldFoldContext(summary, finding.model_authored_prose) &&
        // The rule quote lands inside the block, so it gets the same
        // block-close guard the prose does.
        (finding.rule_quote === undefined ||
            !containsBlockClose(finding.rule_quote))
    ) {
        return renderContextFold({
            label,
            summary,
            prose: finding.model_authored_prose,
            insideFold:
                finding.rule_quote !== undefined
                    ? [renderRuleQuote(finding.rule_quote)]
                    : [],
            outsideFold:
                finding.suggested_patch !== undefined
                    ? [
                          [
                              "```suggestion",
                              finding.suggested_patch,
                              "```",
                          ].join("\n"),
                      ]
                    : [],
        });
    }

    const lines: string[] = [`**${label}:** ${finding.model_authored_prose}`];

    if (finding.rule_quote !== undefined) {
        lines.push("", renderRuleQuote(finding.rule_quote));
    }

    if (finding.suggested_patch !== undefined) {
        lines.push("", "```suggestion", finding.suggested_patch, "```");
    }

    return lines.join("\n");
};

/**
 * The `> **Rule:** …` blockquote: every line of the quote is prefixed so a
 * multi-line rule (including one with a blank line) stays inside a single
 * blockquote; an unprefixed line would escape it. Shared by both render
 * shapes and by renderClaimComment.
 */
export const renderRuleQuote = (quote: string): string => {
    const [first, ...rest] = quote.split("\n");
    return [
        `> **Rule:** ${first}`,
        ...rest.map((line) => (line === "" ? ">" : `> ${line}`)),
    ].join("\n");
};

/** A core/optional dimension that could not be assessed this run (#194 Step 6). */
export type SkippedDimension = {
    /** Human-facing dimension name, e.g. `correctness` or `claim validation`. */
    dimension: string;
    /** The sub-agent whose output was unavailable, e.g. `correctness-reviewer`. */
    subAgent: string;
};

/**
 * A policy-named conflict to surface in a hold-for-human body. Structurally
 * matches `verdict.ts`'s `PolicyConflict` (no import, to keep the import graph
 * one-directional). `detail` is model-authored text passed through verbatim.
 */
export type PolicyConflictNote = {
    policy: string;
    detail: string;
};

export type ReviewBodyInput = {
    /** The computed verdict event (from `verdict.ts`). */
    event: VerdictEvent;
    /** Whether any inline review comments were left this run. */
    hasInlineComments: boolean;
    /** Dimensions skipped this run; one note line is appended per entry. */
    skippedDimensions?: readonly SkippedDimension[];
    /** Policy conflicts behind a HOLD_FOR_HUMAN verdict; ignored otherwise. */
    policyConflicts?: readonly PolicyConflictNote[];
    /**
     * Count of pre-merge obligations surfaced this run (conditional
     * approval). When `> 0` on an `APPROVE`, the body states that approval is
     * conditional on the separately-posted pre-merge obligations comment
     * ({@link renderObligationsComment}). Ignored for non-`APPROVE` events — an
     * obligation only rides alongside an approval; a `REQUEST_CHANGES` /
     * `HOLD_FOR_HUMAN` already routes the change back to the author. Absent or
     * `0` leaves the APPROVE body exactly as #194 rendered it.
     */
    obligationCount?: number;
    /**
     * The code-rendered re-review accountability section
     * (`rereview.ts`'s `renderRereviewSection`), spliced verbatim between the
     * verdict head and the note lines. Empty or absent leaves the body exactly
     * as before — a first review has no prior threads to account for.
     */
    rereviewSection?: string;
};

/**
 * The HOLD_FOR_HUMAN verdict head. Exported (with {@link HOLD_UNSTUCK_LINES})
 * for the submission-plan CLI, which composes the hold's standalone PR comment
 * from the same fixed template text this renderer uses, so the two surfaces
 * cannot drift.
 */
export const HOLD_HEAD =
    "Holding for human review — the automated review could not " +
    "complete safely this run.";

/**
 * How the author of a held PR gets unstuck. Fixed template text (code-owned,
 * like the skipped-dimension note): a hold must never strand the author with a
 * verdict and no next action.
 */
export const HOLD_UNSTUCK_LINES = [
    "To get unstuck: push a new commit (or re-run the review workflow from the " +
        "Actions tab) to retry the failed pass, or ask a human to review this " +
        "PR manually. A hold means the automated review declined to approve on " +
        "a partial assessment; it does not mean changes are required.",
    "A maintainer can apply the `skip-ai-review` label to opt this PR out of " +
        "automated review.",
] as const;

/**
 * Render the review body for a verdict. Mirrors `review.md` Step 6 exactly for
 * APPROVE/REQUEST_CHANGES, and renders a self-explanatory hold-for-human body
 * for the third event.
 *
 * The body convention (matching `review.md`): on APPROVE with inline comments
 * the comments ARE the review, so the body stays empty; a REQUEST_CHANGES body
 * is always non-empty, because GitHub rejects the event with an empty body and
 * the safe-output flow posts the inline comments separately, so they do not
 * make the event non-empty. Additional body text appears for a comment-less
 * approval, for skipped-dimension notes (appended to every verdict, and
 * forming the entire body when the head is empty), and for HOLD_FOR_HUMAN,
 * which must always explain itself and how to proceed.
 */
export const renderReviewBody = (input: ReviewBodyInput): string => {
    let head: string;
    switch (input.event) {
        case "APPROVE": {
            const obligations = input.obligationCount ?? 0;
            if (obligations > 0) {
                // Conditional approval: the body must say the approval is
                // conditional on the separately-posted pre-merge obligations
                // comment. The count is code-computed; no prose about the code.
                head =
                    obligations === 1
                        ? "Approved with 1 pre-merge obligation — see the pre-merge obligations comment."
                        : `Approved with ${obligations} pre-merge obligations — see the pre-merge obligations comment.`;
            } else {
                // With inline comments, the comments make the review non-empty;
                // the one-line body exists only to keep a comment-less approval
                // submittable.
                head = input.hasInlineComments
                    ? ""
                    : "Approved — no blocking issues found.";
            }
            break;
        }
        case "REQUEST_CHANGES":
            // GitHub rejects a REQUEST_CHANGES review event with an empty
            // body, and the inline comments post separately, so they never
            // make the event non-empty: the pointer line is unconditional.
            head = "Changes requested — see inline comments.";
            break;
        case "COMMENT":
            // The middle verdict never has an empty body either: the head is
            // what tells an author this is deliberately not an approval.
            head =
                "Commented — medium-importance findings found; nothing blocks.";
            break;
        case "HOLD_FOR_HUMAN":
            head = HOLD_HEAD;
            break;
        default: {
            // Exhaustiveness guard: a new VerdictEvent must add a body branch.
            const unreachable: never = input.event;
            throw new Error(`Unhandled verdict event: ${String(unreachable)}`);
        }
    }

    const notes = (input.skippedDimensions ?? []).map(
        ({dimension, subAgent}) =>
            `Note: ${dimension} not assessed this run (${subAgent} output unavailable).`,
    );

    const lines = [head, input.rereviewSection ?? "", ...notes];

    if (input.event === "HOLD_FOR_HUMAN") {
        lines.push(
            ...(input.policyConflicts ?? []).map(
                ({policy, detail}) => `Policy conflict (${policy}): ${detail}`,
            ),
            ...HOLD_UNSTUCK_LINES,
        );
    }

    return lines.filter((line) => line !== "").join("\n");
};

/* -------------------------------------------------------------------------- */
/* Conditional-approval (pre-merge obligations) comment                  */
/* -------------------------------------------------------------------------- */

/**
 * A code-owned, structural description of where a finding is anchored — a
 * location token (`path:line`, a `path:start-end` range, a bare `path`, or the
 * literal `PR-level`), never a sentence about the code. Used to head each
 * obligation line so a human can jump to the relevant spot.
 */
const describeAnchor = (anchor: Anchor): string => {
    switch (anchor.type) {
        case "line":
            return anchor.start_line !== undefined
                ? `${anchor.path}:${anchor.start_line}-${anchor.line}`
                : `${anchor.path}:${anchor.line}`;
        case "file":
            return anchor.path;
        case "pr":
            return "PR-level";
        default: {
            const unreachable: never = anchor;
            throw new Error(`Unhandled anchor type: ${String(unreachable)}`);
        }
    }
};

/** The code-owned heading of the pre-merge obligations comment. */
export const OBLIGATIONS_COMMENT_HEADING = "## ⚠️ Pre-merge obligations";

/**
 * Render the prominent, structured *pre-merge obligations* comment for a
 * conditional approval (APPROVE-with-obligations). Posted as a standalone PR
 * comment via the existing `add-comment` safe output (not an inline review
 * comment, and not the review body), so it stays visible after the APPROVE.
 *
 * This is squarely on the determinism boundary, exactly like {@link renderComment}:
 * CODE owns the heading, the intro line, and the `- [ ]` checklist wrapping plus
 * each finding's location token; the MODEL owns every human-read sentence — the
 * obligation text is the finding's `pre_merge_obligation`, copied verbatim. No
 * prose is synthesised here.
 *
 * Renders one checkbox per finding that carries a non-empty `pre_merge_obligation`,
 * in the order given (callers pass findings in a deterministic order). Returns
 * `null` when no finding carries an obligation — the caller then posts nothing and
 * leaves the plain APPROVE untouched (the count it feeds to {@link renderReviewBody}
 * is likewise `0`). The count for the review body is simply the length of the
 * filtered set, exposed via {@link countObligations} so the two stay in lockstep.
 */
export const renderObligationsComment = (
    findings: readonly Finding[],
): string | null => {
    const withObligations = findings.filter(
        (finding): finding is Finding & {pre_merge_obligation: string} =>
            finding.pre_merge_obligation !== undefined &&
            finding.pre_merge_obligation.length > 0,
    );
    if (withObligations.length === 0) {
        return null;
    }

    const items = withObligations.map(
        // `pre_merge_obligation` is model-authored and copied verbatim.
        (finding) =>
            `- [ ] **${describeAnchor(finding.anchor)}** — ${
                finding.pre_merge_obligation
            }`,
    );

    return [
        OBLIGATIONS_COMMENT_HEADING,
        "",
        "This PR is **approved**, but the following must be completed before it is merged:",
        "",
        ...items,
    ].join("\n");
};

/**
 * Count of findings that carry a pre-merge obligation — the value to pass as
 * {@link ReviewBodyInput.obligationCount}. Kept as a named helper so the review
 * body's count and {@link renderObligationsComment}'s checklist are derived from
 * the identical predicate and can never disagree.
 */
export const countObligations = (findings: readonly Finding[]): number =>
    findings.reduce(
        (count, finding) =>
            finding.pre_merge_obligation !== undefined &&
            finding.pre_merge_obligation.length > 0
                ? count + 1
                : count,
        0,
    );
