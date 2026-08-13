/**
 * Re-review accountability: the deterministic, code-rendered review-body
 * section that accounts for every prior review thread on a re-review.
 *
 * Production motivation (the review-v1.4.0 re-run lifecycle on
 * Khan/webapp#40730): run 2 resolved the threads the author had fixed and said
 * nothing about the rest, leaving three blocking threads open and
 * unacknowledged under a bare "Changes requested" body; run 3 approved with an
 * empty body while resolving 11 threads. Nothing tied the verdict the author
 * reads to the set of prior findings still outstanding. This module renders
 * that accounting from the `thread-reconciler`'s keep/resolve lists, so it is
 * deterministic and testable rather than prompt-trusted.
 *
 * Determinism boundary: CODE owns the section's wording, ordering, counts, and
 * link wrapping; the only free text is an excerpt of each kept thread's
 * opening comment, which is text this workflow itself already posted to the PR
 * on an earlier run, quoted verbatim (then code-truncated). Nothing here
 * composes a new sentence about the code under review.
 *
 * Consumed by `review.md` Step 6: the orchestrator runs the CLI after parsing
 * the reconciler's output and appends the rendered `section` verbatim to the
 * review body. Missing inputs render an empty section (the orchestrator then
 * submits the body unchanged), mirroring the provenance CLI's fail-open
 * stance: a staging gap degrades to today's behavior, never to a hand-composed
 * substitute.
 */

import {isBlockingLabel} from "./render-comment";

/** One staged unresolved bot thread (`threads.json`, review.md Step 3 Phase 2). */
export type StagedThread = {
    thread_id: string;
    path: string;
    /** RIGHT-side line the thread anchors on; null for outdated/file threads. */
    line: number | null;
    /**
     * HTML URL of the thread's first comment
     * (`.../pull/<n>#discussion_r<id>`). Optional: older stagings omit it, and
     * the renderer then falls back to a plain `path:line` token.
     */
    url?: string;
    /** The full reply chain in order; the first entry is the bot's opener. */
    comments: {author: string; body: string}[];
};

/** The `thread-reconciler` result the orchestrator staged to `out/`. */
export type ReconcilerResult = {
    resolve: string[];
    keep: string[];
};

export type RereviewSection = {
    /** Markdown to append to the review body; empty when there is nothing to say. */
    section: string;
    keptCount: number;
    resolvedCount: number;
    /**
     * How many kept threads carry a blocking opening label, plus any whose
     * label could not be parsed (unknown fails closed; see keptEntryFor).
     * The re-review mode dial's flip gate reads this: a reduced-depth run
     * may flip a prior REQUEST_CHANGES to APPROVE only when it is zero (and,
     * in `flip-gated` mode, no validated blocking finding survived), so the
     * check is a number comparison, not a label judgment re-made at verdict
     * time.
     */
    keptBlockingCount: number;
};

/**
 * The plain-text form of the workflow's own label prefix. The staged
 * `threads.json` bodies do not reliably preserve the posted markdown: on
 * Khan/webapp#40561 every staged opener arrived as `thought (non-blocking):
 * ...` with the `**` wrapping stripped, so the bold-only parse failed and
 * every recap line rendered `**unknown**`. The plain form is bound to the
 * closed, code-owned label vocabulary (lowercase, decoration required) so
 * ordinary prose that happens to start with `word:` can never false-match.
 */
const PLAIN_LABEL_RE =
    /^(praise|issue|todo|suggestion|nitpick|question|thought|note)( \([^)\n]{1,60}\)):\s*/;

const BOLD_LABEL_RE = /^\*\*([^*\n]+?):\*\*\s*/;

/**
 * Extract the Conventional-Comment label from a comment body this workflow
 * posted earlier (`**<label>:** <subject>`, review.md Step 5), tolerating the
 * markdown-stripped form the staging has been observed to produce (see
 * {@link PLAIN_LABEL_RE}). Returns null when the body starts with neither
 * form — e.g. a hand-edited or pre-labels-era comment — in which case the
 * caller treats the thread as blocking (fail closed: an unparseable label
 * must not be able to fold a still-open blocking thread into the collapsed
 * recap or let a reduced-depth run flip the verdict past it).
 */
export const parseLeadingLabel = (body: string): string | null => {
    const bold = BOLD_LABEL_RE.exec(body);
    if (bold) {
        return bold[1].trim();
    }
    const plain = PLAIN_LABEL_RE.exec(body);
    return plain ? `${plain[1]}${plain[2]}` : null;
};

