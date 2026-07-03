/**
 * R5 LLM-judge (task-11-3): an Opus-4.8 judge that scores the *quality* of the
 * comments a run posted, a human-audit sample surfaced from its output, and a
 * calibration pass against the slice-8 thumbs labels.
 *
 * Why a judge at all: the deterministic metrics (recall/precision/noise) score
 * whether the reviewer posted the *right findings* against corpus ground truth.
 * They cannot score whether a posted comment is *well-reasoned and useful* — that
 * is a judgement call, so a model makes it. The judge is the one place in the
 * eval suite that calls a model.
 *
 * This module is deliberately split into a PURE core and a thin model seam:
 *
 *   - Pure: build the per-finding {@link JudgeRequest}s from a run, aggregate
 *     {@link JudgeScore}s into a {@link JudgeReport}, select the audit sample,
 *     and calibrate against thumbs. All deterministic, all unit-testable with no
 *     model.
 *   - Seam: a caller injects a {@link JudgeModel} — an async fn that takes the
 *     requests and returns scores (the real one calls {@link PINNED_JUDGE_MODEL};
 *     tests inject a stub). Nothing here imports a model client.
 *
 * Note on the determinism boundary (analysis R8): the review-path lib modules
 * must not author prose about code. The judge is NOT on the review path — it runs
 * offline over the eval corpus — so a model authoring a `rationale` here is by
 * design, not a boundary violation. This module composes no prose itself; it
 * passes the judge's rationale through verbatim.
 */

import type {EvalRun} from "./run-types";

/** The pinned judge model — Opus 4.8, the workhorse (review.md model table). */
export const PINNED_JUDGE_MODEL = "claude-opus-4-8";

/* -------------------------------------------------------------------------- */
/* Request / score shapes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the judge is shown about one posted comment. Built purely from the run —
 * the case description (the PR under review), and the finding's label, prose, and
 * evidence trace. `groundTruthCatch` tells the aggregator whether the corpus
 * considered this a must-catch, so judge-vs-corpus disagreements can be found; it
 * is NOT sent to the model (the judge scores blind).
 */
export type JudgeRequest = {
    caseId: string;
    findingId: string;
    lens: string;
    label: string;
    /** The PR-under-review context (the case description). */
    context: string;
    /** The exact comment body the reviewer posted. */
    commentBody: string;
    /** The finding's evidence trace (why the lens believes the finding). */
    evidenceTrace: string[];
    /** Corpus ground truth: was this finding a must-catch? (aggregator only). */
    groundTruthCatch: boolean;
};

/** The judge's verdict on a single comment. */
export type JudgeVerdict = "good" | "borderline" | "bad";

/**
 * The judge's score for one comment. `quality` in [0,1] is the judge's overall
 * quality estimate; `rationale` is model-authored prose passed through verbatim.
 */
export type JudgeScore = {
    findingId: string;
    verdict: JudgeVerdict;
    quality: number;
    rationale: string;
};

/**
 * The model seam: takes the batch of requests, returns one score per request (by
 * `findingId`). Async because the real implementation calls
 * {@link PINNED_JUDGE_MODEL}. The pure core never constructs one of these.
 */
export type JudgeModel = (requests: JudgeRequest[]) => Promise<JudgeScore[]>;

/* -------------------------------------------------------------------------- */
/* Pure: build requests                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build one judge request per posted comment in a run. Only *posted* candidates
 * are judged — the judge scores what a human would actually see on the PR, not
 * findings the scope filter dropped.
 */
export const buildRequests = (run: EvalRun): JudgeRequest[] => {
    const mustCatch = new Set(run.corpusCase.expected.mustCatch ?? []);
    return run.result.postedCandidates.map((candidate) => ({
        caseId: run.corpusCase.id,
        findingId: candidate.id,
        lens: candidate.lens,
        label: candidate.label,
        context: run.corpusCase.description,
        commentBody: candidate.body,
        evidenceTrace: [...candidate.finding.evidence_trace],
        groundTruthCatch: mustCatch.has(candidate.id),
    }));
};

/** Build the flat request list across a whole corpus run (id-stable order). */
export const buildCorpusRequests = (runs: EvalRun[]): JudgeRequest[] =>
    runs.flatMap(buildRequests);

/* -------------------------------------------------------------------------- */
/* Pure: aggregate scores                                                     */
/* -------------------------------------------------------------------------- */

/** A judge score joined back to the request it scored (for disagreement checks). */
export type ScoredRequest = {
    request: JudgeRequest;
    score: JudgeScore;
};

