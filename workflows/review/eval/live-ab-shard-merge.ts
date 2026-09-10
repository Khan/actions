import {assembleMulti, assembleReport} from "./live-ab-checkpoint";
import type {
    AbReport,
    ArmId,
    ArmRunReport,
    MultiAbReport,
} from "./live-ab-report";
import {computeLiveMetrics} from "./live-match";
import {computeRereviewMetrics} from "./rereview-match";
import {contentHash, type ShardPlan} from "./live-ab-shards";

export type NoDelta = {noReviewableDelta: true; baseRef: string; sha: string};
export type ShardReceipt = {
    id: number;
    planSha: string;
    exitCode: number | null;
};
export type ShardInput = ShardReceipt & {
    report: AbReport | MultiAbReport | NoDelta;
};

const same = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} mismatch`);
    }
};

/** Merge underlying observations, never averages of shard percentages. */
const mergeArm = (
    arm: ArmId,
    reports: AbReport[],
    ids: string[],
): ArmRunReport => {
    const arms = reports.map((r) => r.arms[arm]);
    const order = new Map(ids.map((id, index) => [id, index]));
    const runs = arms
        .flatMap((a) => a.runs)
        .sort(
            (a, b) =>
                (order.get(a.corpusCase.id) ?? 0) -
                (order.get(b.corpusCase.id) ?? 0),
        );
    const perCase = arms
        .flatMap((a) => a.perCase)
        .sort(
            (a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0),
        );
    const rereviews = perCase.flatMap((c) =>
        c.rereview ? [{caseId: c.caseId, score: c.rereview}] : [],
    );
    const merged: ArmRunReport = {
        arm,
        runs,
        perCase,
        metrics: computeLiveMetrics(runs),
        skippedCases: [],
        usd: arms.reduce((sum, a) => sum + a.usd, 0),
        // This is aggregate arm work, not elapsed parallel-job duration.
        wallMs: arms.reduce((sum, a) => sum + a.wallMs, 0),
        overhead: {
            judge: arms.flatMap((a) => a.overhead?.judge ?? []),
            arbiter: arms.flatMap((a) => a.overhead?.arbiter ?? []),
        },
        ...(rereviews.length
            ? {rereview: computeRereviewMetrics(rereviews)}
            : {}),
    };
    const errors = arms.flatMap((a) => (a.judgeError ? [a.judgeError] : []));
    if (errors.length) {
        merged.judgeError = errors.join("\n");
    } else {
        const judges = arms.flatMap((a) => (a.judge ? [a.judge] : []));
        const verdictCounts: Record<string, number> = {};
        let quality = 0;
        let count = 0;
        for (const judge of judges) {
            const n = Object.values(judge.verdictCounts).reduce(
                (sum, v) => sum + v,
                0,
            );
            quality += judge.meanQuality * n;
            count += n;
            for (const [verdict, n] of Object.entries(judge.verdictCounts)) {
                verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + n;
            }
        }
        if (judges.length) {
            merged.judge = {
                meanQuality: count ? quality / count : 0,
                verdictCounts,
            };
        }
    }
    return merged;
};

/** Every expected shard, repeat, and case must be present exactly once. A
 * timeout or budget-truncated arm is not a successful smaller experiment. */
export const mergeShards = (
    plan: ShardPlan,
    inputs: ShardInput[],
): AbReport | MultiAbReport | NoDelta => {
    same(
        inputs.map((s) => s.id).sort((a, b) => a - b),
        plan.shards.map((s) => s.id),
        "shard coverage",
    );
    same(
        plan.shards.flatMap((s) => s.caseIds).sort(),
        [...plan.caseIds].sort(),
        "planned case coverage",
    );
    const planSha = contentHash(JSON.stringify(plan));
    const repeats: AbReport[][] = Array.from({length: plan.repeats}, () => []);
    let noDelta = 0;
    for (const input of inputs) {
        same(input.planSha, planSha, `shard ${input.id} plan`);
        if (input.exitCode === null) {
            throw new Error(`shard ${input.id} did not finish`);
        }
        const report = input.report;
        if ("noReviewableDelta" in report) {
            same(input.exitCode, 0, "no-delta exit");
            same(report.baseRef, plan.header.baseRef, "no-delta baseline");
            same(
                report.sha,
                plan.header.reviewMdSha.candidate.slice(0, 12),
                "no-delta prompt",
            );
            same(
                plan.header.reviewMdSha.baseline,
                plan.header.reviewMdSha.candidate,
                "identical prompts",
            );
            same(
                plan.header.runtime?.baseline,
                plan.header.runtime?.candidate,
                "identical runtime",
            );
            same(plan.forceArms, false, "no-delta force-arms");
            noDelta += 1;
            continue;
        }
        if (
            report.partial ||
            (input.exitCode !== 0 && report.adversarialFailures.length === 0)
        ) {
            throw new Error(
                `shard ${input.id} is incomplete or failed outside the adversarial gate`,
            );
        }
        const shard = plan.shards.find((s) => s.id === input.id)!;
        const reports = "repeats" in report ? report.repeats : [report];
        if ("repeats" in report) {
            same(report.repeatCount, plan.repeats, "repeat count");
        }
        same(reports.length, plan.repeats, "repeat coverage");
        reports.forEach((r, index) => {
            if (r.partial) {
                throw new Error(
                    `shard ${input.id} repeat ${index + 1} is partial`,
                );
            }
            same(r.baseRef, plan.header.baseRef, "baseline ref");
            same(r.reviewMdSha, plan.header.reviewMdSha, "prompt hashes");
            same(r.runtime, plan.header.runtime, "runtime");
            same(
                r.provenance,
                {
                    ...plan.header.provenance,
                    corpusSha: shard.corpusSha,
                    caseCount: shard.caseIds.length,
                },
                "ruler",
            );
            for (const arm of ["baseline", "candidate"] as const) {
                const a = r.arms[arm];
                same(a.arm, arm, "arm identity");
                same(
                    a.runs.map((c) => c.corpusCase.id),
                    shard.caseIds,
                    `${arm} case coverage`,
                );
                same(
                    a.perCase.map((c) => c.caseId),
                    shard.caseIds,
                    `${arm} accounting coverage`,
                );
                same(a.skippedCases, [], `${arm} skipped cases`);
                same(
                    contentHash(
                        JSON.stringify(a.runs.map((c) => c.corpusCase)),
                    ),
                    shard.corpusSha,
                    "case contents",
                );
            }
            if (
                r.gateRetries.some(
                    (retry) => !shard.caseIds.includes(retry.caseId),
                ) ||
                new Set(r.gateRetries.map((retry) => retry.caseId)).size !==
                    r.gateRetries.length
            ) {
                throw new Error("invalid gate retry ownership");
            }
            repeats[index]!.push(r);
        });
    }
    if (noDelta) {
        same(noDelta, inputs.length, "no-delta shards");
        return {
            noReviewableDelta: true,
            baseRef: plan.header.baseRef,
            sha: plan.header.reviewMdSha.candidate.slice(0, 12),
        };
    }
    const merged = repeats.map((reports) =>
        assembleReport(
            plan.header,
            mergeArm("baseline", reports, plan.caseIds),
            mergeArm("candidate", reports, plan.caseIds),
            reports.flatMap((r) => r.gateRetries),
        ),
    );
    return plan.repeats === 1
        ? merged[0]!
        : assembleMulti(plan.repeats, merged);
};