/** Deterministic excerpt cap for a kept thread's opening comment. */
const EXCERPT_MAX = 120;

/**
 * The first prose line of a previously-posted comment, with the `**label:**`
 * prefix (or its markdown-stripped plain form, {@link PLAIN_LABEL_RE})
 * stripped and a hard length cap. Quoted verbatim otherwise: this text was
 * already posted to the PR by an earlier run of this workflow.
 */
export const excerptOpeningComment = (body: string): string => {
    const withoutBold = body.replace(BOLD_LABEL_RE, "");
    const withoutLabel =
        withoutBold !== body ? withoutBold : body.replace(PLAIN_LABEL_RE, "");
    const firstLine = withoutLabel.split("\n", 1)[0].trim();
    if (firstLine.length <= EXCERPT_MAX) {
        return firstLine;
    }
    return `${firstLine.slice(0, EXCERPT_MAX).trimEnd()}...`;
};

/** A kept thread joined with its staged data, ready to render. */
type KeptEntry = {
    threadId: string;
    anchor: string;
    url: string | undefined;
    label: string;
    blocking: boolean;
    excerpt: string;
};

const keptEntryFor = (
    threadId: string,
    threads: readonly StagedThread[],
): KeptEntry => {
    const thread = threads.find((t) => t.thread_id === threadId);
    if (thread === undefined) {
        // A keep id the staging does not know. Should not happen (every input
        // thread_id comes from threads.json), but a re-review must still
        // account for it rather than silently dropping the entry.
        return {
            threadId,
            anchor: `thread ${threadId}`,
            url: undefined,
            label: "unknown",
            blocking: true,
            excerpt: "(not in the staged threads)",
        };
    }
    const opener = thread.comments[0]?.body ?? "";
    const label = parseLeadingLabel(opener) ?? "unknown";
    return {
        threadId,
        anchor:
            thread.line === null || thread.line === undefined
                ? thread.path
                : `${thread.path}:${thread.line}`,
        url: thread.url,
        label,
        // An unparseable opener fails CLOSED: the thread renders visibly and
        // counts toward keptBlockingCount (blocking the reduced-depth flip to
        // APPROVE) rather than folding into the collapsed non-blocking block.
        // A staging-corruption mode the two label regexes don't cover would
        // otherwise both hide a still-open blocking thread and let the
        // verdict flip; fail-open here is exactly the #40561 hole. The cost
        // of failing closed is a hand-edited or pre-labels-era thread keeping
        // REQUEST_CHANGES until a full-depth review re-judges it, which is
        // noise, not a wrongly-permitted approval.
        blocking: label === "unknown" || isBlockingLabel(label),
        excerpt: excerptOpeningComment(opener),
    };
};

/** Blocking first, then by anchor (path:line), then by thread id: stable. */
const compareKept = (a: KeptEntry, b: KeptEntry): number => {
    if (a.blocking !== b.blocking) {
        return a.blocking ? -1 : 1;
    }
    if (a.anchor !== b.anchor) {
        return a.anchor < b.anchor ? -1 : 1;
    }
    return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
};

const renderKeptLine = (entry: KeptEntry): string => {
    const anchorToken = `\`${entry.anchor}\``;
    const linked =
        entry.url !== undefined
            ? `[${anchorToken}](${entry.url})`
            : anchorToken;
    return `- **${entry.label}** ${linked}: ${entry.excerpt}`;
};

/**
 * The damped form for a non-blocking thread a prior recap already quoted:
 * label and link, no excerpt. The full excerpt was already posted (twice: the
 * original comment, then the first recap), so re-quoting it on every
 * subsequent push is what built the recap walls the collapse block only
 * partially fixed — the drumbeat reads as the bot re-arguing threads the
 * author is already looking at. The link keeps the accountability contract:
 * every kept thread is still enumerated, just not re-quoted.
 */
const renderKeptLineCompact = (entry: KeptEntry): string => {
    const anchorToken = `\`${entry.anchor}\``;
    const linked =
        entry.url !== undefined
            ? `[${anchorToken}](${entry.url})`
            : anchorToken;
    return `- **${entry.label}** ${linked}`;
};

