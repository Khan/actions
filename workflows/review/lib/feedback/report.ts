/**
 * The renderer for the weekly feedback report: `events.jsonl` +
 * `collection-meta.json` + `judgment.json` in, `summary.json` + `report.md`
 * out.
 *
 * Two outputs because they have two audiences. `summary.json` is the P4
 * calibration instrument — per-category acceptance rates are what set the
 * reviewer's comment budgets, so its numbers must be exact and every judged
 * number must be traceable to how much of the week the model actually
 * classified (hence `unclassified` counts next to every rate, and a `null`
 * rate rather than a `0` when nothing was classified). `report.md` is the
 * message a human reads in Slack.
 *
 * The renderer is PURE: no network, no model, no clock, no filesystem in the
 * core. It reads three artifacts and composes markdown. It is also the only
 * module in this feature that authors prose, and the prose it authors is
 * structural (headings, counts, captions) — every judgement-laden sentence in
 * the output is a model-authored `reason`/`note`/`title` passed through
 * verbatim from `judgment.json`.
 *
 * Transport-agnostic on purpose: Slack wiring lands separately, so this emits
 * plain markdown and nothing knows what posts it.
 *
 * Category order is FIXED and identical for every repo. The design note's
 * whole rollup story is that one shared channel is the cross-repo view, which
 * only works if two repos' messages line up line for line.
 *
 *     npx -y tsx gh-aw-review-lib/workflows/review/lib/feedback/report.ts <dir>
 */

import {isBotLogin} from "../threads";
import {parseEventsJsonl, THREAD_CLASSES, type Judgment} from "./judge";
import type {
    CollectionMeta,
    FeedbackEvent,
    ThreadClass,
} from "./report-types";

/* -------------------------------------------------------------------------- */
/* summary.json                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Accepted-vs-declined for one slice of the week. `rate` is
 * `accepted / (accepted + declined)` — clarifications and process complaints
 * are neither, and `unclassified` is deliberately outside the denominator so
 * the rate never silently absorbs the model's uncertainty. `null` when the
 * denominator is zero: a week with no verdicts has no acceptance rate, and
 * printing `0%` would read as total rejection.
 */
export type AcceptanceSlice = {
    accepted: number;
    declined: number;
    /** Threads in this slice the judge left unclassified. */
    unclassified: number;
    /** Every replied thread in this slice, judged or not. */
    threads: number;
    rate: number | null;
};

/** `summary.json`: every number the report prints, in one machine-readable file. */
export type FeedbackSummary = {
    repo: string;
    windowStart: string;
    windowEnd: string;
    collected_at: string;
    botLogin: string;
    /** PRs the window's per-PR fetches covered. */
    prCount: number;
    /** Reviewer runs, counted by the `review-v<version>` footer (never events). */
    runs: {
        total: number;
        /** Verdict mix over footer-counted runs only. */
        byVerdict: Record<string, number>;
    };
    botComments: {
        total: number;
        /** Conventional-Comments label prefix -> count; `""` = unlabeled. */
        byLabel: Record<string, number>;
        blocking: number;
        nonBlocking: number;
        guidance: number;
    };
    reactions: {
        total: number;
        up: number;
        down: number;
        other: number;
        /** Raw GitHub reaction token -> count. */
        byKind: Record<string, number>;
    };
    replies: {
        total: number;
        /** Threads carrying at least one human reply. */
        threads: number;
        byClass: Record<ThreadClass, number>;
    };
    threads: {
        total: number;
        botOpened: number;
        resolved: number;
        resolvedByHuman: number;
        resolvedByBot: number;
        unresolved: number;
        /** 👎 on thread OPENERS: the adjudication signal, not conversation. */
        openerDownvotes: number;
    };
    skipAiReview: {
        labeled: number;
        unlabeled: number;
    };
    acceptance: {
        overall: AcceptanceSlice;
        /** Same slice per opener label, so budgets can be set per category. */
        byLabel: Record<string, AcceptanceSlice>;
    };
    coverage: {
        /** From collection: silent search caps, page caps, unresolved parents. */
        truncationWarnings: string[];
        /** From judgment: schema failures, low confidence, missing items. */
        judgmentWarnings: string[];
        /** Replied threads the judge did not confidently classify. */
        unclassifiedThreads: number;
        themeClusters: number;
        notables: number;
    };
};

const emptySlice = (): AcceptanceSlice => ({
    accepted: 0,
    declined: 0,
    unclassified: 0,
    threads: 0,
    rate: null,
});

const rateOf = (slice: AcceptanceSlice): number | null => {
    const denominator = slice.accepted + slice.declined;
    return denominator === 0 ? null : slice.accepted / denominator;
};

