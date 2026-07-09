/**
 * Live operational counters, mined from the per-run JSON artifacts #194
 * already persists plus the run summary the workflow already writes.
 *
 * This adds **no new logging mechanism**: every counter is a
 * pure aggregation over data that exists on disk after a review run —
 *
 *   - `out/<lens>.json`, `out/claim-validator.json` and `claims.json` (#194's
 *     per-run sub-agent artifacts, `review.md` Step 9) -> validator drop rate per
 *     source;
 *   - the run summary (verdict, posted-comment count, model cost) -> comments/PR,
 *     verdict mix, cost/run;
 *   - the thumbs reactions the thumbs sweep collects -> thumbs agree rate.
 *
 * The module is split into a pure core and a thin, best-effort filesystem
 * loader. The core ({@link computeRunCounters}, {@link normalizeRunArtifacts})
 * takes already-parsed data and is fully deterministic — no clock, no I/O, no
 * randomness — so it is unit-testable against fixtures. The loader
 * ({@link readRunArtifactsFromDir}) is the only part that touches disk and is
 * deliberately forgiving: a missing or malformed artifact degrades a single
 * counter to "unknown" rather than throwing, because these counters run over
 * historical runs where an old artifact layout is expected.
 *
 * Determinism boundary: this module authors no prose. Every string
 * it emits or consumes is a source name, a verdict token, or a numeric metric;
 * it never composes a sentence about code under review.
 */

import {readFileSync} from "node:fs";
import {join} from "node:path";

import type {VerdictEvent} from "./render-comment";

/* -------------------------------------------------------------------------- */
/* Parsed per-run inputs                                                       */
/* -------------------------------------------------------------------------- */

/** A single `claim-validator` decision, joined to the source that authored it. */
export type ValidatorDecision = {
    /**
     * The reviewer/lens that authored the claim — the `source` field on the
     * `claims.json` entry (a specialist lens name, `correctness`, or an always-on
     * reviewer like `holistic`). Kept as a free string, not the `Lens` union,
     * because the always-on reviewers are valid sources but are not lenses.
     */
    source: string;
    /** The validator's verdict: `keep` (posted) or `drop` (false positive). */
    decision: "keep" | "drop";
};

/** Thumbs reactions collected on a run's comments (thumbs sweep). */
export type ThumbsTally = {
    /** 👍 count — a human agreed with the bot's comment. */
    up: number;
    /** 👎 count — a human disagreed. */
    down: number;
};

/** Model cost/usage for a run, mined from the run log / summary when present. */
export type RunCost = {
    /** Dollar cost of the run, when the log records it. */
    usd?: number;
    /** Total model tokens for the run, when the log records it. */
    tokens?: number;
};

/** One review run's already-parsed, counter-relevant data. */
export type RunArtifacts = {
    /** Stable identifier for the run (workflow run id, or the artifact dir name). */
    runId: string;
    /** The computed verdict event for the run. */
    verdict: VerdictEvent;
    /** Number of comments actually posted this run (inline + PR-level). */
    postedCommentCount: number;
    /** Per-source `claim-validator` decisions for the run. */
    validatorDecisions: readonly ValidatorDecision[];
    /** Thumbs reactions collected for the run's comments (absent if none). */
    thumbs?: ThumbsTally;
    /** Model cost/usage for the run (absent when the log has none). */
    cost?: RunCost;
    /**
     * The re-review depth the run executed (`rereview-plan.json`:
     * `full`/`scoped`/`flip-gated`/`fast`; absent for a run that predates the
     * mode dial). This is what lets the cost counters price the dial: the
     * runs-per-PR lever is judged in dollars per depth, not per run.
     */
    rereviewDepth?: string;
};

/* -------------------------------------------------------------------------- */
/* Computed counters                                                          */
/* -------------------------------------------------------------------------- */

