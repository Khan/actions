/**
 * The LLM half of the weekly feedback report: judgment over the deterministic
 * `events.jsonl` that `./collect.ts` produced.
 *
 * Three questions a model answers and code cannot:
 *
 *   1. **What happened in this thread?** A human reply on a bot thread is
 *      either the bot being taken up on a finding, the bot being told it is
 *      wrong (with a reason), a question, or a complaint about the surface
 *      itself. Those four are the P4 calibration signal; nothing in the API
 *      distinguishes them.
 *   2. **What keeps coming up?** Recurring themes across threads, so a week's
 *      45 replies collapse into the handful of defects behind them.
 *   3. **What should a human read?** A short notable list, each citing the
 *      comment URL so the claim is checkable.
 *
 * The load-bearing rule, from the design note: **low confidence lands in
 * `unclassified`, never a guess.** The report's numbers are the instrument
 * that sets comment budgets, so an acceptance rate computed over guessed
 * labels is worse than one computed over fewer, honest ones. Every path that
 * cannot produce a confident, schema-valid classification — a malformed model
 * response, a missing thread, a confidence below {@link MIN_CONFIDENCE} —
 * degrades that thread to `unclassified` and appends a warning. Nothing here
 * throws on model output; the renderer prints the warnings as coverage
 * caveats.
 *
 * Structure follows `counters.ts` and `./collect.ts`: a pure core
 * ({@link buildJudgeInput}, {@link judgeFeedback}) that takes an injected
 * {@link JudgeClient} and is fully deterministic — no clock, no filesystem,
 * no network — and a thin CLI shell at the bottom wiring the real Anthropic
 * Messages API the way `eval/judge-live-model.ts` already does it
 * (`ANTHROPIC_API_KEY`). Consumer repos run:
 *
 *     npx -y tsx gh-aw-review-lib/workflows/review/lib/feedback/judge.ts <dir>
 *
 * reading `<dir>/events.jsonl` + `<dir>/collection-meta.json` and writing
 * `<dir>/judgment.json`.
 */

import {z} from "zod";

