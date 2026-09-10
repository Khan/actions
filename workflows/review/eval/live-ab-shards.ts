import {createHash} from "node:crypto";
import {selectCases} from "./live-ab";
import type {CorpusCase} from "./corpus/loader";
import type {RunHeader} from "./live-ab-report";

export const contentHash = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

export type ShardPlan = {
    version: 1;
    candidateSha: string;
    header: RunHeader;
    caseIds: string[];
    repeats: number;
    maxUsd: number;
    forceArms: boolean;
    shards: {
        id: number;
        caseIds: string[];
        corpusSha: string;
        maxUsd: number;
    }[];
};

/** Partition only eligible cases, retaining the same assignment for both arms
 * and every repeat. Each shard owns its budget, so parallel jobs cannot each
 * spend the whole run's allowance. */
export const planShards = (
    corpus: CorpusCase[],
    options: {
        candidateSha: string;
        header: RunHeader;
        full: boolean;
        caseFilter?: string[];
        shards?: number;
        repeats?: number;
        maxUsd?: number;
        forceArms?: boolean;
    },
): ShardPlan => {
    const repeats = options.repeats ?? 1;
    const count = options.shards ?? (options.full ? 4 : 1);
    const maxUsd = options.maxUsd ?? (options.full ? 200 : 40);
    if (!Number.isInteger(count) || count < 1 || count > 16) {
        throw new Error("shards must be an integer from 1 to 16");
    }
    if (!Number.isInteger(repeats) || repeats < 1) {
        throw new Error("repeats must be a positive integer");
    }
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
        throw new Error("max_usd must be a positive finite number");
    }
    const cases = selectCases(corpus, {
        smokeOnly: !options.full,
        ...(options.caseFilter ? {caseFilter: options.caseFilter} : {}),
    });
    if (cases.length === 0) {
        throw new Error("no live cases selected");
    }
    const actualCount = Math.min(count, cases.length);
    const shards = Array.from({length: actualCount}, (_, id) => {
        const selected = cases.filter((_, index) => index % actualCount === id);
        return {
            id,
            caseIds: selected.map((c) => c.id),
            corpusSha: contentHash(JSON.stringify(selected)),
            maxUsd: maxUsd / actualCount,
        };
    });
    return {
        version: 1,
        candidateSha: options.candidateSha,
        header: {
            ...options.header,
            provenance: {
                matcher: "deterministic-v2+posting-v1+threads-v2+arbiter",
                ...options.header.provenance,
                corpusSha: contentHash(JSON.stringify(cases)),
                caseCount: cases.length,
            },
        },
        caseIds: cases.map((c) => c.id),
        repeats,
        maxUsd,
        forceArms: options.forceArms ?? false,
        shards,
    };
};

export const shardArgs = (plan: ShardPlan, id: number): string[] => {
    const shard = plan.shards.find((s) => s.id === id);
    if (shard === undefined) {
        throw new Error(`unknown shard ${id}`);
    }
    return [
        "dlx",
        "tsx",
        "workflows/review/eval/live-ab.ts",
        "--base-ref",
        plan.header.baseRef,
        "--cases",
        shard.caseIds.join(","),
        "--max-usd",
        String(shard.maxUsd),
        "--repeats",
        String(plan.repeats),
        ...(plan.forceArms ? ["--force-arms"] : []),
    ];
};
