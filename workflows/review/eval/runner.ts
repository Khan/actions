/**
 * R5 shared eval runner (task-9-2) — a **no-post** run mode that exercises the
 * *real* review path over a corpus case and produces findings + a verdict
 * **without any GitHub write**.
 *
 * The determinism boundary (plan §8.6) is exactly the part of the review that is
 * code, and it is what this runner replays end to end using the production lib
 * modules — not a re-implementation:
 *
 *   1. `router.route`          — deterministic lens/team/tier routing + budget
 *   2. `labelForFinding`       — code-owned Conventional-Comment label per finding
 *   3. the newly-changed-code scope filter (review.md Step 3)
 *   4. `computeVerdict`        — the mechanical verdict (#194 labels + R2 gate)
 *   5. `renderComment` / `renderReviewBody` — templated, prose-free rendering
 *
 * The one part that is *not* deterministic in production — the model sub-agents
 * that author findings — is supplied by the corpus case as recorded findings, so
 * a smoke run is reproducible and needs no model or network. A future full-eval
 * arm can swap in a live producer via {@link RunOptions.produceFindings} while
 * keeping every downstream stage identical; that is what makes this "the real
 * review path" rather than a mock.
 *
 * **No GitHub write, structurally.** This module imports no GitHub client and
 * takes none. It returns the review it *would* submit — the event, body, and
 * inline comments — as plain data ({@link RunResult.plannedReview}); nothing is
 * posted. That is the task-9-2 guarantee and the property the slice-9 CI gate
 * (`.github-staging/review-smoke.yml`) relies on to run against real PRs' recorded
 * findings safely.
 */

import type {Anchor, Finding, Lens} from "../lib/finding-schema";
import {
    isBlockingLabel,
    labelForFinding,
    renderComment,
    renderReviewBody,
    type ConventionalLabel,
    type SkippedDimension,
    type VerdictEvent,
} from "../lib/render-comment";
import {route, type RoutingResult, type RouterConfig} from "../lib/router";
import {
    computeVerdict,
    type DimensionReport,
    type Verdict,
} from "../lib/verdict";
import {
    loadSmokeCorpus,
    type CaseDimensions,
    type CorpusCase,
    type RecordedFinding,
} from "./corpus/loader";

/* -------------------------------------------------------------------------- */
/* Result shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One normalised candidate comment — a recorded finding after the code-owned
 * label + anchor extraction (review.md Step 3 "normalize each lens finding into
 * a candidate comment"). Carries the rendered body so a caller can diff the
 * exact text that would be posted.
 */
export type RunCandidate = {
    /** The finding's stable id (dedup + must-catch correlation). */
    id: string;
    /** Producing reviewer/lens name (provenance). */
    source: string;
    /** The lens recorded on the finding. */
    lens: Lens;
    /** Code-computed Conventional-Comment label (never model-authored). */
    label: ConventionalLabel;
    /** Whether {@link label} is a blocking label (#194's mechanical signal). */
    blocking: boolean;
    /** Where the comment anchors (line / file / PR-level). */
    anchor: Anchor;
    /** Anchor path, when the anchor carries one (line/file anchors). */
    path?: string;
    /** Anchor line, when the anchor is a line anchor. */
    line?: number;
    /** The templated comment body (model prose + optional suggestion block). */
    body: string;
    /** The underlying validated finding. */
    finding: Finding;
};

/** The review the runner would submit — data only; nothing is posted. */
export type PlannedReview = {
    /**
     * The GitHub review event, or `null` for HOLD_FOR_HUMAN (not a GitHub
     * event: review.md only allows [APPROVE, REQUEST_CHANGES], so a hold is
     * surfaced by pulling in a human rather than auto-submitting).
     */
    event: "APPROVE" | "REQUEST_CHANGES" | null;
    /** The single-line review body (plus any skipped-dimension notes). */
    body: string;
    /** The inline/top-level comments that would be posted. */
    comments: {path?: string; line?: number; body: string}[];
};

