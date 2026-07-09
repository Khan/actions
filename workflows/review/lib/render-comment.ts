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
 * mechanical events; `HOLD_FOR_HUMAN` is the third outcome (missing-core
 * dimension gate + policy-named conflicts). It is not a GitHub review event —
 * `review.md` only allows `[APPROVE, REQUEST_CHANGES]` — so the orchestrator
 * surfaces a hold by pulling in a human rather than auto-submitting an approval.
 *
 * Defined here (the rendering module) rather than in `verdict.ts` so the import
 * graph has a single direction (`verdict.ts` -> `render-comment.ts`) with no
 * cycle: rendering is the lower-level presentation vocabulary, verdict is the
 * policy computed on top of it.
 */
export type VerdictEvent = "APPROVE" | "REQUEST_CHANGES" | "HOLD_FOR_HUMAN";

/**
 * The Conventional-Comment labels that drive REQUEST_CHANGES under #194's
 * mechanical model. Consumed by `verdict.ts`; do not re-implement the rule.
 */
export const BLOCKING_LABELS = [
    "issue (blocking)",
    "issue (blocking, best-practice)",
    "todo (blocking)",
] as const;

/** Every other Conventional-Comment label; none of these block. */
export const NON_BLOCKING_LABELS = [
    "suggestion (non-blocking)",
    "suggestion (non-blocking, best-practice)",
    "nitpick (non-blocking)",
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
 * correctness labels. The finding schema deliberately keeps only a two-value
 * `severity` (blocking/advisory); the richer Conventional taxonomy is applied
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
 * The Conventional-Comment label a finding renders with. Deterministic function
 * of the finding's `severity` and `lens` only:
 *
 *   - blocking  + best-practice lens -> `issue (blocking, best-practice)`
 *   - blocking  + other lens         -> `issue (blocking)`
 *   - advisory  + best-practice lens -> `suggestion (non-blocking, best-practice)`
 *   - advisory  + other lens         -> `suggestion (non-blocking)`
 *
 * The finer labels a human reviewer might pick (`todo`, `nitpick`, `question`,
 * `thought`, `note`) are not expressible in the two-value schema, so lenses fold
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
    return bestPractice
        ? "suggestion (non-blocking, best-practice)"
        : "suggestion (non-blocking)";
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
 * The label and the `**…:**` wrapping are code-owned; the prose after it is the
 * model's `model_authored_prose` copied verbatim (it already carries the subject
 * and any discussion). For a skill finding carrying a `rule_quote`, the exact
 * rule text is surfaced as a blockquote — quote-the-rule already puts it in
 * `evidence_trace`, but authors never see evidence traces, so the comment is
 * where the actual rule must appear (the quote itself is skill-file text copied
 * verbatim; only the `> **Rule:**` wrapping is code-owned). The suggestion
 * block is appended only when the finding carries a `suggested_patch`, again
 * copied verbatim. No other text is emitted.
 */
export const renderComment = (finding: Finding): string => {
    const label = labelForFinding(finding);
    const lines: string[] = [`**${label}:** ${finding.model_authored_prose}`];

    if (finding.rule_quote !== undefined) {
        lines.push("", `> **Rule:** ${finding.rule_quote}`);
    }

    if (finding.suggested_patch !== undefined) {
        lines.push("", "```suggestion", finding.suggested_patch, "```");
    }

    return lines.join("\n");
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
 * How the author of a held PR gets unstuck. Fixed template text (code-owned,
 * like the skipped-dimension note): a hold must never strand the author with a
 * verdict and no next action.
 */
const HOLD_UNSTUCK_LINES = [
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
 * The body convention (matching `review.md`): when inline comments exist, the
 * comments ARE the review, so the body stays empty; GitHub requires a non-empty
 * body only when a review has no comments. A non-empty body therefore appears
 * only for a comment-less review, for skipped-dimension notes (appended to
 * every verdict, and forming the entire body when the head is empty), and for
 * HOLD_FOR_HUMAN, which must always explain itself and how to proceed.
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
            // A REQUEST_CHANGES verdict normally carries at least one blocking
            // inline comment (the verdict follows from the posted labels), so
            // its body is empty too; the pointer line covers only the
            // degenerate comment-less case.
            head = input.hasInlineComments
                ? ""
                : "Changes requested — see inline comments.";
            break;
        case "HOLD_FOR_HUMAN":
            head =
                "Holding for human review — the automated review could not " +
                "complete safely this run.";
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
