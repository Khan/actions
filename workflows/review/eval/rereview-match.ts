/**
 * Scoring for re-review (open-PR) corpus cases: given the reconciler's
 * decision and the fresh findings a live run produced, score the three
 * behaviors a re-review can get wrong that a first review cannot:
 *
 *   1. **Resolution accuracy**: each staged prior thread carries ground
 *      truth (`expect: resolve|keep`); the reconciler's decision is scored
 *      per thread. A thread the reconciler never mentioned is `missing`
 *      (wrong for both expectations: an unaccounted thread is exactly the
 *      failure the accountability section exists for).
 *   2. **Kept-blocking correctness**: the count of kept threads whose
 *      opening label blocks, per ground truth vs. per the reconciler. This
 *      is the flip gate's input: getting it wrong flips an approval over an
 *      open objection (or wedges a resolved PR at REQUEST_CHANGES).
 *   3. **Duplicate suppression**: a fresh finding that re-raises a KEPT
 *      prior thread (same path, nearby line, and matching the thread's
 *      mechanism when it names one) is a duplicate comment: production
 *      dedups these against open threads, so a producer that re-raises them
 *      is noise the author sees twice.
 *
 * Fresh-defect recall on a re-review push is NOT scored here: the case's
 * ordinary `live.mustCatchSpecs` already cover it through `live-match`, so a
 * lifecycle push case gets both scores from the same run.
 *
 * Determinism boundary: pure functions of the case data and the run outputs;
 * no model call, no prose about the code under review.
 */

import {isBlockingLabel} from "../lib/render-comment";
import {parseLeadingLabel} from "../lib/rereview";
import type {CaseRereview, RereviewPriorThread} from "./corpus/loader";
import type {Finding} from "../lib/finding-schema";
import type {LiveReconciliation} from "./live-producer";

/** How far (in lines) a fresh finding may sit from a kept thread's anchor
 * and still count as re-raising it. */
export const DUP_LINE_WINDOW = 3;

export type ThreadResolutionScore = {
    key: string;
    expect: "resolve" | "keep";
    got: "resolve" | "keep" | "missing";
    correct: boolean;
};

export type RereviewCaseScore = {
    /** Per-thread reconciliation scoring, in case order. */
    resolutions: ThreadResolutionScore[];
    /** Correct resolutions / total prior threads (0 when no threads). */
    resolutionAccuracy: number;
    /** Kept-blocking count per ground truth (`expect: keep` + blocking). */
    expectedKeptBlockingCount: number;
    /** Kept-blocking count per the reconciler's actual decision. */
    actualKeptBlockingCount: number;
    /**
     * Whether the flip-gate input is right: the actual kept-blocking count
     * is zero exactly when the expected one is (the verdict only reads
     * "zero or not", so the flip flips correctly iff these agree).
     */
    flipGateCorrect: boolean;
    /** Ids of fresh findings that re-raise a kept prior thread. */
    duplicateFindingIds: string[];
};

const threadById = (
    threads: readonly RereviewPriorThread[],
): Map<string, RereviewPriorThread> => {
    const map = new Map<string, RereviewPriorThread>();
    for (const thread of threads) {
        map.set(`t-${thread.key}`, thread);
    }
    return map;
};

const isThreadBlocking = (thread: RereviewPriorThread): boolean => {
    const label = parseLeadingLabel(thread.body);
    return label !== null && isBlockingLabel(label);
};

/** Whether a fresh finding re-raises the given (kept) prior thread. */
const duplicatesThread = (
    finding: Finding,
    thread: RereviewPriorThread,
): boolean => {
    if (finding.anchor.type === "pr") {
        return false;
    }
    if (finding.anchor.path !== thread.path) {
        return false;
    }
    if (finding.anchor.type === "line" && thread.line !== null) {
        const start = finding.anchor.start_line ?? finding.anchor.line;
        const near =
            thread.line >= start - DUP_LINE_WINDOW &&
            thread.line <= finding.anchor.line + DUP_LINE_WINDOW;
        if (!near) {
            return false;
        }
    }
    if (thread.mechanism === undefined) {
        return true;
    }
    const text = `${finding.failure_scenario} ${finding.model_authored_prose}`;
    return thread.mechanism.some((alternate) => {
        try {
            return new RegExp(alternate, "i").test(text);
        } catch {
            return text.toLowerCase().includes(alternate.toLowerCase());
        }
    });
};

/**
 * Score one re-review case. `reconciliation` is absent when the reconciler
 * dispatch failed; every thread is then `missing` (a run that lost its
 * reconciler accounted for nothing).
 */
export const scoreRereview = (
    rereview: CaseRereview,
    reconciliation: LiveReconciliation | undefined,
    freshFindings: readonly Finding[],
): RereviewCaseScore => {
    const byId = threadById(rereview.priorThreads);
    const resolved = new Set(reconciliation?.resolve ?? []);
    const kept = new Set(reconciliation?.keep ?? []);

    const resolutions: ThreadResolutionScore[] = rereview.priorThreads.map(
        (thread) => {
            const id = `t-${thread.key}`;
            const got = resolved.has(id)
                ? "resolve"
                : kept.has(id)
                ? "keep"
                : "missing";
            return {
                key: thread.key,
                expect: thread.expect,
                got,
                correct: got === thread.expect,
            };
        },
    );
    const correct = resolutions.filter((r) => r.correct).length;

    const expectedKeptBlockingCount = rereview.priorThreads.filter(
        (thread) => thread.expect === "keep" && isThreadBlocking(thread),
    ).length;
    const actualKeptBlockingCount = [...kept]
        .map((id) => byId.get(id))
        .filter(
            (thread): thread is RereviewPriorThread =>
                thread !== undefined && isThreadBlocking(thread),
        ).length;

    const keptThreads = rereview.priorThreads.filter(
        (thread) => thread.expect === "keep",
    );
    const duplicateFindingIds = freshFindings
        .filter((finding) =>
            keptThreads.some((thread) => duplicatesThread(finding, thread)),
        )
        .map((finding) => finding.id);

    return {
        resolutions,
        resolutionAccuracy:
            resolutions.length === 0 ? 0 : correct / resolutions.length,
        expectedKeptBlockingCount,
        actualKeptBlockingCount,
        flipGateCorrect:
            (expectedKeptBlockingCount === 0) ===
            (actualKeptBlockingCount === 0),
        duplicateFindingIds,
    };
};

/** Aggregated re-review metrics over a window of scored cases. */
export type RereviewMetricsReport = {
    cases: number;
    threads: number;
    /** Correct thread resolutions / total threads across the window. */
    resolutionAccuracy: number;
    /** Cases whose flip-gate input was wrong (the expensive failure). */
    flipGateWrongCases: string[];
    /** Total duplicate comments across the window. */
    duplicateComments: number;
};

export const computeRereviewMetrics = (
    scored: readonly {caseId: string; score: RereviewCaseScore}[],
): RereviewMetricsReport => {
    let threads = 0;
    let correct = 0;
    let duplicateComments = 0;
    const flipGateWrongCases: string[] = [];
    for (const {caseId, score} of scored) {
        threads += score.resolutions.length;
        correct += score.resolutions.filter((r) => r.correct).length;
        duplicateComments += score.duplicateFindingIds.length;
        if (!score.flipGateCorrect) {
            flipGateWrongCases.push(caseId);
        }
    }
    return {
        cases: scored.length,
        threads,
        resolutionAccuracy: threads === 0 ? 0 : correct / threads,
        flipGateWrongCases,
        duplicateComments,
    };
};