import type {
    BotInlineCommentEvent,
    CollectionMeta,
    FeedbackEvent,
    HumanReplyEvent,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Judged vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of one human-replied thread. The first four are the design
 * note's categories; `unclassified` is the honesty bucket every uncertain or
 * unparseable case falls into.
 */
export type ThreadClass =
    | "accepted-and-fixed"
    | "declined-with-reasoning"
    | "clarification"
    | "process-complaint"
    | "unclassified";

/** Fixed render/iteration order, so every repo's report reads the same. */
export const THREAD_CLASSES: readonly ThreadClass[] = [
    "accepted-and-fixed",
    "declined-with-reasoning",
    "clarification",
    "process-complaint",
    "unclassified",
];

/**
 * Below this confidence a classification is discarded for `unclassified`.
 * Deliberately blunt: the report would rather under-count a category than
 * report a rate built on the model's coin flips.
 */
export const MIN_CONFIDENCE = 0.6;

/* -------------------------------------------------------------------------- */
/* Pure: what the model is shown                                              */
/* -------------------------------------------------------------------------- */

/** One reply as the judge sees it. */
export type JudgeReply = {
    id: number;
    author: string;
    created_at: string;
    url: string;
    body: string;
};

/**
 * One thread the judge classifies: the bot's opening comment (when the opener
 * is inside the collection window — `collect.ts` keeps replies whose root fell
 * outside it, so `opener` is genuinely optional) plus every human reply.
 */
export type JudgeThread = {
    /** The thread ROOT comment id: the key every judgment is returned under. */
    rootId: number;
    pr: number;
    /** The opener's URL when known, else the first reply's. Always citable. */
    url: string;
    /** Conventional-Comments label of the opener, `""` when unknown. */
    label: string;
    path: string;
    /** The bot's opening finding, or `null` when it fell outside the window. */
    opener: string | null;
    replies: JudgeReply[];
};

/** Everything the judge is asked about in one pass. */
export type JudgeInput = {
    repo: string;
    windowStart: string;
    windowEnd: string;
    threads: JudgeThread[];
};

const isReply = (event: FeedbackEvent): event is HumanReplyEvent =>
    event.kind === "human_reply";

const isBotComment = (event: FeedbackEvent): event is BotInlineCommentEvent =>
    event.kind === "bot_inline_comment";

/**
 * Group the window's human replies into threads by `parentId` (which is always
 * the thread root — see `types.ts`), joining each to its bot opener when the
 * opener was collected. Threads with no human reply are not judged: they carry
 * no prose to classify, and their reactions/resolutions are deterministic
 * numbers the renderer counts directly.
 *
 * Ordering is fully deterministic (threads by root id, replies by id) so the
 * same events always produce the same prompt and the same fixture output.
 */
export const buildJudgeInput = (
    events: readonly FeedbackEvent[],
    meta: CollectionMeta,
): JudgeInput => {
    const openers = new Map<number, BotInlineCommentEvent>();
    for (const event of events) {
        if (isBotComment(event)) {
            openers.set(event.id, event);
        }
    }

    const byRoot = new Map<number, HumanReplyEvent[]>();
    for (const event of events) {
        if (!isReply(event)) {
            continue;
        }
        const bucket = byRoot.get(event.parentId);
        if (bucket === undefined) {
            byRoot.set(event.parentId, [event]);
        } else {
            bucket.push(event);
        }
    }

    const threads: JudgeThread[] = [];
    for (const [rootId, replies] of byRoot) {
        const sorted = [...replies].sort((a, b) => a.id - b.id);
        const opener = openers.get(rootId);
        const first = sorted[0];
        threads.push({
            rootId,
            pr: opener?.pr ?? first?.pr ?? 0,
            url: opener?.url ?? first?.url ?? "",
            label: opener?.label ?? "",
            path: opener?.path ?? "",
            opener: opener?.body ?? null,
            replies: sorted.map((reply) => ({
                id: reply.id,
                author: reply.author,
                created_at: reply.created_at,
                url: reply.url,
                body: reply.body,
            })),
        });
    }
    threads.sort((a, b) => a.rootId - b.rootId);

    return {
        repo: meta.repo,
        windowStart: meta.windowStart,
        windowEnd: meta.windowEnd,
        threads,
    };
};

/* -------------------------------------------------------------------------- */
/* The model seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The injected model. It takes the whole {@link JudgeInput} and returns
 * whatever the model produced — deliberately `unknown`, because the core
 * validates it rather than trusting the client's typing. Tests inject a fake;
 * the CLI shell injects the Anthropic call. Nothing in this module's core
 * imports an API client.
 */
export type JudgeClient = (input: JudgeInput) => Promise<unknown>;

/* -------------------------------------------------------------------------- */
/* Model-output schema                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The shape the model is asked for. Validated per item, not per response, so a
 * single malformed classification costs one thread rather than the week: the
 * outer object accepts arrays of `unknown` and each element is parsed on its
 * own below.
 */
const classificationSchema = z.object({
    threadRootId: z.number(),
    class: z.enum([
        "accepted-and-fixed",
        "declined-with-reasoning",
        "clarification",
        "process-complaint",
        "unclassified",
    ]),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
});

const clusterSchema = z.object({
    /** Short, stable-ish slug; the dedupe key the renderer builds from. */
    key: z.string().min(1),
    title: z.string(),
    commentIds: z.array(z.number()),
});

const notableSchema = z.object({
    commentId: z.number(),
    url: z.string().min(1),
    note: z.string(),
});

const responseSchema = z.object({
    classifications: z.array(z.unknown()).optional(),
    clusters: z.array(z.unknown()).optional(),
    notables: z.array(z.unknown()).optional(),
});

/* -------------------------------------------------------------------------- */
/* Judgment output                                                            */
/* -------------------------------------------------------------------------- */

/** One thread's judged outcome, keyed in {@link Judgment.threads} by root id. */
export type ThreadJudgment = {
    class: ThreadClass;
    /** The model's own confidence, or 0 for anything degraded here. */
    confidence: number;
    /** Model-authored one-liner, passed through verbatim; `""` when degraded. */
    reason: string;
};

/** A recurring theme across threads. */
export type ThemeCluster = {
    key: string;
    title: string;
    /** Comment ids (thread roots or replies) that belong to the theme. */
    commentIds: number[];
};

/** An item worth a human's eyes, always citing a URL. */
export type NotableItem = {
    commentId: number;
    url: string;
    note: string;
};

/** `judgment.json`. */
export type Judgment = {
    repo: string;
    windowStart: string;
    windowEnd: string;
    /** Judged outcome per thread root id (stringified, JSON object keys). */
    threads: Record<string, ThreadJudgment>;
    clusters: ThemeCluster[];
    notables: NotableItem[];
    /**
     * Everything that went wrong without throwing: schema failures, unknown
     * thread ids, missing classifications, low confidence. The renderer prints
     * these as coverage caveats, so a partially-judged week is visibly
     * partial rather than quietly wrong.
     */
    warnings: string[];
};

const UNJUDGED: ThreadJudgment = {
    class: "unclassified",
    confidence: 0,
    reason: "",
};

/**
 * Judge a window's threads. Never throws on model output: a client that
 * rejects, a response that is not an object, an item that fails its schema,
 * an id nobody asked about, or a confidence under {@link MIN_CONFIDENCE} all
 * degrade to `unclassified` plus a warning.
 */
export const judgeFeedback = async (
    events: readonly FeedbackEvent[],
    meta: CollectionMeta,
    client: JudgeClient,
): Promise<Judgment> => {
    const input = buildJudgeInput(events, meta);
    const warnings: string[] = [];
    const threads: Record<string, ThreadJudgment> = {};
    for (const thread of input.threads) {
        threads[String(thread.rootId)] = UNJUDGED;
    }

    const base = {
        repo: meta.repo,
        windowStart: meta.windowStart,
        windowEnd: meta.windowEnd,
        clusters: [] as ThemeCluster[],
        notables: [] as NotableItem[],
    };

    if (input.threads.length === 0) {
        return {...base, threads, warnings};
    }

    let raw: unknown;
    try {
        raw = await client(input);
    } catch (error) {
        warnings.push(
            `judge client failed (${String(
                error,
            )}); all ${input.threads.length} thread(s) left unclassified`,
        );
        return {...base, threads, warnings};
    }

    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
        warnings.push(
            `judge response did not match the expected shape; all ${input.threads.length} thread(s) left unclassified`,
        );
        return {...base, threads, warnings};
    }

    const known = new Set(input.threads.map((thread) => thread.rootId));
    const seen = new Set<number>();
    for (const item of parsed.data.classifications ?? []) {
        const one = classificationSchema.safeParse(item);
        if (!one.success) {
            warnings.push(
                "dropped a classification that failed validation; its thread stays unclassified",
            );
            continue;
        }
        const {threadRootId, confidence} = one.data;
        if (!known.has(threadRootId)) {
            warnings.push(
                `judge classified unknown thread ${threadRootId}; ignored`,
            );
            continue;
        }
        if (seen.has(threadRootId)) {
            warnings.push(
                `judge classified thread ${threadRootId} more than once; kept the first`,
            );
            continue;
        }
        seen.add(threadRootId);
        if (confidence < MIN_CONFIDENCE) {
            warnings.push(
                `thread ${threadRootId} judged "${one.data.class}" at confidence ${confidence} (< ${MIN_CONFIDENCE}); recorded as unclassified`,
            );
            continue;
        }
        threads[String(threadRootId)] = {
            class: one.data.class,
            confidence,
            reason: one.data.reason,
        };
    }

    const missing = input.threads.filter(
        (thread) => !seen.has(thread.rootId),
    ).length;
    if (missing > 0) {
        warnings.push(
            `judge returned no classification for ${missing} thread(s); left unclassified`,
        );
    }

    const clusters: ThemeCluster[] = [];
    const clusterKeys = new Set<string>();
    for (const item of parsed.data.clusters ?? []) {
        const one = clusterSchema.safeParse(item);
        if (!one.success) {
            warnings.push("dropped a theme cluster that failed validation");
            continue;
        }
        if (clusterKeys.has(one.data.key)) {
            warnings.push(
                `dropped a duplicate theme cluster "${one.data.key}"; cluster keys are dedupe keys and must be unique`,
            );
            continue;
        }
        clusterKeys.add(one.data.key);
        clusters.push({
            key: one.data.key,
            title: one.data.title,
            commentIds: [...one.data.commentIds],
        });
    }

    const notables: NotableItem[] = [];
    for (const item of parsed.data.notables ?? []) {
        const one = notableSchema.safeParse(item);
        if (!one.success) {
            warnings.push("dropped a notable item that failed validation");
            continue;
        }
        notables.push({...one.data});
    }

    return {...base, threads, clusters, notables, warnings};
};

