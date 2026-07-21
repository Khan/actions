/**
 * Finding-to-spec matching and live metrics (`live-ab-plan.md` Phase 3a).
 *
 * A live model run chooses its own finding ids, so the recorded-corpus
 * metrics (which correlate `expected.mustCatch` ids with posted ids) cannot
 * score it. Live-enabled cases instead carry labeled defect specs
 * (`live.mustCatchSpecs` / `live.mustNotFlagSpecs`: path, line window,
 * mechanism alternates), and this module maps a run's POSTED candidates onto
 * them:
 *
 *  - Deterministic first pass: a candidate matches a spec when its anchor
 *    agrees with the spec's path (and line window, when both carry one) AND
 *    any mechanism alternate matches the finding's `failure_scenario` or
 *    `model_authored_prose`, case-insensitively.
 *  - Judge fallback (injected, hard-capped): when a spec stays unmatched but
 *    posted candidates share its file, an async yes/no arbiter may claim the
 *    match. Fallback matches are recorded as such so a human can audit them.
 *
 * `computeLiveMetrics` then aggregates per-case matches into the live
 * analogues of the recorded suite's numbers: must-catch recall, clean
 * false-flag, noise, and verdict agreement.
 */

import type {CorpusCase, LiveDefectSpec} from "./corpus/loader";
import type {RunCandidate, RunResult} from "./runner";

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** How a spec got matched (deterministic pass or the judge fallback). */
export type MatchVia = "deterministic" | "fallback";

export type SpecMatch = {
    specKey: string;
    /** The posted candidate that satisfied the spec. */
    findingId: string;
    via: MatchVia;
};

/** The deterministic gate a produced-but-not-posted candidate died at. */
export type DroppedBucket = "provenance" | "scope" | "validation";

export type MissedSpecDetail = {
    specKey: string;
    /**
     * Set when the run PRODUCED a finding describing the spec's defect but a
     * deterministic gate dropped it before posting. A found-but-dropped miss
     * is a different defect class (anchoring discipline, gate calibration)
     * than a true miss (recall); they route to different fixes, so the
     * report must not collapse them.
     */
    droppedBy?: DroppedBucket;
    /** The dropped candidate that matched, when droppedBy is set. */
    findingId?: string;
};

export type CaseMatchReport = {
    caseId: string;
    /** mustCatchSpecs satisfied by a posted candidate. */
    caught: SpecMatch[];
    /** mustCatchSpecs no posted candidate satisfied. */
    missed: string[];
    /** Every missed spec, classified true-miss vs found-but-dropped. */
    missedDetail: MissedSpecDetail[];
    /** mustNotFlagSpecs a posted candidate satisfied (false flags). */
    falseFlags: SpecMatch[];
    /** Posted candidate ids that satisfied no spec (the noise numerator). */
    unmatchedFindingIds: string[];
    /** Number of posted candidates (the noise denominator contribution). */
    postedCount: number;
};

/**
 * The injected fallback arbiter: does `candidate` describe the defect `spec`
 * names? Used only for specs the deterministic pass left unmatched, and only
 * against candidates on the spec's file; call count is capped by the caller.
 */
export type MatchFallback = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
) => Promise<boolean>;

export type MatchOptions = {
    fallback?: MatchFallback;
    /** Cap on fallback calls per case (default 10). */
    maxFallbackCalls?: number;
};

const DEFAULT_MAX_FALLBACK_CALLS = 10;

/**
 * Every location a spec accepts: the primary path/window plus any
 * `altLocations` (a defect that spans files has more than one correct anchor
 * site; see the type's doc).
 */
const specLocations = (
    spec: LiveDefectSpec,
): {path: string; lineStart?: number; lineEnd?: number}[] => [
    {
        path: spec.path,
        ...(spec.lineStart !== undefined
            ? {lineStart: spec.lineStart, lineEnd: spec.lineEnd}
            : {}),
    },
    ...(spec.altLocations ?? []),
];

/** Whether a candidate shares a file with any of the spec's locations. */
const onSpecFile = (candidate: RunCandidate, spec: LiveDefectSpec): boolean =>
    specLocations(spec).some((location) => location.path === candidate.path);

