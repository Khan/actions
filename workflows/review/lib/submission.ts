/**
 * The submission plan (deterministic-orchestrator slice 4, the probe): Steps
 * 4-6 as code. Given the dispatcher's validated claims (slice 2), this CLI
 * computes the verdict, renders every inline comment and the full review
 * body (accountability section, note lines, fingerprint stamp), and stages
 * `submission-plan.json`; the orchestrator's remaining job is to emit safe
 * outputs that match the plan verbatim, and the dispatch-conformance gate
 * blocks a submission that does not (the #244 accountability-splice check,
 * as code).
 *
 * This is the end-state shape the migration plan names (the no-post runner's
 * pipeline in production): staging (slice 1) → dispatch/validation (slice 2)
 * → verdict/render/plan (here) → emit → gate. What remains model work is the
 * sub-agents themselves plus the safe-output EMISSION: under gh-aw, safe
 * outputs are queued through the engine's MCP tools, whose credentials never
 * enter the sandbox, so code cannot queue them directly. That emission seam
 * is the one piece only an upstream gh-aw change could delete (the plan
 * doc's Q1 scope note); until then the orchestrator is a typist for MCP
 * calls, and the gate makes mis-typing a red run.
 *
 * Verdict rules encoded (review.md Step 4, mechanically):
 *   - REQUEST_CHANGES iff at least one posted claim carries a blocking label
 *     (via computeVerdict, threshold 1).
 *   - The reduced-depth flip rule: at flip-gated/fast depth over a prior
 *     REQUEST_CHANGES stamp, `rereview.json`'s keptBlockingCount floors the
 *     verdict at REQUEST_CHANGES.
 *
 * Body rules encoded (review.md Step 6): the verdict head (empty-body
 * APPROVE with comments; the fixed REQUEST_CHANGES line), the code-rendered
 * accountability section spliced verbatim, one note line per shed / skipped
 * dimension / depth reduction (the dispatcher already rendered those), any
 * PR-level claims folded into the body (the inline-comment safe output needs
 * a path and line), and the hidden fingerprint stamp as the final line.
 *
 * Determinism boundary: pure composition of staged files through the same
 * lib functions the eval runner uses; no model call, no prose about the code
 * under review.
 */

import {computeRisksPatternsKey, RISKS_PATTERNS_KEY_PATH} from "./cache-record";
import type {Claim} from "./dispatch-contracts";
import {isBlockingLabel, renderReviewBody} from "./render-comment";
import {runRereviewCli, type RereviewCliFs} from "./rereview";
import {
    findLatestStamp,
    runRereviewStampCli,
    stampFromCacheMemory,
    type PriorReview,
} from "./rereview-mode";
import {computeVerdict} from "./verdict";

/* -------------------------------------------------------------------------- */
/* Types and paths                                                            */
/* -------------------------------------------------------------------------- */

const REVIEW_DIR = "/tmp/gh-aw/review";
const CACHE_MEMORY_DIR = "/tmp/gh-aw/cache-memory";

export type PlannedComment = {path: string; line: number; body: string};

export type SubmissionPlan = {
    /** The event to submit (Step 4's two-state rule; never HOLD here). */
    event: "APPROVE" | "REQUEST_CHANGES";
    /** The full review body, stamp included; submit verbatim. */
    body: string;
    /** The inline comments to post, one safe output each, verbatim. */
    comments: PlannedComment[];
    /** Thread ids to resolve (the reconciler's decision, passed through). */
    resolve: string[];
    /** Why the event is what it is (fixed-format, for the artifact). */
    reasons: string[];
    /** Non-blocking composition observations. */
    notes: string[];
};

export type SubmissionFs = RereviewCliFs;

