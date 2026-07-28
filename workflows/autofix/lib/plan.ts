/**
 * The autofix plan: every decision this run makes, made in code before the
 * agent is asked to edit anything.
 *
 * This module is the determinism boundary for autofix, mirroring the split the
 * reviewer draws. CODE decides whether the run is armed, which findings are in
 * scope, which are refused and why, and what the commit trailer says. The MODEL
 * decides only how to change the code. Nothing here composes a sentence about
 * the code under review, and nothing downstream re-opens a decision made here:
 * the plan is final, and the prompt's contract is to execute it or stop.
 *
 * The plan has three outcomes and the distinction matters to the PR comment the
 * run posts:
 *   - `armed` — there is work; the agent runs.
 *   - `no-op` — the labels were understood and nothing needed fixing. Not a
 *     failure; the run says so and removes the label.
 *   - `refused` — the run cannot safely proceed (unimplemented label, no
 *     review, unreadable fingerprint). The label is still removed, because a
 *     label left on after a refusal reads as "still queued" when nothing is.
 */

import {resolveScope} from "./scope.ts";
import {buildWorkList} from "./worklist.ts";
import type {SkippedThread, WorkItem} from "./worklist.ts";
import {assessReviewCurrency, REFUSAL_REASONS} from "./staleness.ts";
import {
    renderTrailer,
    summariseLedger,
    TRAILER_SCHEMA_VERSION,
} from "./trailer.ts";
import type {StagedThread} from "../../review/lib/rereview.ts";
import type {PriorReview} from "../../review/lib/rereview-mode.ts";

export type AutofixPlan = {
    status: "armed" | "no-op" | "refused";
    /** One sentence, rendered verbatim into the run's PR comment. */
    reason: string;
    /** Autofix labels to remove; always removed, whatever the status. */
    labelsToRemove: string[];
    scopes: string[];
    items: WorkItem[];
    skipped: SkippedThread[];
    /** 1 in v1; the field a continual cadence would increment. */
    cycle: number;
    /** Pre-rendered trailer block for the commit message; empty unless armed. */
    trailer: string;
    /** Paths carrying hunks no stamped review has seen. */
    stalePaths: string[];
};

export type PlanInput = {
    labels: readonly string[];
    threads: readonly StagedThread[];
    priorReviews: readonly PriorReview[];
    /** The stripped diff of the current head (`full-stripped.diff` shape). */
    diffText: string;
    /** Commit messages on the PR head, for the cycle ledger. */
    commitMessages: readonly string[];
};

/** Every autofix label present, so a refusal still clears the PR. */
const autofixLabelsOn = (labels: readonly string[]): string[] =>
    labels.filter((label) => label.startsWith("autofix: "));

