/**
 * Match-arbiter calibration (the tuning memo's item 7): measure the arbiter's
 * yes-rate against hand-labeled decision points before trusting arbiter-era
 * recall movements. The refuse bias in the arbiter prompt is a prompt, not a
 * measurement; arbiter rescues inflate recall, the load-bearing metric.
 *
 * The calibration set (`eval/arbiter-calibration.json`) is not synthetic:
 * every pair is a fallback decision the production arbiter actually made in
 * drift run 29724668102 and answered YES to, hand-labeled afterwards. 4 of
 * the 10 recorded accepts were wrong (three times the cap off-by-one finding
 * accepted for the dedup-window-untested spec; once the unreachable
 * quotaExceeded finding accepted for the shared-cache-key spec): same file,
 * plausible adjacency, different defect. Every pair fails deterministic
 * matching by construction (that is why it reached the fallback), which the
 * deterministic suite pins as an invariant.
 *
 * Usage (live, requires ANTHROPIC_API_KEY; ~10 pairs x samples x ~$0.0006):
 *
 *   pnpm dlx tsx workflows/review/eval/arbiter-calibration.ts [--samples 3]
 *
 * Report: per-pair yes-rates and the confusion summary for the CURRENT
 * arbiter prompt. A prompt or model-tier change motivated by these numbers
 * is a RULER change: it re-stamps provenance and owes a noise-floor
 * re-baseline (see eval/README.md).
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {readFileSync} from "node:fs";

import type {LiveDefectSpec} from "./corpus/loader";
import {haikuMatchArbiter} from "./match-arbiter";
import type {RunCandidate} from "./runner";

export type CalibrationPair = {
    id: string;
    /** Which drift-run arm recorded the accept (provenance only). */
    arm: string;
    /** Ground truth: was accepting this pair correct? */
    label: "match" | "mismatch";
    note: string;
    spec: {key: string; path: string; mechanism: string[]};
    candidate: {
        path: string;
        line: number;
        failure_scenario: string;
        model_authored_prose: string;
    };
};

export type CalibrationSet = {
    description: string;
    sourceRun: string;
    pairs: CalibrationPair[];
};

// NOT under corpus/: the corpus loader parses every JSON there as a case.
export const CALIBRATION_SET_PATH =
    "workflows/review/eval/arbiter-calibration.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse + validate the calibration set; throws a descriptive error. */
export const parseCalibrationSet = (raw: unknown): CalibrationSet => {
    if (!isRecord(raw) || !Array.isArray(raw["pairs"])) {
        throw new Error("calibration set: missing pairs array");
    }
    const pairs = raw["pairs"].map((entry, i): CalibrationPair => {
        const at = `pairs[${i}]`;
        if (!isRecord(entry)) {
            throw new Error(`${at}: not an object`);
        }
        const label = entry["label"];
        if (label !== "match" && label !== "mismatch") {
            throw new Error(`${at}.label: must be "match" or "mismatch"`);
        }
        const spec = entry["spec"];
        const candidate = entry["candidate"];
        if (!isRecord(spec) || !Array.isArray(spec["mechanism"])) {
            throw new Error(`${at}.spec: missing mechanism alternates`);
        }
        if (
            !isRecord(candidate) ||
            typeof candidate["failure_scenario"] !== "string" ||
            typeof candidate["model_authored_prose"] !== "string"
        ) {
            throw new Error(`${at}.candidate: missing finding text`);
        }
        return {
            id: String(entry["id"] ?? `pair-${i}`),
            arm: String(entry["arm"] ?? ""),
            label,
            note: String(entry["note"] ?? ""),
            spec: {
                key: String(spec["key"]),
                path: String(spec["path"]),
                mechanism: spec["mechanism"].map(String),
            },
            candidate: {
                path: String(candidate["path"]),
                line: Number(candidate["line"]),
                failure_scenario: candidate["failure_scenario"],
                model_authored_prose: candidate["model_authored_prose"],
            },
        };
    });
    return {
        description: String(raw["description"] ?? ""),
        sourceRun: String(raw["sourceRun"] ?? ""),
        pairs,
    };
};

export const loadCalibrationSet = (
    path: string = CALIBRATION_SET_PATH,
): CalibrationSet =>
    parseCalibrationSet(JSON.parse(readFileSync(path, "utf8")));

/** The pair as the matcher/arbiter seam consumes it. */
export const toSpec = (pair: CalibrationPair): LiveDefectSpec => ({
    key: pair.spec.key,
    path: pair.spec.path,
    mechanism: pair.spec.mechanism,
});

export const toCandidate = (pair: CalibrationPair): RunCandidate => ({
    id: pair.id,
    source: "calibration",
    lens: "correctness",
    label: "issue (blocking)",
    blocking: true,
    anchor: {
        type: "line",
        path: pair.candidate.path,
        line: pair.candidate.line,
        side: "RIGHT",
    },
    path: pair.candidate.path,
    line: pair.candidate.line,
    body: pair.candidate.model_authored_prose,
    finding: {
        schema_version: 2,
        id: pair.id,
        lens: "correctness",
        anchor: {
            type: "line",
            path: pair.candidate.path,
            line: pair.candidate.line,
            side: "RIGHT",
        },
        severity: "blocking",
        confidence: 0.8,
        evidence_trace: [
            "recorded production finding; see arbiter-calibration.json",
        ],
        failure_scenario: pair.candidate.failure_scenario,
        producing_hunt: "calibration-replay",
        model_authored_prose: pair.candidate.model_authored_prose,
    },
});

