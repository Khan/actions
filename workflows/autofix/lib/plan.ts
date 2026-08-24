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
 *   - `no-op` — the request was understood and nothing needed fixing. Not a
 *     failure; the run says so and clears any label that armed it.
 *   - `refused` — the run cannot safely proceed (unimplemented token, no
 *     review, unreadable fingerprint). A label that armed it is still removed,
 *     because a label left on after a refusal reads as "still queued" when
 *     nothing is.
 *
 * Autofix is armed from either of two peer surfaces, a label or an `/autofix`
 * comment. {@link resolveRequest} owns the rule that reconciles them, and the
 * rule is that the trigger decides: they never union with each other.
 */

import {parseCollapsedObservations} from "./collapsed.ts";
import {computeChangedLines} from "../../review/lib/diff.ts";
import {AUTOFIX_LABEL_PREFIX, resolveCommand, resolveScope} from "./scope.ts";
import type {RequestSurface, ScopeResolution} from "./scope.ts";
import {buildBodyWorkList, buildWorkList} from "./worklist.ts";
import type {SkippedThread, WorkItem} from "./worklist.ts";
import {
    assessReviewCurrency,
    DEGRADED_NOTES,
    REFUSAL_REASONS,
} from "./staleness.ts";
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
    /**
     * Autofix labels to remove. Every autofix label on the PR, whatever the
     * status, on a label-armed run; empty on a command-armed one, which has no
     * label state of its own to tidy.
     */
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
    /** Which surface armed the run; empty when nothing did. */
    surface: RequestSurface | "";
    /**
     * Set when the file-level currency check could not run and the plan fell
     * back to per-thread anchors. Rendered into the summary verbatim; empty
     * when the fingerprint check ran normally.
     */
    degradedNote: string;
};

export type PlanInput = {
    labels: readonly string[];
    threads: readonly StagedThread[];
    priorReviews: readonly PriorReview[];
    /** The stripped diff of the current head (`full-stripped.diff` shape). */
    diffText: string;
    /** Commit messages on the PR head, for the cycle ledger. */
    commitMessages: readonly string[];
    /**
     * The body of the `/autofix` comment that triggered this run, when one did.
     * Absent on a label-triggered run.
     */
    command?: string;
    /**
     * Whether the PR head is a fork. Defaults to treating unknown as a fork, so
     * an unreadable context refuses rather than proceeds.
     */
    isFork?: boolean;
    /** Login the reviewer posts as; threaded to the ownership guard. */
    botLogin?: string;
};

/** Every autofix label present, so a label-armed refusal still clears the PR. */
const autofixLabelsOn = (labels: readonly string[]): string[] =>
    labels.filter((label) => label.startsWith(AUTOFIX_LABEL_PREFIX));

/**
 * Resolve the request from whichever surface armed the run.
 *
 * **The trigger decides, and the two surfaces never union.** A run triggered by
 * a comment resolves the comment; a run triggered by a label resolves the
 * labels. Unioning them would mean a stale `autofix: nits` label silently
 * widening someone's `/autofix blocking`, and would make the request depend on
 * PR state the author was not looking at when they typed the command.
 */
const resolveRequest = (input: PlanInput): ScopeResolution => {
    if (input.command !== undefined && input.command.trim() !== "") {
        const fromCommand = resolveCommand(input.command);
        if (fromCommand.status !== "none") {
            return fromCommand;
        }
    }
    return resolveScope(input.labels);
};