export const buildPlan = (input: PlanInput): AutofixPlan => {
    const labelsToRemove = autofixLabelsOn(input.labels);
    const ledger = summariseLedger(input.commitMessages);
    const base = {
        labelsToRemove,
        scopes: [] as string[],
        items: [] as WorkItem[],
        skipped: [] as SkippedThread[],
        cycle: ledger.nextCycle,
        trailer: "",
        stalePaths: [] as string[],
    };

    const resolution = resolveScope(input.labels);
    if (resolution.status === "none") {
        return {
            ...base,
            status: "no-op",
            reason: "no autofix label is present on this PR.",
        };
    }
    if (resolution.status === "rejected") {
        return {...base, status: "refused", reason: resolution.reason};
    }

    const currency = assessReviewCurrency(input.priorReviews, input.diffText);
    if (currency.status !== "current") {
        return {
            ...base,
            status: "refused",
            scopes: resolution.request.scopes,
            reason: REFUSAL_REASONS[currency.status],
        };
    }

    const stale = new Set(currency.stalePaths);
    const {items, skipped} = buildWorkList(
        input.threads,
        resolution.request.findingLabels,
    );

    // Drop findings whose file moved on after the review that raised them. The
    // finding may already be fixed, or may describe code that no longer exists;
    // either way the statement is no longer known to be true of this head.
    const actionable: WorkItem[] = [];
    const allSkipped = [...skipped];
    for (const item of items) {
        if (stale.has(item.path)) {
            allSkipped.push({
                threadId: item.threadId,
                path: item.path,
                reason: "stale-path",
                label: item.label,
            });
            continue;
        }
        actionable.push(item);
    }

    const common = {
        ...base,
        scopes: resolution.request.scopes,
        skipped: allSkipped,
        stalePaths: currency.stalePaths,
    };

    if (actionable.length === 0) {
        return {
            ...common,
            status: "no-op",
            reason:
                `no open ${resolution.request.scopes.join(" or ")} findings ` +
                `are actionable on this head` +
                (allSkipped.length === 0
                    ? "."
                    : ` (${allSkipped.length} thread(s) skipped; see below).`),
        };
    }

    return {
        ...common,
        status: "armed",
        items: actionable,
        reason: `fixing ${actionable.length} ${resolution.request.scopes.join(
            " and ",
        )} finding(s).`,
        trailer: renderTrailer({
            schemaVersion: TRAILER_SCHEMA_VERSION,
            scopes: resolution.request.scopes,
            cycle: ledger.nextCycle,
            threadIds: actionable.map((item) => item.threadId),
        }),
    };
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/** Injected filesystem, so the CLI is unit-testable without touching disk. */
export type PlanCliFs = {
    readFileSync: (path: string) => string;
    writeFileSync: (path: string, data: string) => void;
    existsSync: (path: string) => boolean;
};

export const AUTOFIX_DIR = "/tmp/gh-aw/autofix";

const readJson = <T>(fs: PlanCliFs, path: string, fallback: T): T => {
    if (!fs.existsSync(path)) {
        return fallback;
    }
    try {
        return JSON.parse(fs.readFileSync(path)) as T;
    } catch {
        return fallback;
    }
};

/**
 * Read the staged inputs, write `plan.json`, and return the plan.
 *
 * A missing or malformed input degrades to its empty value rather than
 * throwing, which routes it into the ordinary refusal path (no reviews reads as
 * `no-review`) instead of failing the job with a stack trace the PR author
 * cannot act on.
 */
export const runPlanCli = (fs: PlanCliFs, dir = AUTOFIX_DIR): AutofixPlan => {
    const plan = buildPlan({
        labels: readJson<string[]>(fs, `${dir}/labels.json`, []),
        threads: readJson<StagedThread[]>(fs, `${dir}/threads.json`, []),
        priorReviews: readJson<PriorReview[]>(
            fs,
            `${dir}/prior-reviews.json`,
            [],
        ),
        diffText: fs.existsSync(`${dir}/pr.diff`)
            ? fs.readFileSync(`${dir}/pr.diff`)
            : "",
        commitMessages: readJson<string[]>(fs, `${dir}/commits.json`, []),
    });
    fs.writeFileSync(`${dir}/plan.json`, `${JSON.stringify(plan, null, 2)}\n`);
    return plan;
};

// Run only when executed directly (autofix.md), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs");
    // Optional staging directory argument. autofix.md passes nothing and gets
    // AUTOFIX_DIR; a human reproducing a run points it at a copy of the staged
    // inputs, which is the only way to re-run a plan outside the workflow.
    const plan = runPlanCli(
        {
            readFileSync: (path: string) => nodeFs.readFileSync(path, "utf-8"),
            writeFileSync: (path: string, data: string) =>
                nodeFs.writeFileSync(path, data),
            existsSync: (path: string) => nodeFs.existsSync(path),
        },
        process.argv[2] || AUTOFIX_DIR,
    );
    // stdout is the prompt's read surface: status and reason drive the
    // comment, the item count drives whether the agent edits anything.
    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify({
            status: plan.status,
            reason: plan.reason,
            scopes: plan.scopes,
            cycle: plan.cycle,
            itemCount: plan.items.length,
            skippedCount: plan.skipped.length,
        }),
    );
}