/** Validator drop rate for one source across the aggregated window. */
export type SourceDropRate = {
    source: string;
    /** Claims from this source that the validator judged. */
    total: number;
    /** Of those, how many it dropped as false positives. */
    dropped: number;
    /** `dropped / total`, or `0` when `total === 0`. */
    dropRate: number;
};

/** Count of runs that ended in each verdict event. */
export type VerdictMix = Record<VerdictEvent, number>;

/** Thumbs agreement across the window. */
export type ThumbsCounter = {
    up: number;
    down: number;
    /** `up / (up + down)`, or `null` when no thumbs were collected. */
    agreeRate: number | null;
};

/** Cost across the window; each field is `null` when no run reported it. */
export type CostCounter = {
    totalUsd: number | null;
    totalTokens: number | null;
    usdPerRun: number | null;
    tokensPerRun: number | null;
};

/**
 * Cost per executed re-review depth: the measurement surface for the
 * re-review mode dial (price `scoped` against `full` in dollars; recall is
 * the eval suite's half). Runs that recorded no depth (older reviewer
 * versions) are grouped under `unrecorded` so the window still adds up.
 */
export type DepthCostCounter = {
    depth: string;
    runs: number;
    totalUsd: number | null;
    usdPerRun: number | null;
};

/** The full set of live counters over a window of runs. */
export type RunCounters = {
    /** Number of runs aggregated. */
    runCount: number;
    /** Validator drop rate per source, sorted by `source` for determinism. */
    validatorDropBySource: SourceDropRate[];
    /** Validator drop rate pooled across every source. */
    overallValidatorDropRate: number;
    /** Mean posted comments per run (`totalComments / runCount`, `0` for none). */
    commentsPerRun: number;
    /** Total posted comments across the window. */
    totalComments: number;
    /** Verdict-event histogram; every event key is present (0 when unseen). */
    verdictMix: VerdictMix;
    /** Thumbs agreement across the window. */
    thumbs: ThumbsCounter;
    /** Cost across the window. */
    cost: CostCounter;
    /** Cost grouped by executed re-review depth, sorted by `depth`. */
    costByRereviewDepth: DepthCostCounter[];
};

/** A fresh verdict histogram with every event key initialised to `0`. */
export const emptyVerdictMix = (): VerdictMix => ({
    APPROVE: 0,
    REQUEST_CHANGES: 0,
    HOLD_FOR_HUMAN: 0,
});

/**
 * Compute the live counters over a window of runs. Pure: identical input always
 * yields identical output.
 *
 * `dropRate` and `agreeRate` guard against division by zero (a source with no
 * judged claims reports `0`; a window with no thumbs reports `agreeRate: null`,
 * distinguishing "nobody reacted" from "everybody disagreed"). Cost fields are
 * `null` unless at least one run reported that dimension, so an all-unknown-cost
 * window is not silently reported as `$0`.
 */