export type JudgeReport = {
    scored: ScoredRequest[];
    /** Mean `quality` across all scored comments (0 when none). */
    meanQuality: number;
    /** Count by verdict. */
    verdictCounts: Record<JudgeVerdict, number>;
    /**
     * Judge-vs-corpus disagreements: a must-catch the judge called `bad`, or a
     * non-must-catch the judge called `good`. These are where the judge and the
     * deterministic ground truth conflict — the highest-value audit targets.
     */
    disagreements: ScoredRequest[];
};

const EMPTY_VERDICT_COUNTS = (): Record<JudgeVerdict, number> => ({
    good: 0,
    borderline: 0,
    bad: 0,
});

/**
 * Join scores to requests and summarise. Fails loudly rather than corrupt every
 * downstream number, on any of three join defects:
 *   - a request the model did not score (a silently-dropped comment);
 *   - a score for a `findingId` that matches no request (an extra/hallucinated
 *     score);
 *   - two requests sharing a `findingId` (the join is by bare `findingId`, which
 *     is only case-unique in the corpus schema — a collision would mis-join, so
 *     we reject it here instead of silently picking one).
 */
export const aggregate = (
    requests: JudgeRequest[],
    scores: JudgeScore[],
): JudgeReport => {
    const requestIds = new Set<string>();
    for (const request of requests) {
        if (requestIds.has(request.findingId)) {
            throw new Error(
                `Duplicate finding id "${request.findingId}" across judge requests: the score join is by finding id, which must be unique within a run`,
            );
        }
        requestIds.add(request.findingId);
    }

    const byId = new Map(scores.map((s) => [s.findingId, s]));
    for (const score of scores) {
        if (!requestIds.has(score.findingId)) {
            throw new Error(
                `Judge returned a score for unknown finding "${score.findingId}" (no matching request)`,
            );
        }
    }

    const scored: ScoredRequest[] = [];
    const verdictCounts = EMPTY_VERDICT_COUNTS();
    const disagreements: ScoredRequest[] = [];
    let qualitySum = 0;

    for (const request of requests) {
        const score = byId.get(request.findingId);
        if (score === undefined) {
            throw new Error(
                `Judge returned no score for finding "${request.findingId}" (case ${request.caseId})`,
            );
        }
        const entry: ScoredRequest = {request, score};
        scored.push(entry);
        verdictCounts[score.verdict] += 1;
        qualitySum += score.quality;
        const judgedGood = score.verdict === "good";
        const judgedBad = score.verdict === "bad";
        if (
            (request.groundTruthCatch && judgedBad) ||
            (!request.groundTruthCatch && judgedGood)
        ) {
            disagreements.push(entry);
        }
    }

    return {
        scored,
        meanQuality: scored.length === 0 ? 0 : qualitySum / scored.length,
        verdictCounts,
        disagreements,
    };
};

/* -------------------------------------------------------------------------- */
/* Human-audit sample                                                         */
/* -------------------------------------------------------------------------- */

/** Default number of comments surfaced for human audit each run. */
export const DEFAULT_AUDIT_SIZE = 10;

/**
 * Deterministically select the human-audit sample: every judge-vs-corpus
 * disagreement first (highest value), then every `borderline` verdict, then a
 * stable fill sampled by `findingId` sort — up to `size`. Deterministic (sorted,
 * no randomness) so the same run always surfaces the same sample and a human can
 * re-audit reproducibly. This is the task-11-3 "audit sample surfaced".
 */
export const selectAuditSample = (
    report: JudgeReport,
    size: number = DEFAULT_AUDIT_SIZE,
): ScoredRequest[] => {
    const chosen: ScoredRequest[] = [];
    const seen = new Set<string>();
    const key = (e: ScoredRequest): string =>
        `${e.request.caseId}:${e.request.findingId}`;

    const add = (entries: ScoredRequest[]): void => {
        for (const entry of entries) {
            if (chosen.length >= size) {
                return;
            }
            const k = key(entry);
            if (!seen.has(k)) {
                seen.add(k);
                chosen.push(entry);
            }
        }
    };

    const bySortedKey = (a: ScoredRequest, b: ScoredRequest): number =>
        key(a).localeCompare(key(b));

    add([...report.disagreements].sort(bySortedKey));
    add(
        report.scored
            .filter((e) => e.score.verdict === "borderline")
            .sort(bySortedKey),
    );
    add([...report.scored].sort(bySortedKey));
    return chosen;
};