/* -------------------------------------------------------------------------- */
/* Prompt (pure; shared by the live client and by prompt tests)               */
/* -------------------------------------------------------------------------- */

/**
 * The pinned judgment model. Classification of a short reply against a short
 * finding is not a frontier task, and the report's numbers are only as good as
 * their reproducibility week over week — so a dated snapshot, matching how
 * `eval/judge.ts` pins its own judge.
 */
export const PINNED_FEEDBACK_JUDGE_MODEL = "claude-haiku-4-5-20251001";

/** Render the one-shot prompt for a whole window. Pure, so it is testable. */
export const buildPrompt = (input: JudgeInput): string => {
    const threads = input.threads.map((thread) => ({
        threadRootId: thread.rootId,
        pr: thread.pr,
        path: thread.path,
        label: thread.label,
        url: thread.url,
        botFinding: thread.opener,
        replies: thread.replies.map((reply) => ({
            id: reply.id,
            author: reply.author,
            body: reply.body,
        })),
    }));
    return [
        "You are auditing one week of feedback on an automated code reviewer's",
        `pull-request comments in ${input.repo} (${input.windowStart} to ${input.windowEnd}).`,
        "",
        "For EVERY thread below, classify what the human replies mean:",
        '  - "accepted-and-fixed": the human agreed and changed the code (or said they would).',
        '  - "declined-with-reasoning": the human disagreed and gave a reason.',
        '  - "clarification": the human asked or answered a question; no verdict.',
        '  - "process-complaint": the human complained about the reviewer itself',
        "    (noise, wrong resolution, repeated findings), not about the code.",
        '  - "unclassified": you are not confident. USE THIS RATHER THAN GUESSING.',
        "",
        `Report confidence honestly in [0,1]; anything under ${MIN_CONFIDENCE} is treated as unclassified.`,
        "",
        "Also: cluster recurring themes across threads (short kebab-case `key`,",
        "one-line `title`, the member comment ids), and flag notable items a human",
        "should read, each citing the comment URL from the input verbatim.",
        "",
        "Return ONLY a JSON object:",
        '{"classifications":[{"threadRootId":<number>,"class":"<class>","confidence":<0..1>,"reason":"<one sentence>"}],',
        ' "clusters":[{"key":"<kebab-case>","title":"<one line>","commentIds":[<number>]}],',
        ' "notables":[{"commentId":<number>,"url":"<url>","note":"<one sentence>"}]}',
        "",
        "Threads:",
        JSON.stringify(threads, null, 2),
    ].join("\n");
};