export const buildPlan = (input: PlanInput): AutofixPlan => {
    const ledger = summariseLedger(input.commitMessages);
    const base = {
        labelsToRemove: [] as string[],
        scopes: [] as string[],
        items: [] as WorkItem[],
        skipped: [] as SkippedThread[],
        cycle: ledger.nextCycle,
        trailer: "",
        stalePaths: [] as string[],
        surface: "" as RequestSurface | "",
        degradedNote: "",
    };

    const resolution = resolveRequest(input);
    if (resolution.status === "none") {
        return {
            ...base,
            status: "no-op",
            reason: "no autofix label or `/autofix` command armed this run.",
        };
    }

    // A command is self-clearing, so only a label-armed run has label state to
    // tidy. On that path every autofix label present comes off, not just the
    // ones that resolved, so a refusal never leaves one reading as "queued".
    const surface =
        resolution.status === "armed"
            ? resolution.request.surface
            : resolution.surface;
    base.surface = surface;
    base.labelsToRemove =
        surface === "command" ? [] : autofixLabelsOn(input.labels);
    if (resolution.status === "rejected") {
        return {...base, status: "refused", reason: resolution.reason};
    }

    // The `pull_request` branch of the workflow's `if:` gates on this before the
    // job starts. The `issue_comment` branch CANNOT: that event carries no
    // `github.event.pull_request`, so a command-armed run reaches here ungated.
    // An earlier version of the workflow comment and the README both said this
    // check "moves into the plan" while the plan did not implement it, which is
    // how Khan/actions#298's review found it.
    //
    // Enforced on every path, not just the command one: a duplicated guard is
    // cheap, and a missing one authorises a code push.
    //
    // `skip-ai-review` is NOT checked here, deliberately. It stops the reviewer
    // from running again; it does not withdraw a review already posted, so a
    // labelled PR can still carry current findings, and an explicit `autofix:`
    // label or `/autofix` from someone with write access is the authorisation
    // for acting on them. See the reasoning in `autofix.md`'s gate comment, and
    // revisit it if autofix ever runs without a human arming it.
    if (input.isFork !== false) {
        return {
            ...base,
            status: "refused",
            scopes: resolution.request.scopes,
            reason:
                "this PR's head is a fork, or its origin could not be " +
                "determined, and autofix does not push to forks.",
        };
    }

    const currency = assessReviewCurrency(input.priorReviews, input.diffText);
    if (currency.status === "no-review") {
        return {
            ...base,
            status: "refused",
            scopes: resolution.request.scopes,
            reason: REFUSAL_REASONS["no-review"],
        };
    }

    // No fingerprint means the file-level check cannot run, not that the run
    // must stop: the per-thread anchor check in `buildWorkList` still applies,
    // and it is the signal that covers "the author edited the flagged code".
    // The note is carried into the summary so the weaker check is never silent.
    const degradedNote =
        currency.status === "unverifiable" ? DEGRADED_NOTES[currency.why] : "";
    base.degradedNote = degradedNote;

    const stalePaths = currency.status === "current" ? currency.stalePaths : [];
    const stale = new Set(stalePaths);
    const {items: threadItems, skipped: threadSkipped} = buildWorkList(
        input.threads,
        resolution.request.findingLabels,
        input.botLogin,
    );
    // The second source (PRA-7): collapsed observations from the latest
    // review body, so the reviewer's posting budget cannot silently shrink
    // autofix's scope. Thread items come first: they carry the full finding
    // and a reply surface; a body item is a one-line subject with a
    // synthetic id, reported in the run summary instead.
    const bodyList = buildBodyWorkList(
        parseCollapsedObservations(input.priorReviews),
        resolution.request.findingLabels,
        input.threads,
        // The per-item anchor check threads get from GitHub, rebuilt from
        // the staged head diff: this runs on EVERY currency path, including
        // the production-common unverifiable one where stalePaths is empty.
        computeChangedLines(input.diffText),
    );
    const items = [...threadItems, ...bodyList.items];
    const skipped = [...threadSkipped, ...bodyList.skipped];

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
        stalePaths,
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
        // Staged only on the comment-triggered path. Absent on a label run,
        // and absent for any consumer still on an install that predates the
        // command surface, which falls back to labels unchanged.
        command: fs.existsSync(`${dir}/command.txt`)
            ? fs.readFileSync(`${dir}/command.txt`)
            : undefined,
        // Missing context reads as a fork, so a staging gap refuses.
        isFork:
            readJson<{isFork?: boolean}>(fs, `${dir}/context.json`, {})
                .isFork !== false,
        botLogin: process.env.AUTOFIX_BOT_LOGIN?.trim() || undefined,
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
            surface: plan.surface,
            scopes: plan.scopes,
            cycle: plan.cycle,
            degraded: plan.degradedNote !== "",
            itemCount: plan.items.length,
            skippedCount: plan.skipped.length,
        }),
    );
}