/**
 * A blocking finding is one whose Conventional-Comments label says so.
 * `non-blocking` contains the substring `blocking`, so the negative must be
 * tested first — this is the exact trap that makes a label mix look inverted.
 */
export const isBlockingLabel = (label: string): boolean =>
    label.includes("blocking") && !label.includes("non-blocking");

const bump = (counts: Record<string, number>, key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Aggregate one window into {@link FeedbackSummary}. Pure and total: unknown
 * event kinds, threads with no judgment entry, and judgments for threads that
 * are not in the events all degrade to counted-as-unclassified rather than
 * throwing, because the summary's job is to be publishable every week.
 */
export const summarize = (
    events: readonly FeedbackEvent[],
    meta: CollectionMeta,
    judgment: Judgment,
): FeedbackSummary => {
    const byVerdict: Record<string, number> = {};
    const byLabel: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const byClass = Object.fromEntries(
        THREAD_CLASSES.map((name) => [name, 0]),
    ) as Record<ThreadClass, number>;

    const summary: FeedbackSummary = {
        repo: meta.repo,
        windowStart: meta.windowStart,
        windowEnd: meta.windowEnd,
        collected_at: meta.collected_at,
        botLogin: meta.botLogin,
        prCount: meta.prNumbers.length,
        runs: {total: 0, byVerdict},
        botComments: {
            total: 0,
            byLabel,
            blocking: 0,
            nonBlocking: 0,
            guidance: 0,
        },
        reactions: {total: 0, up: 0, down: 0, other: 0, byKind},
        replies: {total: 0, threads: 0, byClass},
        threads: {
            total: 0,
            botOpened: 0,
            resolved: 0,
            resolvedByHuman: 0,
            resolvedByBot: 0,
            unresolved: 0,
            openerDownvotes: 0,
        },
        skipAiReview: {labeled: 0, unlabeled: 0},
        acceptance: {overall: emptySlice(), byLabel: {}},
        coverage: {
            truncationWarnings: [...meta.truncationWarnings],
            judgmentWarnings: [...judgment.warnings],
            unclassifiedThreads: 0,
            themeClusters: judgment.clusters.length,
            notables: judgment.notables.length,
        },
    };

    /** Thread root id -> opener label, for the per-category acceptance slices. */
    const labelOfRoot = new Map<number, string>();
    const repliedRoots = new Set<number>();

    for (const event of events) {
        switch (event.kind) {
            case "review_verdict":
                // Footer-counted: autofix's thread replies arrive as empty
                // COMMENTED reviews, so review events overstate runs.
                if (event.reviewVersion !== null) {
                    summary.runs.total += 1;
                    bump(byVerdict, event.state);
                }
                break;
            case "bot_inline_comment":
                summary.botComments.total += 1;
                bump(byLabel, event.label);
                if (isBlockingLabel(event.label)) {
                    summary.botComments.blocking += 1;
                } else {
                    summary.botComments.nonBlocking += 1;
                }
                labelOfRoot.set(event.id, event.label);
                break;
            case "guidance_comment":
                summary.botComments.guidance += 1;
                break;
            case "reaction":
                summary.reactions.total += 1;
                bump(byKind, event.content);
                if (event.content === "+1") {
                    summary.reactions.up += 1;
                } else if (event.content === "-1") {
                    summary.reactions.down += 1;
                } else {
                    summary.reactions.other += 1;
                }
                break;
            case "human_reply":
                summary.replies.total += 1;
                repliedRoots.add(event.parentId);
                break;
            case "thread_state":
                summary.threads.total += 1;
                if (event.botOpened) {
                    summary.threads.botOpened += 1;
                }
                summary.threads.openerDownvotes += event.openerDownvotes;
                if (event.resolved) {
                    summary.threads.resolved += 1;
                    if (
                        event.resolvedBy !== "" &&
                        !isBotLogin(event.resolvedBy)
                    ) {
                        summary.threads.resolvedByHuman += 1;
                    } else {
                        summary.threads.resolvedByBot += 1;
                    }
                } else {
                    summary.threads.unresolved += 1;
                }
                break;
            case "label_event":
                if (event.label === "skip-ai-review") {
                    if (event.action === "labeled") {
                        summary.skipAiReview.labeled += 1;
                    } else {
                        summary.skipAiReview.unlabeled += 1;
                    }
                }
                break;
        }
    }

    summary.replies.threads = repliedRoots.size;

    const sliceFor = (label: string): AcceptanceSlice => {
        const existing = summary.acceptance.byLabel[label];
        if (existing !== undefined) {
            return existing;
        }
        const created = emptySlice();
        summary.acceptance.byLabel[label] = created;
        return created;
    };

    for (const rootId of [...repliedRoots].sort((a, b) => a - b)) {
        const judged = judgment.threads[String(rootId)];
        // A thread with no entry is a thread the judge never saw: unclassified,
        // exactly like one it saw and was unsure about.
        const name: ThreadClass = judged?.class ?? "unclassified";
        byClass[name] += 1;

        const label = labelOfRoot.get(rootId) ?? "";
        const slices = [summary.acceptance.overall, sliceFor(label)];
        for (const slice of slices) {
            slice.threads += 1;
            if (name === "accepted-and-fixed") {
                slice.accepted += 1;
            } else if (name === "declined-with-reasoning") {
                slice.declined += 1;
            } else if (name === "unclassified") {
                slice.unclassified += 1;
            }
        }
        if (name === "unclassified") {
            summary.coverage.unclassifiedThreads += 1;
        }
    }

    summary.acceptance.overall.rate = rateOf(summary.acceptance.overall);
    for (const slice of Object.values(summary.acceptance.byLabel)) {
        slice.rate = rateOf(slice);
    }

    return summary;
};

/* -------------------------------------------------------------------------- */
/* Jira candidates                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The Jira project candidates are proposed against. Rendered as TEXT only:
 * the design note is explicit that auto-filing from LLM judgment produces a
 * weekly pile of duplicates nobody triages, so nothing here files anything.
 */
export const JIRA_PROJECT = "KORE";

/**
 * A proposal a human may file. `dedupeKey` is the whole point: the same defect
 * surfacing three weeks running proposes the same key, so a human (or a later
 * deterministic tier) can tell a repeat from a new problem.
 */
export type JiraCandidate = {
    /** `<repo>#<comment_id>` or `<repo>#cluster:<cluster_key>`. */
    dedupeKey: string;
    /** Prefilled one-line title. */
    title: string;
    /** Comment URL for a single-comment candidate; `""` for a cluster. */
    url: string;
};

/** Collapse a model-authored line into a single-line title. */
const oneLine = (text: string): string =>
    text.replace(/\s+/g, " ").trim() || "(no description)";

/**
 * Build the candidate list: one per theme cluster (the recurring defects) and
 * one per notable item (the one-offs worth a ticket). Cluster candidates come
 * first — a theme seen across several threads is better evidence than any
 * single comment — and both groups keep the judge's order, which is already
 * deterministic per {@link Judgment}.
 */
export const jiraCandidates = (
    repo: string,
    judgment: Judgment,
): JiraCandidate[] => [
    ...judgment.clusters.map((cluster) => ({
        dedupeKey: `${repo}#cluster:${cluster.key}`,
        title: `[${repo}] ${oneLine(cluster.title)} (${
            cluster.commentIds.length
        } comment(s))`,
        url: "",
    })),
    ...judgment.notables.map((notable) => ({
        dedupeKey: `${repo}#${notable.commentId}`,
        title: `[${repo}] ${oneLine(notable.note)}`,
        url: notable.url,
    })),
];

/* -------------------------------------------------------------------------- */
/* report.md                                                                  */
/* -------------------------------------------------------------------------- */

const pct = (rate: number | null): string =>
    rate === null ? "n/a" : `${Math.round(rate * 100)}%`;

/** `a: 1, b: 2` in a stable key order; `none` when empty. */
const mix = (counts: Record<string, number>): string => {
    const entries = Object.entries(counts).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    return entries.length === 0
        ? "none"
        : entries.map(([key, count]) => `${key || "(unlabeled)"}: ${count}`).join(", ");
};

/**
 * Render the Slack message body. Fixed section order for every repo; sections
 * with nothing in them still print (with "none"), because a reader scanning
 * the channel compares positions, not headings.
 */
export const renderReport = (
    summary: FeedbackSummary,
    judgment: Judgment,
): string => {
    const lines: string[] = [];
    const day = (iso: string): string => iso.slice(0, 10);

    lines.push(`# ${summary.repo} — reviewer feedback, week of ${day(summary.windowStart)}`);
    lines.push("");
    lines.push(
        `Window ${day(summary.windowStart)} → ${day(
            summary.windowEnd,
        )} · ${summary.prCount} PR(s) · bot \`${summary.botLogin}\``,
    );
    lines.push("");

    lines.push("## Numbers");
    lines.push("");
    lines.push(`- Runs: ${summary.runs.total} (${mix(summary.runs.byVerdict)})`);
    lines.push(
        `- Bot comments: ${summary.botComments.total} (blocking ${summary.botComments.blocking}, non-blocking ${summary.botComments.nonBlocking}) · guidance ${summary.botComments.guidance}`,
    );
    lines.push(`- Label mix: ${mix(summary.botComments.byLabel)}`);
    lines.push(
        `- Human reactions: ${summary.reactions.total} (👍 ${summary.reactions.up}, 👎 ${summary.reactions.down}, other ${summary.reactions.other})`,
    );
    lines.push(
        `- Human replies: ${summary.replies.total} across ${summary.replies.threads} thread(s)`,
    );
    for (const name of THREAD_CLASSES) {
        lines.push(`    - ${name}: ${summary.replies.byClass[name]}`);
    }
    lines.push(
        `- Threads: ${summary.threads.total} (bot-opened ${summary.threads.botOpened}) · resolved ${summary.threads.resolved} (by humans ${summary.threads.resolvedByHuman}, by bot ${summary.threads.resolvedByBot}) · unresolved ${summary.threads.unresolved} · 👎 on openers ${summary.threads.openerDownvotes}`,
    );
    lines.push(
        `- skip-ai-review: ${summary.skipAiReview.labeled} applied, ${summary.skipAiReview.unlabeled} removed`,
    );
    lines.push(
        `- Acceptance rate: ${pct(summary.acceptance.overall.rate)} (${summary.acceptance.overall.accepted} accepted / ${summary.acceptance.overall.declined} declined, ${summary.acceptance.overall.unclassified} unclassified)`,
    );
    const labels = Object.keys(summary.acceptance.byLabel).sort();
    for (const label of labels) {
        const slice = summary.acceptance.byLabel[label];
        if (slice === undefined) {
            continue;
        }
        lines.push(
            `    - ${label || "(unlabeled)"}: ${pct(slice.rate)} (${slice.accepted}/${slice.declined}, ${slice.unclassified} unclassified)`,
        );
    }
    lines.push("");

    lines.push("## Notable");
    lines.push("");
    if (judgment.notables.length === 0) {
        lines.push("- none");
    } else {
        for (const notable of judgment.notables) {
            lines.push(`- ${oneLine(notable.note)} — ${notable.url}`);
        }
    }
    lines.push("");

    lines.push("## Themes");
    lines.push("");
    if (judgment.clusters.length === 0) {
        lines.push("- none");
    } else {
        for (const cluster of judgment.clusters) {
            lines.push(
                `- **${cluster.key}** — ${oneLine(cluster.title)} (${
                    cluster.commentIds.length
                } comment(s))`,
            );
        }
    }
    lines.push("");

    lines.push("## Coverage caveats");
    lines.push("");
    const caveats = [
        ...summary.coverage.truncationWarnings,
        ...summary.coverage.judgmentWarnings,
    ];
    if (summary.coverage.unclassifiedThreads > 0) {
        caveats.push(
            `${summary.coverage.unclassifiedThreads} replied thread(s) were not confidently classified and are excluded from the acceptance rate`,
        );
    }
    if (caveats.length === 0) {
        lines.push("- none; every count above is complete");
    } else {
        for (const caveat of caveats) {
            lines.push(`- ${caveat}`);
        }
    }
    lines.push("");

    lines.push(`## Jira candidates (${JIRA_PROJECT}) — proposals, not filed`);
    lines.push("");
    const candidates = jiraCandidates(summary.repo, judgment);
    if (candidates.length === 0) {
        lines.push("- none");
    } else {
        for (const candidate of candidates) {
            const suffix = candidate.url === "" ? "" : ` — ${candidate.url}`;
            lines.push(
                `- \`${candidate.dedupeKey}\` · ${candidate.title}${suffix}`,
            );
        }
    }

    return `${lines.join("\n")}\n`;
};

/* -------------------------------------------------------------------------- */
/* CLI shell                                                                  */
/* -------------------------------------------------------------------------- */

// Run only when invoked directly (the consumer's scheduled workflow), never on
// import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const {readFileSync, writeFileSync} = require("node:fs");
    const {join} = require("node:path");

    const dir = process.argv[2] ?? ".";
    const events = parseEventsJsonl(
        readFileSync(join(dir, "events.jsonl"), "utf8"),
    );
    const meta = JSON.parse(
        readFileSync(join(dir, "collection-meta.json"), "utf8"),
    ) as CollectionMeta;
    const judgment = JSON.parse(
        readFileSync(join(dir, "judgment.json"), "utf8"),
    ) as Judgment;

    const summary = summarize(events, meta, judgment);
    writeFileSync(
        join(dir, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
    );
    writeFileSync(join(dir, "report.md"), renderReport(summary, judgment));
    process.stderr.write(`wrote summary.json and report.md to ${dir}\n`);
}