/**
 * Whether a prior review body already recapped this thread, decided by its
 * opener URL appearing in any staged prior-review body in the RENDERED link
 * form `](url)` (both kept-line renderers emit exactly that, so the first
 * recap plants the marker every later run finds). The closing delimiter is
 * part of the match: a bare substring would false-positive when one
 * discussion id is a prefix of another (r123 vs r1234) or when a prior
 * body's finding PROSE merely mentions the URL, and either way a
 * never-recapped thread would lose its excerpt — the one direction the
 * damping must not fail. A thread with no staged URL reads as never recapped
 * and renders full: fail toward MORE information, since the cost of a wrong
 * "repeat" is an excerpt the reader has to click for, on a thread the bot is
 * actively accounting for.
 */
const previouslyRecapped = (
    entry: KeptEntry,
    priorReviewBodies: readonly string[],
): boolean =>
    entry.url !== undefined &&
    priorReviewBodies.some((body) => body.includes(`](${entry.url})`));

export type RenderRereviewInput = {
    /** The staged unresolved bot threads this run started from. */
    threads: readonly StagedThread[];
    /** The reconciler's verdict over exactly those threads. */
    reconciler: ReconcilerResult;
    /** Head commit of this review; stamped on the still-open header. */
    headSha?: string;
    /**
     * The bodies of this bot's prior reviews on the PR (staged
     * prior-reviews.json), read only to decide which kept non-blocking
     * threads a recap has already quoted. Absent or empty renders every
     * entry full, which is exactly the pre-damping behavior.
     */
    priorReviewBodies?: readonly string[];
};

/**
 * Render the re-review accountability section. Empty when the run started
 * with no unresolved bot threads (a first review, or a PR whose threads are
 * all closed): the section only ever *accounts for prior threads*, so on
 * later pushes with nothing open it renders nothing and the review body is
 * unchanged from today's behavior.
 *
 * Shape: the count header, then each kept *blocking* thread as a visible
 * line, then all kept *non-blocking* threads inside a collapsed `<details>`
 * block headed by their count. Accountability is unchanged (every kept
 * thread renders somewhere); only the notification surface shrinks.
 */
