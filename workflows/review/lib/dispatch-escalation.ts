/**
 * The clearance escalation: a `fast` round whose reconciler resolved every
 * blocking thread behind a standing REQUEST_CHANGES continues, in the same
 * dispatch, as a full-roster round. Only a full roster may approve
 * (submission-clearance.ts), so without this the round could only dismiss
 * the block and the author would wait on a later full round for the
 * approval their fix earned.
 *
 * Fast staging leaves every whole-change surface unswapped, so the full
 * roster reviews the whole diff with no restaging. The plan is rewritten to
 * `full` in both of its staged copies, which is the gate's strictest frame
 * and re-anchors the stamp on the current signature. `flip-gated` is out of
 * scope: its staging swaps the surfaces to the scoped hunks.
 *
 * Determinism boundary: pure functions over staged files, plus the one
 * rewrite of the plan files. No model call, no prose about the code under
 * review.
 */

import {isBlockingLabel} from "./render-comment";
import {parseLeadingLabel} from "./rereview";
import {
    computeHunkSignature,
    findLatestStamp,
    stampFromCacheMemory,
} from "./rereview-mode";
import type {PriorReview} from "./rereview-mode";
import {standingChangesRequestedIds} from "./submission-clearance";
import {isRecord} from "./dispatch-contracts";
import {readJson, type DispatchFs} from "./dispatch-agents";

const REVIEW_DIR = "/tmp/gh-aw/review";
const PLAN_PATHS = [
    `${REVIEW_DIR}/rereview-plan.json`,
    `${REVIEW_DIR}/out/rereview-plan.json`,
];
const CACHE_MEMORY_DIR = "/tmp/gh-aw/cache-memory";

/** The plan reason code an escalated round carries. */
export const CLEARANCE_ESCALATION_REASON = "clearance-escalation";

export type Reconciliation = {
    resolve: string[];
    keep: string[];
    skipLines: unknown;
};

const strings = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];

/** The reconciler's parsed output as the dispatcher records it. */
export const toReconciliation = (
    parsed: Record<string, unknown>,
): Reconciliation => ({
    resolve: strings(parsed["resolve"]),
    keep: strings(parsed["keep"]),
    skipLines: parsed["skipLines"] ?? [],
});

/**
 * Whether the reconciler resolved every staged blocking thread. A thread
 * whose opener label does not parse counts as blocking, the same fail-closed
 * rule the accountability recap applies.
 */
export const everyBlockingThreadResolved = (
    threads: unknown,
    resolve: readonly string[],
): boolean => {
    const resolved = new Set(resolve);
    return (Array.isArray(threads) ? threads : []).every((thread) => {
        if (!isRecord(thread) || typeof thread["thread_id"] !== "string") {
            return false;
        }
        const comments = Array.isArray(thread["comments"])
            ? thread["comments"]
            : [];
        const opener = isRecord(comments[0]) ? comments[0]["body"] : undefined;
        const label =
            typeof opener === "string" ? parseLeadingLabel(opener) : null;
        const blocking = label === null || isBlockingLabel(label);
        return !blocking || resolved.has(thread["thread_id"]);
    });
};

/**
 * Whether this fast round may escalate once its reconciler clears the block:
 * a non-draft, non-canary PR whose prior REQUEST_CHANGES still stands (the
 * stamp, or a live standing review, the same derivation the clearance uses).
 */
export const escalationEligible = (
    fs: DispatchFs,
    depth: string,
    canary: boolean,
): boolean => {
    if (depth !== "fast" || canary) {
        return false;
    }
    const prContext = readJson(fs, `${REVIEW_DIR}/pr-context.json`);
    if (!isRecord(prContext) || prContext["isDraft"] !== false) {
        return false;
    }
    const priorRaw = readJson(fs, `${REVIEW_DIR}/prior-reviews.json`);
    const priors = (Array.isArray(priorRaw) ? priorRaw : []).filter(
        (entry): entry is PriorReview =>
            isRecord(entry) && typeof entry["body"] === "string",
    );
    const number = prContext["number"];
    const stamp =
        findLatestStamp(priors) ??
        (typeof number === "number"
            ? stampFromCacheMemory(
                  readJson(fs, `${CACHE_MEMORY_DIR}/pr-${number}.json`),
              )
            : null);
    return (
        stamp?.verdict === "REQUEST_CHANGES" ||
        standingChangesRequestedIds(priorRaw).length > 0
    );
};

/**
 * Rewrite both staged copies of the plan to a full round, re-anchored on the
 * current signature (computed from the same unswapped diff the planner read).
 */
export const escalatePlanToFull = (fs: DispatchFs): void => {
    const plan = readJson(fs, PLAN_PATHS[0]);
    const base = isRecord(plan) ? plan : {};
    const strippedPath = `${REVIEW_DIR}/full-stripped.diff`;
    const diffPath = fs.existsSync(strippedPath)
        ? strippedPath
        : `${REVIEW_DIR}/full.diff`;
    const diff = fs.existsSync(diffPath)
        ? fs.readFileSync(diffPath, "utf8")
        : "";
    const prContext = readJson(fs, `${REVIEW_DIR}/pr-context.json`);
    const escalated = {
        ...base,
        depth: "full",
        dispatch: "all",
        staging: "whole-diff",
        flipGate: false,
        reasons: [...strings(base["reasons"]), CLEARANCE_ESCALATION_REASON],
        escalatedFrom: "fast",
        tripwireRearmed: false,
        stampHunks: computeHunkSignature(diff),
        stampAnchorDraft: isRecord(prContext) && prContext["isDraft"] === true,
    };
    const serialized = JSON.stringify(escalated, null, 2);
    for (const path of PLAN_PATHS) {
        fs.writeFileSync(path, serialized);
    }
};

export type EscalationOutcome = {
    reconciliation: Reconciliation | undefined;
    escalatedFrom: "fast" | undefined;
    skipped: {dimension: string; cause: "unavailable"}[];
};

/**
 * Run the reconciler ahead of the fan-out when the round is eligible, and
 * escalate the plan when it cleared every blocking thread. Undefined when
 * the round is not eligible (the dispatcher then reconciles in Phase 2 as
 * usual); otherwise the reconciler has run and Phase 2 must not repeat it.
 */
export const reconcileForEscalation = async (
    staged: {fs: DispatchFs; depth: string; threads: unknown; canary: boolean},
    reconcile: boolean,
    runReconciler: () => Promise<Record<string, unknown> | null>,
): Promise<EscalationOutcome | undefined> => {
    if (
        !reconcile ||
        !escalationEligible(staged.fs, staged.depth, staged.canary)
    ) {
        return undefined;
    }
    const parsed = await runReconciler();
    if (parsed === null) {
        return {
            reconciliation: undefined,
            escalatedFrom: undefined,
            skipped: [
                {dimension: "thread reconciliation", cause: "unavailable"},
            ],
        };
    }
    const reconciliation = toReconciliation(parsed);
    if (!everyBlockingThreadResolved(staged.threads, reconciliation.resolve)) {
        return {reconciliation, escalatedFrom: undefined, skipped: []};
    }
    escalatePlanToFull(staged.fs);
    return {reconciliation, escalatedFrom: "fast", skipped: []};
};