const readJson = (fs: SubmissionFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/** The Step 9 cache record for this PR (pr number from pr-context.json). */
const readCacheMemoryRecord = (fs: SubmissionFs): unknown => {
    const prContext = readJson(fs, `${REVIEW_DIR}/pr-context.json`) as
        | {number?: unknown}
        | undefined;
    if (typeof prContext?.number !== "number") {
        return undefined;
    }
    return readJson(fs, `${CACHE_MEMORY_DIR}/pr-${prContext.number}.json`);
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many lines a committable suggestion may replace the anchored line
 * with; anything longer is a sketch, not a drop-in.
 */
const MAX_SUGGESTION_LINES = 8;

/**
 * At most this many inline comments post; the rest collapse (task mode's
 * Step 5 cap, as code). MUST match the frontmatter's
 * `create-pull-request-review-comment: max:` in review.md: the engine
 * rejects safe outputs past that number, and a plan the engine cannot fully
 * emit is a conformance-gate red after full spend.
 */
export const MAX_INLINE_COMMENTS = 20;

/** The medium-confidence inline floor (task mode's Step 5 posting bar). */
const MIN_INLINE_CONFIDENCE = 0.5;

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
 * Render one claim as its Conventional Comment (the renderComment layout,
 * driven by the claim's post-validation label rather than a recomputed one).
 * A suggestion only becomes a committable `suggestion` fence when it is
 * plausibly drop-in; otherwise it renders as a plain fenced sketch.
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
        } else {
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
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compose the submission plan from the staged dispatch result. Factored out
 * (fs injected) so it is testable without touching the real filesystem.
 * Writes `submission-plan.json` (and, via the rereview CLI it invokes,
 * `rereview.json`). Returns what was written.
 */
export const runSubmissionCli = (fs: SubmissionFs): SubmissionPlan => {
    const notes: string[] = [];
    const dispatch = readJson(fs, `${REVIEW_DIR}/dispatch-result.json`) as
        | {
              claims?: unknown;
              noteLines?: unknown;
              reconciliation?: {resolve?: unknown};
              depth?: unknown;
              threadSuppressions?: unknown;
              riskFiles?: unknown;
              patterns?: unknown;
              excludedFiles?: unknown;
          }
        | undefined;
    if (dispatch === undefined) {
        throw new Error(
            `dispatch-result.json not staged under ${REVIEW_DIR}: run the dispatcher first`,
        );
    }
    const claims = (
        Array.isArray(dispatch.claims) ? dispatch.claims : []
    ) as Claim[];
    const noteLines = Array.isArray(dispatch.noteLines)
        ? dispatch.noteLines.filter(
              (line): line is string => typeof line === "string",
          )
        : [];
    const depth = typeof dispatch.depth === "string" ? dispatch.depth : "full";

    // Stage the code-computed risks/patterns signature (trial suggestion b):
    // Step 7 compares THIS string against cache memory's `risksPatternsKey`
    // instead of composing its own, and the deterministic cache writer
    // (cache-record.ts) records the same string when the guidance comment
    // queues, so one code-owned format sits on both sides of the repost
    // decision.
    // Full depth only: Step 7 skips every reduced depth (`scoped` included),
    // so the existing comment stands and the key carries forward. A scoped
    // run DOES compute triage, but against the scoped subset; staging that
    // narrower signature could collapse the standing full-run guidance the
    // next time any comment queues.
    if (depth === "full") {
        const routing = readJson(fs, `${REVIEW_DIR}/routing.json`) as
            | {teams?: {owners?: unknown}}
            | undefined;
        fs.writeFileSync(
            RISKS_PATTERNS_KEY_PATH,
            computeRisksPatternsKey({
                riskFiles: dispatch.riskFiles,
                patterns: dispatch.patterns,
                excludedFiles: dispatch.excludedFiles,
                owners: routing?.teams?.owners,
            }),
        );
    }

    // The accountability section (renders and stages rereview.json too).
    const rereview = runRereviewCli(fs);

    // The reduced-depth flip floor (Step 4): only over a prior
    // REQUEST_CHANGES stamp at flip-gated/fast depth.
    let keptBlockingFloor = 0;
    if (depth === "flip-gated" || depth === "fast") {
        const priorRaw = readJson(fs, `${REVIEW_DIR}/prior-reviews.json`);
        const priors: PriorReview[] = Array.isArray(priorRaw)
            ? priorRaw.filter(
                  (entry): entry is PriorReview =>
                      typeof (entry as {body?: unknown}).body === "string",
              )
            : [];
        // Posted bodies never keep their stamp (the ingest sanitizer strips
        // HTML comments), so the floor anchors on the same cache-memory
        // carrier the plan CLI and gate rule 5 read.
        const stamp =
            findLatestStamp(priors) ??
            stampFromCacheMemory(readCacheMemoryRecord(fs));
        if (stamp !== null && stamp.verdict === "REQUEST_CHANGES") {
            keptBlockingFloor = rereview.keptBlockingCount;
        }
    }

    // Inline comments need a path and a line; a PR-level claim folds into
    // the body instead (rare: a pr-anchored finding).
    const anchored: Claim[] = [];
    const prLevelLines: string[] = [];
    for (const claim of claims) {
        if (claim.path !== undefined && claim.line !== undefined) {
            anchored.push(claim);
        } else {
            prLevelLines.push(`**${claim.label}:** ${claim.discussion}`);
            notes.push(
                `pr-level claim ${claim.id} folded into the review body`,
            );
        }
    }

    // The posting bar (task mode's Step 5 ranked bar, as code): rank
    // blocking before non-blocking, then confidence descending (the sort is
    // stable, so dispatch order breaks ties). A claim below medium
    // confidence (< 0.5) never posts inline (a blocking claim always
    // qualifies: it is validator-confirmed by construction), and at most
    // MAX_INLINE_COMMENTS post inline: the frontmatter caps the
    // create-pull-request-review-comment safe output at the same number, so
    // a longer plan would have the engine reject the overflow and the
    // conformance gate red the run after full spend. Everything else
    // collapses to one terse line each in a single <details> block riding
    // the highest-ranked inline comment (or the review body when nothing
    // posts inline), so it is surfaced without scattering noise. The
    // verdict is computed from ALL claims, so a collapsed blocking claim
    // (a 21st blocking finding) still blocks.
    const ranked = [...anchored].sort((a, b) => {
        const blocking =
            Number(isBlockingLabel(b.label)) - Number(isBlockingLabel(a.label));
        return blocking !== 0 ? blocking : b.confidence - a.confidence;
    });
    const inlineWorthy = ranked.filter(
        (claim) =>
            isBlockingLabel(claim.label) ||
            claim.confidence >= MIN_INLINE_CONFIDENCE,
    );
    const inlineClaims = new Set(inlineWorthy.slice(0, MAX_INLINE_COMMENTS));
    const collapsed = ranked.filter((claim) => !inlineClaims.has(claim));
    const inline: PlannedComment[] = [...inlineClaims].map((claim) => ({
        path: claim.path as string,
        line: claim.line as number,
        body: renderClaimComment(claim),
    }));
    if (collapsed.length > 0) {
        const section = [
            "<details>",
            `<summary>Lower-confidence observations (${collapsed.length})</summary>`,
            "",
            ...collapsed.map(
                (claim) =>
                    `- \`${claim.path}:${claim.line}\` ${claim.label}: ${claim.subject}`,
            ),
            "",
            "</details>",
        ].join("\n");
        if (inline.length > 0) {
            inline[0] = {...inline[0], body: `${inline[0].body}\n\n${section}`};
        } else {
            prLevelLines.push(section);
        }
        notes.push(
            `${collapsed.length} claim(s) collapsed below the inline bar (cap ${MAX_INLINE_COMMENTS}, medium-confidence floor)`,
        );
    }

    // A blocking candidate the dispatcher suppressed as a duplicate of a
    // still-open BLOCKING bot thread (trial suggestion g) blocks like a
    // fresh one: the reviewer re-confirmed the defect, and the open thread
    // is the actionable feedback. Without this floor, suppression could
    // flip the verdict to APPROVE over an unfixed blocking objection. Both
    // sides must be blocking: suppression happens before validation, so the
    // candidate's own label is unvalidated; the matched thread's opener
    // label is the severity that DID survive a prior run's validation. A
    // blocking candidate matching a non-blocking open thread therefore
    // never floors (it would force REQUEST_CHANGES with no validation and
    // no visible blocking comment). (A thread the reduced-depth floor above
    // already counted may add one more here; the verdict is the same either
    // way, only the reason count differs.)
    const suppressedBlocking = (
        Array.isArray(dispatch.threadSuppressions)
            ? dispatch.threadSuppressions
            : []
    ).filter(
        (entry) =>
            typeof (entry as {label?: unknown}).label === "string" &&
            isBlockingLabel((entry as {label: string}).label) &&
            (entry as {threadBlocking?: unknown}).threadBlocking === true,
    ).length;

    const verdict = computeVerdict({
        postedLabels: claims.map((claim) => claim.label),
        dimensions: {
            correctness: "assessed",
            skillSeverity: "assessed",
            patternTriage: "assessed",
        },
        keptBlockingCount: keptBlockingFloor + suppressedBlocking,
    });
    // With every dimension reported assessed (the dispatcher's unavailable
    // dimensions surface as note lines instead), the two-state Step 4 rule
    // is what remains: HOLD_FOR_HUMAN is unreachable here, and the guard
    // makes a future edit that feeds real dimension availability into
    // computeVerdict fail loudly instead of auto-approving a crashed run.
    if (verdict.event === "HOLD_FOR_HUMAN") {
        throw new Error(
            "HOLD_FOR_HUMAN reached the submission plan: dimension availability must not feed this CLI without a hold path",
        );
    }
    const event =
        verdict.event === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "APPROVE";

    // The depth note (Step 3), when the run reduced.
    const plan = readJson(fs, `${REVIEW_DIR}/rereview-plan.json`) as
        | {mode?: unknown; tripwireRearmed?: unknown; divergence?: unknown}
        | undefined;
    const depthNotes: string[] = [];
    if (plan !== undefined && depth !== "full") {
        const mode = typeof plan.mode === "string" ? plan.mode : "full";
        depthNotes.push(
            `Note: re-review ran at ${depth} depth (re-review mode ${mode}).`,
        );
    }
    if (plan?.tripwireRearmed === true) {
        const share = (
            plan.divergence as {unreviewedShare?: unknown} | undefined
        )?.unreviewedShare;
        depthNotes.push(
            `Note: divergence tripwire re-armed a full review (unreviewed share ${
                typeof share === "number" ? share.toFixed(2) : "unknown"
            }).`,
        );
    }

    const head = renderReviewBody({
        event,
        hasInlineComments: inline.length > 0,
        rereviewSection: rereview.section,
    });
    const stamp = runRereviewStampCli(fs, event);
    const body = [head, ...prLevelLines, ...noteLines, ...depthNotes]
        .filter((line) => line !== "")
        .join("\n")
        .concat(stamp === null ? "" : `\n${stamp}`)
        .replace(/^\n+/, "");

    const submission: SubmissionPlan = {
        event,
        body,
        comments: inline,
        resolve: Array.isArray(dispatch.reconciliation?.resolve)
            ? dispatch.reconciliation.resolve.filter(
                  (id): id is string => typeof id === "string",
              )
            : [],
        reasons: verdict.reasons,
        notes,
    };
    fs.writeFileSync(
        `${REVIEW_DIR}/submission-plan.json`,
        JSON.stringify(submission, null, 2),
    );
    return submission;
};

// Run only when executed directly (review.md Steps 4-6, scripted dispatch
// mode), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as SubmissionFs;
    try {
        const plan = runSubmissionCli(fs);
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify(
                {
                    event: plan.event,
                    comments: plan.comments.length,
                    resolve: plan.resolve.length,
                    reasons: plan.reasons,
                },
                null,
                2,
            ),
        );
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
            `::error title=review submission plan::${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        process.exit(1);
    }
}