/* -------------------------------------------------------------------------- */
/* CLI shell                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parse `events.jsonl`, skipping blank and malformed lines. A truncated
 * artifact upload should cost the lines it truncated, not the report.
 */
export const parseEventsJsonl = (text: string): FeedbackEvent[] => {
    const events: FeedbackEvent[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                "kind" in parsed
            ) {
                events.push(parsed as FeedbackEvent);
            }
        } catch {
            // A malformed line is one lost event, not a failed report.
        }
    }
    return events;
};

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

    /**
     * The live client: one Messages API call for the whole window, the same
     * plumbing `eval/judge-live-model.ts` uses. Any failure here surfaces as a
     * rejected promise, which {@link judgeFeedback} turns into warnings plus a
     * fully-unclassified week rather than a failed job — the deterministic
     * numbers are still worth posting when the model is down.
     */
    const liveClient: JudgeClient = async (input) => {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": process.env["ANTHROPIC_API_KEY"] ?? "",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: PINNED_FEEDBACK_JUDGE_MODEL,
                max_tokens: 8192,
                messages: [{role: "user", content: buildPrompt(input)}],
            }),
        });
        if (!response.ok) {
            throw new Error(
                `judge call failed: ${response.status} ${await response.text()}`,
            );
        }
        const data = (await response.json()) as {
            content: {type: string; text?: string}[];
        };
        const text =
            data.content.find((block) => block.type === "text")?.text ?? "";
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start < 0 || end <= start) {
            throw new Error("judge returned no JSON object");
        }
        return JSON.parse(text.slice(start, end + 1));
    };

    judgeFeedback(events, meta, liveClient)
        .then((judgment) => {
            writeFileSync(
                join(dir, "judgment.json"),
                `${JSON.stringify(judgment, null, 2)}\n`,
            );
            for (const warning of judgment.warnings) {
                process.stderr.write(`WARNING: ${warning}\n`);
            }
            process.stderr.write(
                `judged ${Object.keys(judgment.threads).length} thread(s) for ${
                    judgment.repo
                }\n`,
            );
        })
        .catch((error: unknown) => {
            process.stderr.write(`${String(error)}\n`);
            process.exitCode = 1;
        });
}
