/**
 * Fixture builders for the aggregate tests: the report-JSON subset the
 * extractor consumes, shaped the way live-ab.ts serializes it.
 */

/** One raw `arms.<arm>.runs[]` entry as live-ab.ts serializes it. */
export const rawRun = (
    caseId: string,
    over: {
        verdict?: string;
        expected?: string;
        caught?: string[];
        /**
         * Spec key -> the label the catch carried. A key absent from this map
         * serializes a `caught` entry with no `blocking` field, i.e. an
         * artifact predating the severity instrumentation.
         */
        blocking?: Record<string, boolean>;
        missedDetail?: {specKey: string; droppedBy?: string}[];
        unmatched?: string[];
        /** Leftovers bucketed as a second copy of a caught spec. */
        duplicates?: {findingId: string; specKey: string}[];
        /** Leftovers bucketed as legitimate unspecced (may-flag matches). */
        legitimate?: string[];
        posted?: number;
    } = {},
) => ({
    corpusCase: {
        id: caseId,
        expected: {verdict: over.expected ?? "REQUEST_CHANGES"},
    },
    result: {verdict: {event: over.verdict ?? "REQUEST_CHANGES"}},
    match: {
        caseId,
        caught: (over.caught ?? []).map((specKey) => ({
            specKey,
            findingId: `${caseId}:f`,
            via: "deterministic",
            ...(over.blocking?.[specKey] !== undefined
                ? {blocking: over.blocking[specKey]}
                : {}),
        })),
        missed: (over.missedDetail ?? []).map((d) => d.specKey),
        missedDetail: over.missedDetail ?? [],
        falseFlags: [],
        unmatchedFindingIds: over.unmatched ?? [],
        // Absent (not empty) unless asked for, so the default run is the
        // legacy artifact shape.
        ...(over.duplicates !== undefined ? {duplicates: over.duplicates} : {}),
        ...(over.legitimate !== undefined
            ? {
                  legitimateUnspecced: over.legitimate.map((findingId) => ({
                      specKey: "may-1",
                      findingId,
                      via: "deterministic",
                      blocking: false,
                  })),
              }
            : {}),
        postedCount: over.posted ?? (over.caught ?? []).length,
    },
});

export const rawReport = (over: {
    baselineRuns?: unknown[];
    candidateRuns?: unknown[];
    baselineSha?: string;
    candidateSha?: string;
    baselineJudge?: number;
    candidateJudge?: number;
    /** `perCase` and `overhead` as live-ab.ts serializes them, per arm. */
    baselineTokens?: {perCase?: unknown[]; overhead?: unknown};
    candidateTokens?: {perCase?: unknown[]; overhead?: unknown};
}) => ({
    baseRef: "origin/main",
    reviewMdSha: {
        baseline: over.baselineSha ?? "a".repeat(64),
        candidate: over.candidateSha ?? "b".repeat(64),
    },
    arms: {
        baseline: {
            arm: "baseline",
            runs: over.baselineRuns ?? [],
            usd: 1.5,
            ...(over.baselineTokens ?? {}),
            ...(over.baselineJudge !== undefined
                ? {judge: {meanQuality: over.baselineJudge, verdictCounts: {}}}
                : {}),
        },
        candidate: {
            arm: "candidate",
            runs: over.candidateRuns ?? [],
            usd: 2.5,
            ...(over.candidateTokens ?? {}),
            ...(over.candidateJudge !== undefined
                ? {judge: {meanQuality: over.candidateJudge, verdictCounts: {}}}
                : {}),
        },
    },
    regressions: {lost: [], gained: []},
    adversarialFailures: [],
    gateRetries: [],
});