export type RunResult = {
    caseId: string;
    /** Deterministic routing decision (lenses, teams, tiers, run budget). */
    routing: RoutingResult;
    /** Every recorded finding normalised to a candidate (pre-scope-filter). */
    allCandidates: RunCandidate[];
    /** Candidates that survive the newly-changed-code scope filter. */
    postedCandidates: RunCandidate[];
    /** Candidates dropped by the scope filter (out-of-scope, non-blocking). */
    droppedByScope: RunCandidate[];
    /** Labels on the posted set — the input to the mechanical verdict. */
    postedLabels: string[];
    /** The computed verdict (event + structured reasons). */
    verdict: Verdict;
    /** The review that would be submitted (no GitHub write performed). */
    plannedReview: PlannedReview;
    /** Always false — a witness that this run performed no GitHub post. */
    posted: false;
};

export type RunOptions = {
    /**
     * Optional live finding producer, for a full-eval arm that runs the real
     * model sub-agents. Given the case, it returns the recorded-finding list the
     * downstream stages consume. Defaults to the case's own `findings` (the
     * deterministic smoke path). It must not post to GitHub — the runner never
     * does and neither should a producer plugged in here.
     */
    produceFindings?: (corpusCase: CorpusCase) => RecordedFinding[];
    /**
     * Blocking-label threshold forwarded to {@link computeVerdict}. Defaults to
     * the module default (a single blocking label blocks).
     */
    blockingThreshold?: number;
};

/* -------------------------------------------------------------------------- */
/* Normalisation: recorded finding -> candidate                              */
/* -------------------------------------------------------------------------- */

const anchorPath = (anchor: Anchor): string | undefined =>
    anchor.type === "pr" ? undefined : anchor.path;

const anchorLine = (anchor: Anchor): number | undefined =>
    anchor.type === "line" ? anchor.line : undefined;

/**
 * Normalise one recorded finding to a candidate: compute the label in code
 * (never from the model), extract the anchor path/line, and render the body.
 * This is the same normalisation review.md Step 3 performs before a finding
 * flows through the scope filter / verdict / comment path.
 */
export const toCandidate = (recorded: RecordedFinding): RunCandidate => {
    const {finding, source} = recorded;
    const label = labelForFinding(finding);
    return {
        id: finding.id,
        source,
        lens: finding.lens,
        label,
        blocking: isBlockingLabel(label),
        anchor: finding.anchor,
        ...(anchorPath(finding.anchor) !== undefined
            ? {path: anchorPath(finding.anchor)}
            : {}),
        ...(anchorLine(finding.anchor) !== undefined
            ? {line: anchorLine(finding.anchor)}
            : {}),
        body: renderComment(finding),
        finding,
    };
};

/* -------------------------------------------------------------------------- */
/* Scope filter (review.md Step 3, "Scope the candidate comments")            */
/* -------------------------------------------------------------------------- */

/**
 * Apply the newly-changed-code scope filter. With no prior review (or no scope
 * on the case), every candidate is kept. Otherwise a line-anchored candidate is
 * dropped when its (path, line) is not in `inScope` — unless it is blocking, the
 * documented exception that keeps a genuine blocking bug even on unchanged
 * lines. File- and PR-level candidates are not line-scoped, so they are kept.
 */
export const applyScopeFilter = (
    candidates: RunCandidate[],
    scope: CorpusCase["scope"],
): {posted: RunCandidate[]; dropped: RunCandidate[]} => {
    if (scope === undefined || !scope.priorReview) {
        return {posted: [...candidates], dropped: []};
    }
    const posted: RunCandidate[] = [];
    const dropped: RunCandidate[] = [];
    for (const candidate of candidates) {
        if (candidate.anchor.type !== "line") {
            posted.push(candidate);
            continue;
        }
        const inScopeLines = scope.inScope[candidate.anchor.path] ?? [];
        const inScope = inScopeLines.includes(candidate.anchor.line);
        if (inScope || candidate.blocking) {
            posted.push(candidate);
        } else {
            dropped.push(candidate);
        }
    }
    return {posted, dropped};
};

/* -------------------------------------------------------------------------- */
/* Skipped-dimension notes                                                    */
/* -------------------------------------------------------------------------- */