export const renderRereviewSection = (
    input: RenderRereviewInput,
): RereviewSection => {
    const resolvedCount = input.reconciler.resolve.length;
    const keptCount = input.reconciler.keep.length;
    const total = resolvedCount + keptCount;

    if (total === 0) {
        return {section: "", keptCount, resolvedCount, keptBlockingCount: 0};
    }

    if (keptCount === 0) {
        const section =
            resolvedCount === 1
                ? "The 1 prior review thread is resolved."
                : `All ${resolvedCount} prior review threads are resolved.`;
        return {section, keptCount, resolvedCount, keptBlockingCount: 0};
    }

    const asOf =
        input.headSha !== undefined && input.headSha.length > 0
            ? ` as of ${input.headSha.slice(0, 7)}`
            : "";
    const header =
        resolvedCount === 0
            ? `${keptCount} of ${total} prior review ${
                  total === 1 ? "thread is" : "threads are"
              } still unaddressed${asOf}:`
            : `${resolvedCount} of ${total} prior review threads resolved; ` +
              `${keptCount} still unaddressed${asOf}:`;

    const entries = input.reconciler.keep
        .map((id) => keptEntryFor(id, input.threads))
        .sort(compareKept);
    const blocking = entries.filter((entry) => entry.blocking);
    const nonBlocking = entries.filter((entry) => !entry.blocking);

    // Blocking threads render visibly; non-blocking threads fold into a
    // collapsed block with a count. Every kept thread is still accounted for
    // (the accountability contract), but a re-review no longer re-lists every
    // open nit verbatim on every push — the recap walls on Khan/webapp#40561
    // (three in two days, each re-listing all open non-blocking threads) are
    // the motivating pathology.
    const parts: string[] = [header, ...blocking.map(renderKeptLine)];
    if (nonBlocking.length > 0) {
        // First mention full, thereafter label + link: a non-blocking thread
        // some prior recap already quoted renders without its excerpt
        // (blocking threads are never damped — they are the reason the
        // verdict is what it is, and their lines must stand on their own).
        // Fresh entries render first so new information leads the block.
        const priorBodies = input.priorReviewBodies ?? [];
        const fresh = nonBlocking.filter(
            (entry) => !previouslyRecapped(entry, priorBodies),
        );
        const repeats = nonBlocking.filter((entry) =>
            previouslyRecapped(entry, priorBodies),
        );
        const summary =
            (nonBlocking.length === 1
                ? "1 non-blocking thread still open"
                : `${nonBlocking.length} non-blocking threads still open`) +
            (repeats.length > 0
                ? ` (${repeats.length} previously reported)`
                : "");
        parts.push(
            "",
            "<details>",
            `<summary>${summary}</summary>`,
            "",
            ...fresh.map(renderKeptLine),
            ...repeats.map(renderKeptLineCompact),
            "",
            "</details>",
        );
    }

    return {
        section: parts.join("\n"),
        keptCount,
        resolvedCount,
        keptBlockingCount: blocking.length,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI (review.md Step 6 invokes this file directly)                          */
/* -------------------------------------------------------------------------- */

const REVIEW_DIR = "/tmp/gh-aw/review";
const THREADS_PATH = `${REVIEW_DIR}/threads.json`;
const PRIOR_REVIEWS_PATH = `${REVIEW_DIR}/prior-reviews.json`;
const RECONCILER_PATH = `${REVIEW_DIR}/out/thread-reconciler.json`;
const PR_CONTEXT_PATH = `${REVIEW_DIR}/pr-context.json`;
const RESULT_PATH = `${REVIEW_DIR}/rereview.json`;

export type RereviewCliFs = {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string, encoding: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (fs: RereviewCliFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * Defensive parse of the staged prior-review bodies (untrusted-shape JSON on
 * disk, like every staged input this CLI reads). Anything but an array of
 * records with string bodies contributes nothing, and no prior bodies means
 * no damping: every kept thread renders full.
 */
const parsePriorReviewBodies = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : [])
        .filter(isRecord)
        .map((review) => review["body"])
        .filter((body): body is string => typeof body === "string");

/** Defensive parse of the staged threads (untrusted-shape JSON on disk). */
const parseThreads = (raw: unknown): StagedThread[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    const threads: StagedThread[] = [];
    for (const entry of raw) {
        if (!isRecord(entry) || typeof entry["thread_id"] !== "string") {
            continue;
        }
        const comments = Array.isArray(entry["comments"])
            ? entry["comments"].filter(isRecord).map((c) => ({
                  author: typeof c["author"] === "string" ? c["author"] : "",
                  body: typeof c["body"] === "string" ? c["body"] : "",
              }))
            : [];
        threads.push({
            thread_id: entry["thread_id"],
            path: typeof entry["path"] === "string" ? entry["path"] : "",
            line:
                typeof entry["line"] === "number" &&
                Number.isInteger(entry["line"])
                    ? entry["line"]
                    : null,
            url: typeof entry["url"] === "string" ? entry["url"] : undefined,
            comments,
        });
    }
    return threads;
};

const parseReconciler = (raw: unknown): ReconcilerResult | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const ids = (value: unknown): string[] | undefined =>
        Array.isArray(value) && value.every((v) => typeof v === "string")
            ? (value as string[])
            : undefined;
    const resolve = ids(raw["resolve"]);
    const keep = ids(raw["keep"]);
    if (resolve === undefined || keep === undefined) {
        return undefined;
    }
    return {resolve, keep};
};

/**
 * Read the staged inputs, render the section, and write `rereview.json`.
 * Fail-open: any missing or unparseable input renders the empty section, so
 * the orchestrator's fallback is exactly today's review body.
 */
export const runRereviewCli = (fs: RereviewCliFs): RereviewSection => {
    const threads = parseThreads(readJson(fs, THREADS_PATH));
    const reconciler = parseReconciler(readJson(fs, RECONCILER_PATH));

    let result: RereviewSection;
    if (reconciler === undefined) {
        result = {
            section: "",
            keptCount: 0,
            resolvedCount: 0,
            keptBlockingCount: 0,
        };
    } else {
        const prContext = readJson(fs, PR_CONTEXT_PATH);
        const headSha =
            isRecord(prContext) && typeof prContext["headSha"] === "string"
                ? prContext["headSha"]
                : undefined;
        // Prior review bodies feed the recap damping only; a missing or
        // malformed staging reads as no prior reviews, and every kept thread
        // then renders full (fail toward more information).
        const priorReviewBodies = parsePriorReviewBodies(
            readJson(fs, PRIOR_REVIEWS_PATH),
        );
        result = renderRereviewSection({
            threads,
            reconciler,
            headSha,
            priorReviewBodies,
        });
    }

    fs.mkdirSync(REVIEW_DIR, {recursive: true});
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    return result;
};

// Run only when executed directly (review.md Step 6), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as RereviewCliFs;
    const result = runRereviewCli(fs);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result));
}
