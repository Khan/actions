/**
 * The artifact parser for aggregate.ts: reduce a raw `live-ab-report.json`
 * (single-run or `--repeats`) to the {@link ReportSample} shape the pool
 * consumes. Structural and version-tolerant: fields a report predates parse
 * as absent, and a report whose core shape is wrong throws a descriptive
 * error so the CLI can record it as skipped.
 */

import type {ArmSample, ReportSample, SampleRun} from "./aggregate";
import {mergeUsage, type AgentCost, type ModelTokens} from "./pricing";

const isRecord = (value: unknown): value is Record<string, unknown> =>
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
        const unmatched = Array.isArray(match["unmatchedFindingIds"])
            ? match["unmatchedFindingIds"].length
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
 * Extract the arm samples one report artifact contributes. A single-run
 * report contributes one sample pair; a `--repeats n` report contributes n; a
 * no-reviewable-delta report contributes none (recorded as skipped upstream).
 */
export const extractSamples = (
    source: string,
    raw: unknown,
): ReportSample[] => {
    if (!isRecord(raw)) {
        throw new Error("report: not a JSON object");
    }
    if (raw["noReviewableDelta"] === true) {
        return [];
    }
    // A --repeats artifact nests single-run reports under `repeats`.
    if (Array.isArray(raw["repeats"])) {
        return raw["repeats"].flatMap((repeat, i) =>
            extractSamples(`${source}#${i + 1}`, repeat),
        );
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