export const computeRunCounters = (
    runs: readonly RunArtifacts[],
): RunCounters => {
    const runCount = runs.length;

    // Validator drop rate per source.
    const perSource = new Map<string, {total: number; dropped: number}>();
    for (const run of runs) {
        for (const {source, decision} of run.validatorDecisions) {
            const entry = perSource.get(source) ?? {total: 0, dropped: 0};
            entry.total += 1;
            if (decision === "drop") {
                entry.dropped += 1;
            }
            perSource.set(source, entry);
        }
    }
    const validatorDropBySource: SourceDropRate[] = [...perSource.entries()]
        .map(([source, {total, dropped}]) => ({
            source,
            total,
            dropped,
            dropRate: total === 0 ? 0 : dropped / total,
        }))
        .sort((a, b) =>
            a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
        );

    const totalJudged = validatorDropBySource.reduce(
        (sum, s) => sum + s.total,
        0,
    );
    const totalDropped = validatorDropBySource.reduce(
        (sum, s) => sum + s.dropped,
        0,
    );
    const overallValidatorDropRate =
        totalJudged === 0 ? 0 : totalDropped / totalJudged;

    // Comments per run.
    const totalComments = runs.reduce(
        (sum, run) => sum + run.postedCommentCount,
        0,
    );
    const commentsPerRun = runCount === 0 ? 0 : totalComments / runCount;

    // Verdict mix.
    const verdictMix = emptyVerdictMix();
    for (const run of runs) {
        verdictMix[run.verdict] += 1;
    }

    // Thumbs agree rate.
    let up = 0;
    let down = 0;
    for (const run of runs) {
        if (run.thumbs) {
            up += run.thumbs.up;
            down += run.thumbs.down;
        }
    }
    const totalThumbs = up + down;
    const thumbs: ThumbsCounter = {
        up,
        down,
        agreeRate: totalThumbs === 0 ? null : up / totalThumbs,
    };

    // Cost — track presence per dimension so "unknown" is not reported as 0.
    let usdSum = 0;
    let usdSeen = false;
    let tokensSum = 0;
    let tokensSeen = false;
    for (const run of runs) {
        if (run.cost?.usd !== undefined) {
            usdSum += run.cost.usd;
            usdSeen = true;
        }
        if (run.cost?.tokens !== undefined) {
            tokensSum += run.cost.tokens;
            tokensSeen = true;
        }
    }
    const cost: CostCounter = {
        totalUsd: usdSeen ? usdSum : null,
        totalTokens: tokensSeen ? tokensSum : null,
        usdPerRun: usdSeen && runCount > 0 ? usdSum / runCount : null,
        tokensPerRun: tokensSeen && runCount > 0 ? tokensSum / runCount : null,
    };

    // Cost per executed re-review depth (the mode-dial pricing surface).
    const perDepth = new Map<
        string,
        {runs: number; usdSum: number; usdSeen: boolean}
    >();
    for (const run of runs) {
        const depth = run.rereviewDepth ?? "unrecorded";
        const entry = perDepth.get(depth) ?? {
            runs: 0,
            usdSum: 0,
            usdSeen: false,
        };
        entry.runs += 1;
        if (run.cost?.usd !== undefined) {
            entry.usdSum += run.cost.usd;
            entry.usdSeen = true;
        }
        perDepth.set(depth, entry);
    }
    const costByRereviewDepth: DepthCostCounter[] = [...perDepth.entries()]
        .map(([depth, entry]) => ({
            depth,
            runs: entry.runs,
            totalUsd: entry.usdSeen ? entry.usdSum : null,
            usdPerRun:
                entry.usdSeen && entry.runs > 0
                    ? entry.usdSum / entry.runs
                    : null,
        }))
        .sort((a, b) => (a.depth < b.depth ? -1 : a.depth > b.depth ? 1 : 0));

    return {
        runCount,
        validatorDropBySource,
        overallValidatorDropRate,
        commentsPerRun,
        totalComments,
        verdictMix,
        thumbs,
        cost,
        costByRereviewDepth,
    };
};

/* -------------------------------------------------------------------------- */
/* Normalisation from loosely-typed artifact JSON                             */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asFiniteNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isVerdictEvent = (value: unknown): value is VerdictEvent =>
    value === "APPROVE" ||
    value === "REQUEST_CHANGES" ||
    value === "HOLD_FOR_HUMAN";

/**
 * The loosely-typed shapes as parsed straight from the on-disk artifacts. Every
 * field is optional/unknown because the artifacts are authored by sub-agents (or
 * an older reviewer version) and must be validated before use.
 */
export type RawRunArtifacts = {
    runId?: unknown;
    /** `claims.json`: each entry carries at least `id` and `source`. */
    claims?: unknown;
    /**
     * `out/claim-validator.json`: per-claim `keep`/`drop` verdicts. Accepts a
     * bare array or an object with a `results`/`decisions` array; each entry
     * carries an `id` and a `verdict` (`keep`/`drop`).
     */
    validator?: unknown;
    /** The run summary: verdict, posted-comment count, thumbs, cost. */
    summary?: unknown;
    /** `out/rereview-plan.json`: the executed re-review plan (mode dial). */
    rereviewPlan?: unknown;
};

