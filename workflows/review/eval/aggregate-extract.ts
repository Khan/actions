/**
 * The report subset the aggregate consumes, and the version-tolerant reader
 * that reduces a live-ab-report.json (single run or checkpointed repeats)
 * to `ReportSample`s. Split out of `aggregate.ts`, which re-exports
 * everything here, when that module hit the file-size lint; the shapes and
 * the tolerance rules are unchanged.
 */

import {mergeUsage, type AgentCost, type ModelTokens} from "../lib/pricing";

/* -------------------------------------------------------------------------- */
/* The report subset this module consumes (structural, version-tolerant)      */
/* -------------------------------------------------------------------------- */

/** One case-run as it appears in a report's `arms.<arm>.runs[]`. */
export type SampleRun = {
    caseId: string;
    expectedVerdict: string;
    verdict: string;
    caughtSpecKeys: string[];
    /**
     * Caught spec key -> whether the matching candidate blocked. Sparse on
     * purpose: an absent key means the report recorded no label, which is no
     * evidence rather than "non-blocking". See `./aggregate-severity`.
     */
    caughtSpecBlocking: Record<string, boolean>;
    /** Missed spec key -> drop bucket ("" for a true miss). */
    missedSpecs: {specKey: string; droppedBy?: string}[];
    /**
     * The noise numerator: residual unmatched findings plus duplicates of a
     * caught spec. Reports predating the buckets recorded every leftover
     * under `unmatchedFindingIds`, so summing the two reconciles the
     * duplicate bucket, but NOT the may-flag bucket: a leftover that now
     * lands in `legitimateUnspecced` used to count here, so the same run
     * reads a smaller numerator under the new shape (see `duplicates` for
     * how a mixed pool is flagged).
     */
    unmatchedPosted: number;
    /**
     * How many of `unmatchedPosted` are second copies of a defect another
     * comment already claimed, a caught spec or an accepted may-flag entry
     * (0 for reports predating the bucket, which could not tell). The
     * corpus hash moves with every `mayFlagSpecs` edit, so a pool mixing
     * stamped reports from both sides trips the mixed-ruler warning, and a
     * pool mixing stamped with unstamped legacy reports lists "unstamped" as
     * a second ruler value and trips it too.
     */
    duplicates: number;
    /**
     * Posted findings that matched a `mayFlagSpecs` entry (0 for reports
     * predating the field): legitimate, not noise, not recall.
     */
    legitimateUnspecced: number;
    /** Whether the case carried `mayFlagSpecs` (false for legacy reports). */
    audited: boolean;
    posted: number;
    /**
     * Findings the provenance gate anchor-snapped (0 for reports predating
     * the field). The anchor-fidelity observable: a prompt fix that anchors
     * correctly at the source drives this to zero.
     */
    snapped: number;
};

/** One arm-run: a single pass of one arm over its cases. */
export type ArmSample = {
    arm: "baseline" | "candidate";
    reviewMdSha: string;
    runs: SampleRun[];
    /** Cases never dispatched (budget skips); asymmetric samples bias bands. */
    skippedCount: number;
    /** Sub-agent spend at list (the runner's meter). */
    usd: number;
    /**
     * Per-agent cost with tokens, when the report recorded it
     * (`perCase[].agentCosts`), so the pool can be priced at Khan's rate.
     */
    agentCosts?: AgentCost[];
    /** The judge's and arbiter's tokens on this arm, when recorded. */
    overhead?: ModelTokens[];
    judgeMeanQuality?: number;
};