/** Whether a candidate's anchor agrees with any of a spec's locations. */
const anchorAgrees = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
): boolean => {
    const anchor = candidate.anchor;
    if (anchor.type === "pr") {
        // A PR-level comment names no location; mechanism alone decides.
        return true;
    }
    return specLocations(spec).some((location) => {
        if (anchor.path !== location.path) {
            return false;
        }
        if (anchor.type === "file" || location.lineStart === undefined) {
            return true;
        }
        const start =
            anchor.type === "line" ? anchor.start_line ?? anchor.line : 0;
        const end = anchor.type === "line" ? anchor.line : 0;
        // Overlap between the anchor's line range and the location window.
        return (
            end >= location.lineStart &&
            start <= (location.lineEnd ?? location.lineStart)
        );
    });
};

/** Whether any mechanism alternate matches the finding's own description. */
const mechanismAgrees = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
): boolean => {
    const haystack = `${candidate.finding.failure_scenario}\n${candidate.finding.model_authored_prose}`;
    return spec.mechanism.some((alternate) => {
        try {
            return new RegExp(alternate, "i").test(haystack);
        } catch {
            // A malformed alternate falls back to a literal substring test
            // rather than crashing the eval.
            return haystack.toLowerCase().includes(alternate.toLowerCase());
        }
    });
};

/** The deterministic rule: location AND mechanism (AND severity, if pinned). */
export const matchesSpec = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
): boolean =>
    (spec.blockingOnly !== true || candidate.blocking) &&
    anchorAgrees(candidate, spec) &&
    mechanismAgrees(candidate, spec);

/**
 * Match one case's POSTED candidates against its live specs. Each posted
 * candidate satisfies at most one spec (first match in spec order), so one
 * comment cannot claim two defects; each spec is satisfied by at most one
 * candidate.
 */
export const matchCase = async (
    corpusCase: CorpusCase,
    result: RunResult,
    options: MatchOptions = {},
): Promise<CaseMatchReport> => {
    const mustCatch = corpusCase.live?.mustCatchSpecs ?? [];
    const mustNotFlag = corpusCase.live?.mustNotFlagSpecs ?? [];
    const maxFallbackCalls =
        options.maxFallbackCalls ?? DEFAULT_MAX_FALLBACK_CALLS;

    const posted = result.postedCandidates;
    const claimed = new Set<string>(); // candidate ids already used
    const caught: SpecMatch[] = [];
    const missed: string[] = [];
    const falseFlags: SpecMatch[] = [];
    let fallbackCalls = 0;

    const claim = async (
        spec: LiveDefectSpec,
    ): Promise<SpecMatch | undefined> => {
        for (const candidate of posted) {
            if (claimed.has(candidate.id)) {
                continue;
            }
            if (matchesSpec(candidate, spec)) {
                claimed.add(candidate.id);
                return {
                    specKey: spec.key,
                    findingId: candidate.id,
                    via: "deterministic",
                };
            }
        }
        if (options.fallback === undefined) {
            return undefined;
        }
        // Fallback: only candidates sharing a spec file, in posted order.
        for (const candidate of posted) {
            if (claimed.has(candidate.id) || !onSpecFile(candidate, spec)) {
                continue;
            }
            if (fallbackCalls >= maxFallbackCalls) {
                return undefined;
            }
            fallbackCalls += 1;
            if (await options.fallback(candidate, spec)) {
                claimed.add(candidate.id);
                return {
                    specKey: spec.key,
                    findingId: candidate.id,
                    via: "fallback",
                };
            }
        }
        return undefined;
    };

    for (const spec of mustCatch) {
        const match = await claim(spec);
        if (match === undefined) {
            missed.push(spec.key);
        } else {
            caught.push(match);
        }
    }

    // Classify each miss: did the run produce a matching finding that a
    // deterministic gate then dropped? Location is relaxed to the file (a
    // mis-anchored real finding is exactly the provenance-drop case this
    // exists to surface); mechanism still has to agree.
    const droppedBuckets: [DroppedBucket, RunCandidate[]][] = [
        ["provenance", result.droppedByProvenance],
        ["scope", result.droppedByScope],
        ["validation", result.droppedByValidation],
    ];
    const missedDetail = missed.map((specKey): MissedSpecDetail => {
        const spec = mustCatch.find((s) => s.key === specKey);
        if (spec === undefined) {
            return {specKey};
        }
        for (const [bucket, candidates] of droppedBuckets) {
            const hit = candidates.find(
                (candidate) =>
                    onSpecFile(candidate, spec) &&
                    mechanismAgrees(candidate, spec),
            );
            if (hit !== undefined) {
                return {specKey, droppedBy: bucket, findingId: hit.id};
            }
        }
        return {specKey};
    });
    // A false flag is a real posting failure; the deterministic rule alone
    // decides it (the fallback exists to rescue recall, not to indict).
    for (const spec of mustNotFlag) {
        for (const candidate of posted) {
            if (claimed.has(candidate.id)) {
                continue;
            }
            if (matchesSpec(candidate, spec)) {
                claimed.add(candidate.id);
                falseFlags.push({
                    specKey: spec.key,
                    findingId: candidate.id,
                    via: "deterministic",
                });
                break;
            }
        }
    }

    return {
        caseId: corpusCase.id,
        caught,
        missed,
        missedDetail,
        falseFlags,
        unmatchedFindingIds: posted
            .filter((candidate) => !claimed.has(candidate.id))
            .map((candidate) => candidate.id),
        postedCount: posted.length,
    };
};