const extractValidatorEntries = (validator: unknown): unknown[] => {
    if (Array.isArray(validator)) {
        return validator;
    }
    if (isRecord(validator)) {
        if (Array.isArray(validator["results"])) {
            return validator["results"];
        }
        if (Array.isArray(validator["decisions"])) {
            return validator["decisions"];
        }
    }
    return [];
};

/**
 * Join `claims.json` (id -> source) with `claim-validator.json` (id -> verdict)
 * into per-source {@link ValidatorDecision}s. A validator entry whose `id` has no
 * matching claim, or whose verdict is neither `keep` nor `drop`, is skipped — a
 * malformed artifact drops a data point rather than corrupting the counter.
 */
export const joinValidatorDecisions = (
    claims: unknown,
    validator: unknown,
): ValidatorDecision[] => {
    const sourceById = new Map<string, string>();
    if (Array.isArray(claims)) {
        for (const claim of claims) {
            if (
                isRecord(claim) &&
                typeof claim["id"] === "string" &&
                typeof claim["source"] === "string"
            ) {
                sourceById.set(claim["id"], claim["source"]);
            }
        }
    }

    const decisions: ValidatorDecision[] = [];
    for (const entry of extractValidatorEntries(validator)) {
        if (!isRecord(entry)) {
            continue;
        }
        const id = entry["id"];
        const verdict = entry["verdict"];
        if (typeof id !== "string") {
            continue;
        }
        if (verdict !== "keep" && verdict !== "drop") {
            continue;
        }
        const source = sourceById.get(id);
        if (source === undefined) {
            continue;
        }
        decisions.push({source, decision: verdict});
    }
    return decisions;
};

const normalizeThumbs = (
    summary: Record<string, unknown>,
): ThumbsTally | undefined => {
    const thumbs = summary["thumbs"];
    if (!isRecord(thumbs)) {
        return undefined;
    }
    const up = asFiniteNumber(thumbs["up"]) ?? 0;
    const down = asFiniteNumber(thumbs["down"]) ?? 0;
    return {up, down};
};

const normalizeCost = (
    summary: Record<string, unknown>,
): RunCost | undefined => {
    const cost = summary["cost"];
    if (!isRecord(cost)) {
        return undefined;
    }
    const usd = asFiniteNumber(cost["usd"]);
    const tokens = asFiniteNumber(cost["tokens"]);
    if (usd === undefined && tokens === undefined) {
        return undefined;
    }
    // Build without assigning `undefined` (exactOptionalPropertyTypes).
    const result: RunCost = {};
    if (usd !== undefined) {
        result.usd = usd;
    }
    if (tokens !== undefined) {
        result.tokens = tokens;
    }
    return result;
};

/**
 * Coerce loosely-typed parsed artifact JSON into a strict {@link RunArtifacts}.
 * `fallbackRunId` is used when the artifacts carry no run id (e.g. the artifact
 * directory name). A run whose summary has no recognisable verdict defaults to
 * `HOLD_FOR_HUMAN` — the safe verdict to attribute to an inscrutable run, so a
 * broken artifact never inflates the APPROVE count.
 */
