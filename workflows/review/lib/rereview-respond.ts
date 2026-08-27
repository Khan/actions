/**
 * The respond-to-review push: the predicate that lets a scoped re-review
 * drop a single push to fast depth when every line it changes answers an
 * open review thread. The depth decision itself lives in rereview-mode.ts
 * (which imports this module and re-exports it, so its callers are
 * unaffected); this module is the predicate and the ONE constructor of its
 * inputs. Split out because rereview-mode.ts sits at the shared eslint
 * config's 1000-line file cap.
 */

import {computeChangedLines} from "./diff";
import {buildScopedDiff} from "./hunk-signature";
import type {HunkSignature} from "./hunk-signature";

/** Changed lines per file: `path → [line, …]` (RIGHT-side lines). */
export type ChangedLineMap = Record<string, number[]>;

/** Open review thread anchors: `path → [line, …]` (RIGHT-side lines). */
export type ThreadAnchors = Record<string, number[]>;

/**
 * How far (in lines) a changed line may sit from a thread anchor and still
 * count as responding to it. A fix rarely lands exactly on the flagged line
 * (the surrounding statement moves, a guard is added above it), and the
 * coverage is per changed line, so an isolated anchor licenses at most
 * 2 * slack + 1 = 7 contiguous changed lines around it; a larger rewrite
 * needs an anchor every 7 lines or it keeps the configured roster.
 * Exported so the eval suite can price other settings.
 */
export const RESPOND_TO_REVIEW_SLACK = 3;

/**
 * The changed lines inside the hunks the anchor fingerprint has not seen:
 * exact `+` lines plus the RIGHT-side lines bracketing each deletion
 * ({@link computeChangedLines}'s `added` and `removedAdjacent`), never a
 * hunk header's extent, which spans git's context lines and would let
 * fresh code ride within one hunk of a thread fix.
 */
export const computeUnreviewedChangedLines = (
    diffText: string,
    reviewed: HunkSignature,
): ChangedLineMap => {
    const map: ChangedLineMap = {};
    const changed = computeChangedLines(buildScopedDiff(diffText, reviewed));
    for (const [path, lines] of Object.entries(changed)) {
        const merged = [
            ...new Set([...lines.added, ...lines.removedAdjacent]),
        ].sort((a, b) => a - b);
        if (merged.length > 0) {
            map[path] = merged;
        }
    }
    return map;
};

/**
 * Whether a push is the respond-to-review shape: at least one open thread
 * exists, and EVERY unreviewed changed line sits within {@link
 * RESPOND_TO_REVIEW_SLACK} lines of an open thread anchor in the same
 * file. Per-line coverage bounds what one thread can license: a contiguous
 * rewrite qualifies only up to 2 * slack + 1 lines around each anchor, so
 * "restructure this function" answered with a 40-line replacement keeps
 * the configured roster even though it touches the flagged line. Zero
 * unreviewed lines (a content-stable rebase) qualifies: nothing new exists
 * to review. Any uncovered line disqualifies the whole push, so a mixed
 * push (thread fixes plus fresh code, same hunk or not) keeps the
 * configured roster; the failure direction is always more review.
 */
export const isRespondToReviewPush = (
    changed: ChangedLineMap,
    anchors: ThreadAnchors,
    slack: number = RESPOND_TO_REVIEW_SLACK,
): boolean => {
    const anchorCount = Object.values(anchors).reduce(
        (sum, lines) => sum + lines.length,
        0,
    );
    if (anchorCount === 0) {
        return false;
    }
    return Object.entries(changed).every(([path, lines]) =>
        lines.every((line) =>
            (anchors[path] ?? []).some(
                (anchor) => Math.abs(anchor - line) <= slack,
            ),
        ),
    );
};

/** The slice of `fs` the thread-file reads need (injectable for tests). */
export type RespondFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
};

// The staged thread partition (stage-pr.ts writes both before the plan CLI
// runs). The directory mirrors rereview-mode.ts's REVIEW_DIR.
const BOT_THREADS_PATH = "/tmp/gh-aw/review/threads.json";
const HUMAN_THREADS_PATH = "/tmp/gh-aw/review/human-threads.json";

const readJsonIfPresent = (fs: RespondFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/**
 * Build the respond-to-review inputs for rereview-mode.ts's
 * decideReReviewDepth from the staged thread partition and the unreviewed
 * changed lines vs the anchor fingerprint. This is the ONE constructor of
 * those inputs; any caller of the decider that wants the drop must build
 * them here, because it also enforces the bot-thread gate: human anchors
 * count toward matching (the conversation tracks the defect either way),
 * but the drop needs at least one line-anchored BOT thread. dispatch.ts
 * derives `hasThreads` from threads.json alone, so at fast depth a
 * human-only drop would dispatch an empty roster (no finders, nothing for
 * the reconciler to reconcile).
 *
 * Returns undefined (drop disabled) without a usable diff, anchor
 * fingerprint, or bot anchor; missing thread files or line-less threads
 * only leave the anchor map empty, which isRespondToReviewPush treats as
 * no match. Either way the round runs at the configured mode, more review
 * rather than less.
 */
export const collectRespondToReviewInputs = (
    fs: RespondFs,
    diffText: string | null,
    anchorHunks: HunkSignature | "overflow" | undefined,
):
    | {
          unreviewedChangedLines: ChangedLineMap;
          openThreadAnchors: ThreadAnchors;
      }
    | undefined => {
    const anchors: ThreadAnchors = {};
    let botAnchors = 0;
    for (const path of [BOT_THREADS_PATH, HUMAN_THREADS_PATH]) {
        const raw = readJsonIfPresent(fs, path);
        for (const entry of Array.isArray(raw) ? raw : []) {
            const thread = entry as {path?: unknown; line?: unknown};
            if (
                typeof thread.path === "string" &&
                typeof thread.line === "number"
            ) {
                (anchors[thread.path] ??= []).push(thread.line);
                if (path === BOT_THREADS_PATH) {
                    botAnchors++;
                }
            }
        }
    }
    if (
        botAnchors === 0 ||
        diffText === null ||
        anchorHunks === undefined ||
        anchorHunks === "overflow"
    ) {
        return undefined;
    }
    return {
        unreviewedChangedLines: computeUnreviewedChangedLines(
            diffText,
            anchorHunks,
        ),
        openThreadAnchors: anchors,
    };
};