/* -------------------------------------------------------------------------- */
/* Live metrics                                                               */
/* -------------------------------------------------------------------------- */

/** One arm's aggregated live numbers. */
export type LiveMetricsReport = {
    caseCount: number;
    /** Specs caught / specs labeled, across every case. */
    mustCatchRecall: {numerator: number; denominator: number; rate: number};
    /** Cases whose verdict equals the case's expected verdict. */
    verdictAgreement: {numerator: number; denominator: number; rate: number};
    /** must-not-flag specs matched, plus clean cases that blocked. */
    cleanFalseFlag: {count: number; details: string[]};
    /** Posted candidates matching no spec / posted candidates. */
    noise: {numerator: number; denominator: number; rate: number};
};

export type LiveCaseRun = {
    corpusCase: CorpusCase;
    result: RunResult;
    match: CaseMatchReport;
};

const rate = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : numerator / denominator;

export const computeLiveMetrics = (runs: LiveCaseRun[]): LiveMetricsReport => {
    let caughtCount = 0;
    let specCount = 0;
    let verdictHits = 0;
    let unmatched = 0;
    let posted = 0;
    const falseFlagDetails: string[] = [];

    for (const {corpusCase, result, match} of runs) {
        caughtCount += match.caught.length;
        specCount += match.caught.length + match.missed.length;
        if (result.verdict.event === corpusCase.expected.verdict) {
            verdictHits += 1;
        }
        unmatched += match.unmatchedFindingIds.length;
        posted += match.postedCount;
        for (const flag of match.falseFlags) {
            falseFlagDetails.push(`${corpusCase.id}:${flag.specKey}`);
        }
        if (
            corpusCase.category === "clean" &&
            (result.verdict.event !== "APPROVE" ||
                result.postedCandidates.some((c) => c.blocking))
        ) {
            falseFlagDetails.push(`${corpusCase.id}:blocked-clean-case`);
        }
    }

    return {
        caseCount: runs.length,
        mustCatchRecall: {
            numerator: caughtCount,
            denominator: specCount,
            rate: rate(caughtCount, specCount),
        },
        verdictAgreement: {
            numerator: verdictHits,
            denominator: runs.length,
            rate: rate(verdictHits, runs.length),
        },
        cleanFalseFlag: {
            count: falseFlagDetails.length,
            details: falseFlagDetails,
        },
        noise: {
            numerator: unmatched,
            denominator: posted,
            rate: rate(unmatched, posted),
        },
    };
};