const SKIPPED_DIMENSION_META: Record<keyof CaseDimensions, SkippedDimension> = {
    correctness: {dimension: "correctness", subAgent: "correctness-reviewer"},
    skillSeverity: {dimension: "skill/severity", subAgent: "specialist lenses"},
    patternTriage: {dimension: "pattern triage", subAgent: "pattern-triage"},
};

const skippedDimensions = (dims: CaseDimensions): SkippedDimension[] => {
    const skipped: SkippedDimension[] = [];
    (Object.keys(SKIPPED_DIMENSION_META) as (keyof CaseDimensions)[]).forEach(
        (key) => {
            if (dims[key] === "unavailable") {
                skipped.push(SKIPPED_DIMENSION_META[key]);
            }
        },
    );
    return skipped;
};

const toDimensionReport = (dims: CaseDimensions): DimensionReport => ({
    correctness: dims.correctness,
    skillSeverity: dims.skillSeverity,
    patternTriage: dims.patternTriage,
});

/** The GitHub review event for a verdict — null for the non-GitHub hold event. */
const submitEvent = (event: VerdictEvent): PlannedReview["event"] =>
    event === "HOLD_FOR_HUMAN" ? null : event;

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run one corpus case through the deterministic review path and return the
 * findings, verdict, and the review that *would* be submitted. Performs no
 * GitHub write and no network call: the only inputs are the case data and (for a
 * live arm) the injected producer.
 */
export const runCase = (
    corpusCase: CorpusCase,
    options: RunOptions = {},
): RunResult => {
    // 1. Deterministic routing over the changed files.
    const routerConfig: RouterConfig = {
        generatedPatterns: [],
        ...(corpusCase.routerConfig as Partial<RouterConfig>),
    };
    const routing = route({files: corpusCase.changedFiles}, routerConfig);

    // 2. Produce findings (recorded by default) and normalise to candidates.
    const recorded = (options.produceFindings ?? (() => corpusCase.findings))(
        corpusCase,
    );
    const allCandidates = recorded.map(toCandidate);

    // 3. Scope filter to newly-changed code.
    const {posted: postedCandidates, dropped: droppedByScope} =
        applyScopeFilter(allCandidates, corpusCase.scope);

    // 4. Mechanical verdict from the posted labels + dimension gate + conflicts.
    const postedLabels = postedCandidates.map((c) => c.label);
    const verdict = computeVerdict({
        postedLabels,
        dimensions: toDimensionReport(corpusCase.dimensions),
        policyConflicts: corpusCase.policyConflicts,
        ...(options.blockingThreshold !== undefined
            ? {blockingThreshold: options.blockingThreshold}
            : {}),
    });

    // 5. Render the review body + the comments that would be posted.
    const reviewBody = renderReviewBody({
        event: verdict.event,
        hasInlineComments: postedCandidates.length > 0,
        skippedDimensions: skippedDimensions(corpusCase.dimensions),
    });

    const plannedReview: PlannedReview = {
        event: submitEvent(verdict.event),
        body: reviewBody,
        comments: postedCandidates.map((c) => ({
            ...(c.path !== undefined ? {path: c.path} : {}),
            ...(c.line !== undefined ? {line: c.line} : {}),
            body: c.body,
        })),
    };

    return {
        caseId: corpusCase.id,
        routing,
        allCandidates,
        postedCandidates,
        droppedByScope,
        postedLabels,
        verdict,
        plannedReview,
        posted: false,
    };
};

/** Run every case in `cases`, preserving order. Purely in-memory, no posting. */
export const runCorpus = (
    cases: CorpusCase[],
    options: RunOptions = {},
): RunResult[] => cases.map((corpusCase) => runCase(corpusCase, options));

/**
 * Convenience: load the smoke subset from disk and run it. This is the entry the
 * slice-9 CI gate drives — it produces a verdict per smoke case with no GitHub
 * write. Returns each case paired with its result so a gate can compare against
 * `case.expected`.
 */
export const runSmokeCorpus = (
    options: RunOptions = {},
): {corpusCase: CorpusCase; result: RunResult}[] =>
    loadSmokeCorpus().map((corpusCase) => ({
        corpusCase,
        result: runCase(corpusCase, options),
    }));