export type PairScore = {
    id: string;
    label: "match" | "mismatch";
    yes: number;
    samples: number;
};

export type CalibrationSummary = {
    /** Yes-votes on mismatch pairs / total mismatch votes: the rate that inflates recall. */
    falseAcceptRate: number;
    /** No-votes on match pairs / total match votes: the rate that leaves recall conservative. */
    falseRejectRate: number;
    votes: {
        matchYes: number;
        matchNo: number;
        mismatchYes: number;
        mismatchNo: number;
    };
};

/**
 * Distinct decision points per label. Several recorded pairs are the same
 * arbiter decision re-sampled (same spec, same defect at the same anchor,
 * near-identical prose from different runs): the composite-key match appears
 * 4x and the dedup-window mismatch 3x, so the pooled rates' effective N is 5
 * decision points, not 10 pairs, and the false-accept side moves almost
 * entirely with one point. Reported next to the pooled rates so the
 * percentage is weighed correctly; duplicates are extra samples of one
 * point, not independent evidence.
 */
export const distinctDecisionPoints = (
    pairs: readonly CalibrationPair[],
): {match: number; mismatch: number} => {
    const seen = {match: new Set<string>(), mismatch: new Set<string>()};
    for (const pair of pairs) {
        seen[pair.label].add(
            `${pair.spec.key} ${pair.candidate.path} ${pair.candidate.line}`,
        );
    }
    return {match: seen.match.size, mismatch: seen.mismatch.size};
};

export const summarize = (scores: PairScore[]): CalibrationSummary => {
    const votes = {matchYes: 0, matchNo: 0, mismatchYes: 0, mismatchNo: 0};
    for (const score of scores) {
        if (score.label === "match") {
            votes.matchYes += score.yes;
            votes.matchNo += score.samples - score.yes;
        } else {
            votes.mismatchYes += score.yes;
            votes.mismatchNo += score.samples - score.yes;
        }
    }
    const mismatchTotal = votes.mismatchYes + votes.mismatchNo;
    const matchTotal = votes.matchYes + votes.matchNo;
    return {
        falseAcceptRate:
            mismatchTotal === 0 ? 0 : votes.mismatchYes / mismatchTotal,
        falseRejectRate: matchTotal === 0 ? 0 : votes.matchNo / matchTotal,
        votes,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

if (process.argv[1]?.endsWith("arbiter-calibration.ts")) {
    const samplesArg = process.argv.indexOf("--samples");
    // `|| 3`: a trailing `--samples` with no value would otherwise produce
    // NaN, run zero samples per pair, and print a misleading 0% false-accept
    // rate with no model spend.
    const samples =
        samplesArg === -1
            ? 3
            : Math.max(1, Number(process.argv[samplesArg + 1]) || 3);
    if (!process.env["ANTHROPIC_API_KEY"]) {
        console.error(
            "ANTHROPIC_API_KEY is required for a live calibration run.",
        );
        process.exit(1);
    }
    const set = loadCalibrationSet();
    const arbiter = haikuMatchArbiter({
        onError: (message) => console.error(`  arbiter error: ${message}`),
    });
    const run = async (): Promise<void> => {
        const scores: PairScore[] = [];
        for (const pair of set.pairs) {
            let yes = 0;
            for (let i = 0; i < samples; i += 1) {
                if (await arbiter(toCandidate(pair), toSpec(pair))) {
                    yes += 1;
                }
            }
            scores.push({id: pair.id, label: pair.label, yes, samples});
            console.log(
                `${pair.label === "mismatch" ? "MISMATCH" : "match   "} ${
                    pair.id
                }: yes ${yes}/${samples}${
                    pair.label === "mismatch" && yes > 0
                        ? "  <-- false accept"
                        : ""
                }`,
            );
        }
        const summary = summarize(scores);
        const distinct = distinctDecisionPoints(set.pairs);
        console.log(
            `\nfalse-accept rate (mismatch pairs answered yes): ${(
                summary.falseAcceptRate * 100
            ).toFixed(0)}% across ${distinct.mismatch} distinct decision points`,
        );
        console.log(
            `false-reject rate (match pairs answered no): ${(
                summary.falseRejectRate * 100
            ).toFixed(0)}% across ${distinct.match} distinct decision points`,
        );
        console.log(
            "Duplicate pairs are re-samples of one decision point (same spec, " +
                "same defect), not independent evidence; weigh the pooled " +
                "rates by the distinct counts.",
        );
        console.log(
            "Production behavior on this set was 100% yes (every pair is a recorded accept).",
        );
    };
    void run();
}