export const normalizeRunArtifacts = (
    raw: RawRunArtifacts,
    fallbackRunId: string,
): RunArtifacts => {
    const summary: Record<string, unknown> = isRecord(raw.summary)
        ? raw.summary
        : {};

    const summaryRunId = summary["runId"];
    const runId =
        typeof raw.runId === "string" && raw.runId.length > 0
            ? raw.runId
            : typeof summaryRunId === "string" && summaryRunId.length > 0
            ? summaryRunId
            : fallbackRunId;

    const rawVerdict = summary["verdict"];
    const verdict: VerdictEvent = isVerdictEvent(rawVerdict)
        ? rawVerdict
        : "HOLD_FOR_HUMAN";

    const postedCommentCount =
        asFiniteNumber(summary["postedCommentCount"]) ?? 0;

    const validatorDecisions = joinValidatorDecisions(
        raw.claims,
        raw.validator,
    );

    const thumbs = normalizeThumbs(summary);
    const cost = normalizeCost(summary);

    // The executed re-review depth: the staged plan artifact is
    // authoritative; a summary-recorded depth is the fallback for arms that
    // upload no plan. Any non-string (or missing) value leaves the field
    // absent, which the counters group as `unrecorded`.
    const planDepth = isRecord(raw.rereviewPlan)
        ? raw.rereviewPlan["depth"]
        : undefined;
    const summaryDepth = summary["rereviewDepth"];
    const rereviewDepth =
        typeof planDepth === "string" && planDepth.length > 0
            ? planDepth
            : typeof summaryDepth === "string" && summaryDepth.length > 0
            ? summaryDepth
            : undefined;

    const run: RunArtifacts = {
        runId,
        verdict,
        postedCommentCount,
        validatorDecisions,
    };
    if (thumbs !== undefined) {
        run.thumbs = thumbs;
    }
    if (cost !== undefined) {
        run.cost = cost;
    }
    if (rereviewDepth !== undefined) {
        run.rereviewDepth = rereviewDepth;
    }
    return run;
};

/* -------------------------------------------------------------------------- */
/* Best-effort filesystem loader                                              */
/* -------------------------------------------------------------------------- */

/** Filenames of the conventional per-run artifact layout the loader reads. */
export type RunArtifactLayout = {
    /** The `claims.json` file (id -> source), relative to the run dir. */
    claims: string;
    /** The `claim-validator.json` artifact, relative to the run dir. */
    validator: string;
    /** The run summary (verdict, comments, thumbs, cost), relative to the run dir. */
    summary: string;
    /** The executed re-review plan (mode dial), relative to the run dir. */
    rereviewPlan: string;
};

/**
 * The default layout, matching `review.md` Step 9: per-sub-agent JSON under
 * `out/` and the claims list at the run root. `summary.json` is the run-level
 * roll-up (verdict, posted-comment count, thumbs, cost) the workflow writes
 * alongside them; a run that predates it simply yields the fallback verdict and
 * zeroed comment/thumbs/cost dimensions.
 */
export const DEFAULT_RUN_ARTIFACT_LAYOUT: RunArtifactLayout = {
    claims: "claims.json",
    validator: "out/claim-validator.json",
    summary: "summary.json",
    rereviewPlan: "out/rereview-plan.json",
};

const readJsonIfPresent = (path: string): unknown => {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        // Missing or malformed artifact -> treat as absent. The normalisation
        // layer degrades the affected counter rather than failing the sweep.
        return undefined;
    }
};

/**
 * Load one run's {@link RunArtifacts} from its artifact directory, best-effort:
 * any file that is missing or unparseable is treated as absent and the affected
 * counter degrades (see {@link normalizeRunArtifacts}). `runId` defaults to the
 * directory path when the summary carries none.
 *
 * This is the only disk-touching function in the module; keep aggregation logic
 * in the pure core so it stays testable without a filesystem.
 */
export const readRunArtifactsFromDir = (
    dir: string,
    layout: RunArtifactLayout = DEFAULT_RUN_ARTIFACT_LAYOUT,
): RunArtifacts => {
    const raw: RawRunArtifacts = {
        claims: readJsonIfPresent(join(dir, layout.claims)),
        validator: readJsonIfPresent(join(dir, layout.validator)),
        summary: readJsonIfPresent(join(dir, layout.summary)),
        rereviewPlan: readJsonIfPresent(join(dir, layout.rereviewPlan)),
    };
    return normalizeRunArtifacts(raw, dir);
};