/** One report artifact, reduced to what aggregation needs. */
export type ReportSample = {
    source: string;
    baseRef: string;
    /**
     * Ruler provenance, when the report carries it (reports predating the
     * stamps parse with both undefined): the matcher configuration and a
     * content hash of the loaded corpus. Rates are only comparable across
     * runs whose ruler matches; the aggregate warns on a mixed pool.
     */
    matcher?: string;
    corpusSha?: string;
    baseline: ArmSample;
    candidate: ArmSample;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string =>
    typeof value === "string" ? value : "";

const asNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Parse one arm out of a raw report; throws a descriptive error on shape. */
const parseArm = (
    raw: unknown,
    arm: "baseline" | "candidate",
    reviewMdSha: string,
): ArmSample => {
    if (!isRecord(raw) || !Array.isArray(raw["runs"])) {
        throw new Error(`arms.${arm}.runs: missing or not an array`);
    }
    const runs = raw["runs"].map((run, i): SampleRun => {
        if (!isRecord(run)) {
            throw new Error(`arms.${arm}.runs[${i}]: not an object`);
        }
        const corpusCase = run["corpusCase"];
        const result = run["result"];
        const match = run["match"];
        if (!isRecord(corpusCase) || !isRecord(result) || !isRecord(match)) {
            throw new Error(
                `arms.${arm}.runs[${i}]: missing corpusCase/result/match`,
            );
        }
        const expected = isRecord(corpusCase["expected"])
            ? corpusCase["expected"]
            : {};
        const verdict = isRecord(result["verdict"]) ? result["verdict"] : {};
        const caught = Array.isArray(match["caught"]) ? match["caught"] : [];
        const missedDetail = Array.isArray(match["missedDetail"])
            ? match["missedDetail"]
            : [];
        // Older reports carry `missed` only; missedDetail supersedes it.
        const missed = Array.isArray(match["missed"]) ? match["missed"] : [];
        const detailKeys = new Set(
            missedDetail
                .filter(isRecord)
                .map((d) => asString(d["specKey"]))
                .filter((k) => k !== ""),
        );
        const missedSpecs = [
            ...missedDetail.filter(isRecord).map((d) => {
                const droppedBy = asString(d["droppedBy"]);
                return {
                    specKey: asString(d["specKey"]),
                    ...(droppedBy !== "" ? {droppedBy} : {}),
                };
            }),
            ...missed
                .filter(
                    (k): k is string =>
                        typeof k === "string" && !detailKeys.has(k),
                )
                .map((specKey) => ({specKey})),
        ];
        const duplicates = Array.isArray(match["duplicates"])
            ? match["duplicates"].length
            : 0;
        const unmatched =
            (Array.isArray(match["unmatchedFindingIds"])
                ? match["unmatchedFindingIds"].length
                : 0) + duplicates;
        const legitimateUnspecced = Array.isArray(match["legitimateUnspecced"])
            ? match["legitimateUnspecced"].length
            : 0;
        return {
            caseId: asString(corpusCase["id"]),
            expectedVerdict: asString(expected["verdict"]),
            verdict: asString(verdict["event"]),
            caughtSpecKeys: caught
                .filter(isRecord)
                .map((c) => asString(c["specKey"]))
                .filter((k) => k !== ""),
            // Only entries carrying the flag: a legacy report contributes no
            // severity samples rather than a run of `false`.
            caughtSpecBlocking: Object.fromEntries(
                caught
                    .filter(isRecord)
                    .filter((c) => typeof c["blocking"] === "boolean")
                    .map((c): [string, boolean] => [
                        asString(c["specKey"]),
                        c["blocking"] === true,
                    ])
                    .filter(([key]) => key !== ""),
            ),
            missedSpecs,
            unmatchedPosted: unmatched,
            duplicates,
            legitimateUnspecced,
            audited:
                isRecord(corpusCase["live"]) &&
                Array.isArray(corpusCase["live"]["mayFlagSpecs"]) &&
                corpusCase["live"]["mayFlagSpecs"].length > 0,
            posted: asNumber(match["postedCount"]),
            snapped: Array.isArray(result["snappedByProvenance"])
                ? result["snappedByProvenance"].length
                : 0,
        };
    });
    const judge = raw["judge"];
    const agentCosts = (Array.isArray(raw["perCase"]) ? raw["perCase"] : [])
        .filter(isRecord)
        .flatMap((c) =>
            Array.isArray(c["agentCosts"])
                ? c["agentCosts"].map(parseAgentCost)
                : [],
        )
        .filter((a): a is AgentCost => a !== undefined);
    const overheadRaw = raw["overhead"];
    const overhead = isRecord(overheadRaw)
        ? [overheadRaw["judge"], overheadRaw["arbiter"]]
              .flatMap((list) => (Array.isArray(list) ? list : []))
              .map(parseTokens)
              .filter((t): t is ModelTokens => t !== undefined)
        : undefined;
    return {
        arm,
        reviewMdSha,
        runs,
        skippedCount: Array.isArray(raw["skippedCases"])
            ? raw["skippedCases"].length
            : 0,
        usd: asNumber(raw["usd"]),
        ...(agentCosts.length > 0 ? {agentCosts} : {}),
        ...(overhead === undefined ? {} : {overhead: mergeUsage(overhead)}),
        ...(isRecord(judge) && typeof judge["meanQuality"] === "number"
            ? {judgeMeanQuality: judge["meanQuality"]}
            : {}),
    };
};

/**
 * Extract the arm samples one report artifact contributes: one pair for a
 * single-run report, its finished repeats for `--repeats n` (so the `partial`
 * check sits below the repeats branch), none for a no-reviewable-delta report
 * or a mid-run checkpoint (`partial`, whose arms scored different case sets).
 */
export const extractSamples = (
    source: string,
    raw: unknown,
): ReportSample[] => {
    if (!isRecord(raw)) {
        throw new Error("report: not a JSON object");
    }
    // A --repeats artifact nests single-run reports under `repeats`.
    if (Array.isArray(raw["repeats"])) {
        return raw["repeats"].flatMap((repeat, i) =>
            extractSamples(`${source}#${i + 1}`, repeat),
        );
    }
    // Nothing to pool: identical arms, or a checkpoint a run wrote mid-case.
    if (raw["noReviewableDelta"] === true || raw["partial"] === true) {
        return [];
    }
    const arms = raw["arms"];
    const shas = raw["reviewMdSha"];
    if (!isRecord(arms)) {
        throw new Error("report: missing arms");
    }
    const sha = (key: string): string =>
        isRecord(shas) ? asString(shas[key]) : "";
    const provenance = isRecord(raw["provenance"]) ? raw["provenance"] : {};
    const matcher = asString(provenance["matcher"]);
    const corpusSha = asString(provenance["corpusSha"]);
    return [
        {
            source,
            baseRef: asString(raw["baseRef"]),
            ...(matcher !== "" ? {matcher} : {}),
            ...(corpusSha !== "" ? {corpusSha} : {}),
            baseline: parseArm(arms["baseline"], "baseline", sha("baseline")),
            candidate: parseArm(
                arms["candidate"],
                "candidate",
                sha("candidate"),
            ),
        },
    ];
};

/** One `ModelTokens` entry off a raw artifact, or undefined on a bad shape. */
const parseTokens = (raw: unknown): ModelTokens | undefined =>
    isRecord(raw) && typeof raw["model"] === "string"
        ? {
              model: raw["model"],
              input: asNumber(raw["input"]),
              output: asNumber(raw["output"]),
              cacheRead: asNumber(raw["cacheRead"]),
              cacheWrite: asNumber(raw["cacheWrite"]),
          }
        : undefined;

/** One `agentCosts[]` entry off a raw artifact, or undefined on a bad shape. */
const parseAgentCost = (raw: unknown): AgentCost | undefined => {
    if (!isRecord(raw) || typeof raw["agent"] !== "string") {
        return undefined;
    }
    const usage = Array.isArray(raw["usage"])
        ? raw["usage"]
              .map(parseTokens)
              .filter((t): t is ModelTokens => t !== undefined)
        : undefined;
    return {
        agent: raw["agent"],
        model: asString(raw["model"]),
        usd: asNumber(raw["usd"]),
        ...(usage === undefined ? {} : {usage}),
    };
};