/* -------------------------------------------------------------------------- */
/* Thumbs calibration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The fixed downvote-reason vocabulary the slice-8 thumbs sweep offers on a 👎.
 *
 * Declared locally rather than imported from `../lib/thumbs-sweep` on purpose:
 * the judge consumes thumbs labels as *data* (see {@link ThumbsLabel}) and never
 * needs the sweep module at build time, so importing its type would create a
 * cross-slice build dependency on slice-8 for a field this module only carries
 * through (calibration keys off `direction`, not `reason`). This union is
 * structurally identical to slice-8's `DownvoteReason`, so a value produced there
 * is assignable here and vice versa; keep the two in sync if the sweep's
 * vocabulary changes.
 */
export type DownvoteReason =
    | "incorrect"
    | "unimportant"
    | "unclear"
    | "duplicate";

/**
 * A human thumbs signal on a posted comment, mined by the slice-8 sweep. `up`
 * means 👍 (the human agreed with the comment), `down` means 👎 (disagreed);
 * `reason` is the sweep's fixed downvote vocabulary when the human gave one.
 */
export type ThumbsLabel = {
    findingId: string;
    direction: "up" | "down";
    reason?: DownvoteReason;
};

export type ThumbsCalibration = {
    /** Comments that carry BOTH a judge score and a thumbs label. */
    comparedCount: number;
    /**
     * Agreement rate: fraction where judge and human concur (judge `good` ↔ 👍,
     * judge `bad` ↔ 👎). `borderline` never counts as agreement or disagreement
     * on its own; it is excluded from the denominator. `null` when nothing
     * comparable overlapped.
     */
    agreementRate: number | null;
    /** The comments where judge and human conflict (judge good but 👎, or bad but 👍). */
    conflicts: {findingId: string; verdict: JudgeVerdict; direction: "up" | "down"}[];
};

/**
 * Calibrate the judge against human thumbs (slice 8). The thumbs are treated as
 * the human ground truth for *usefulness*; a judge that systematically disagrees
 * with 👎/👍 is mis-calibrated and its scores should be discounted. We only
 * compare comments the human actually reacted to, and only decisive judge
 * verdicts (`good`/`bad`) — `borderline` is neither agreement nor disagreement.
 */
export const calibrateAgainstThumbs = (
    report: JudgeReport,
    thumbs: ThumbsLabel[],
): ThumbsCalibration => {
    const thumbsById = new Map(thumbs.map((t) => [t.findingId, t]));
    let compared = 0;
    let agree = 0;
    const conflicts: ThumbsCalibration["conflicts"] = [];

    for (const entry of report.scored) {
        const label = thumbsById.get(entry.request.findingId);
        if (label === undefined || entry.score.verdict === "borderline") {
            continue;
        }
        compared += 1;
        const judgedGood = entry.score.verdict === "good";
        const humanUp = label.direction === "up";
        if (judgedGood === humanUp) {
            agree += 1;
        } else {
            conflicts.push({
                findingId: entry.request.findingId,
                verdict: entry.score.verdict,
                direction: label.direction,
            });
        }
    }

    return {
        comparedCount: compared,
        agreementRate: compared === 0 ? null : agree / compared,
        conflicts,
    };
};

/* -------------------------------------------------------------------------- */
/* Orchestration (the one async entry)                                        */
/* -------------------------------------------------------------------------- */

export type JudgeRunResult = {
    report: JudgeReport;
    auditSample: ScoredRequest[];
    /** Present only when thumbs labels were supplied. */
    thumbsCalibration?: ThumbsCalibration;
};

export type JudgeOptions = {
    auditSize?: number;
    /** Slice-8 thumbs labels to calibrate the judge against, when available. */
    thumbs?: ThumbsLabel[];
};

/**
 * Judge a whole corpus run end to end: build requests, call the injected model,
 * aggregate, select the audit sample, and (when thumbs are supplied) calibrate.
 * The only async step is the model call; everything else is pure.
 */
export const judgeCorpus = async (
    runs: EvalRun[],
    model: JudgeModel,
    options: JudgeOptions = {},
): Promise<JudgeRunResult> => {
    const requests = buildCorpusRequests(runs);
    const scores = await model(requests);
    const report = aggregate(requests, scores);
    const auditSample = selectAuditSample(report, options.auditSize);
    return {
        report,
        auditSample,
        ...(options.thumbs !== undefined
            ? {thumbsCalibration: calibrateAgainstThumbs(report, options.thumbs)}
            : {}),
    };
};
