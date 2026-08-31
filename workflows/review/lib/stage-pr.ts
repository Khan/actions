/**
 * Pre-agent staging: everything review.md Steps 1 and 3 used to have the
 * orchestrator fetch, compute, or invoke that never needed model output, run
 * as one deterministic step before the agent starts (slice 1 of the
 * deterministic-orchestrator migration; scoped 07-13 out of John's #246
 * review). The orchestrator wakes with files on disk instead of spending its
 * opening turns on GitHub fetches and CLI invocations, and the dispatch gate
 * (dispatch-gate.ts) stops trusting the orchestrator to have staged its own
 * rule inputs honestly.
 *
 * What it stages under /tmp/gh-aw/review/ (the Step 1 contract):
 *
 *   pr-context.json     PR metadata (untrusted author text included verbatim)
 *   ticket-context.json the linked Jira tickets (stage-ticket.ts): every
 *                       issue key the PR references, resolved and fetched
 *                       read-only when the consumer configures credentials;
 *                       otherwise (and when none resolve) {available: false,
 *                       reason}. A ticket is context, never a prerequisite.
 *   files.json          path/status/hasPatch per changed file
 *   full.diff           standard unified diff rebuilt from the per-file
 *                       patches (diff --git + ---/+++ headers per file, which
 *                       is what the provenance parser requires)
 *   diff-facts.json     the diff fingerprint (per-file patch SHA-256) and the
 *                       added-lines hunk signature, so Step 2 compares and
 *                       Step 9 saves values computed by code, not by the model
 *   new-scope.json      {priorReview, inScope} against cache memory's
 *                       reviewedHunks (missing/unparseable cache degrades to
 *                       "everything in scope": more review, never less)
 *   prior-reviews.json  every github-actions[bot] review body, all states,
 *                       with the numeric review id and state (the
 *                       reduced-depth clearance dismisses by id; fetch
 *                       failure degrades to [], which forces a full review
 *                       downstream, never a cheaper one)
 *   threads.json        the unresolved review threads THIS bot opened, each
 *                       with its full reply chain verbatim, `resolved: false`,
 *                       and the opener's html_url
 *   human-threads.json  the `{path, line}` of every unresolved thread someone
 *                       ELSE opened, which the dispatcher defers to
 *   adjudicated-threads.json  the bot's threads a HUMAN resolved or
 *                       downvoted, which the dispatcher's adjudicated
 *                       suppression reads so a settled defect is not
 *                       re-derived under fresh wording
 *   disciplines.md      the marker-delimited shared-disciplines section, cut
 *                       out of the rendered prompt (slice 3, #247)
 *   routing.json        the router's deterministic first pass (a non-empty
 *                       pendingRiskQuestions still gets the orchestrator's
 *                       one small-model call and second router pass mid-run;
 *                       generatedFiles and reReviewMode are pass-stable, so
 *                       everything staged below stays valid either way)
 *   provenance.json, full-stripped.diff, full-stripped-annotated.diff
 *                       the provenance CLI's derived diff artifacts
 *   rereview-plan.json (+ the out/ copy), scoped.diff
 *                       the re-review depth plan; when it stages new-hunks
 *                       the scoped swap happens here too (full-stripped.diff
 *                       and its annotated sibling overwritten; at flip-gated
 *                       depth pr.diff / pr-annotated.diff / review-files.json
 *                       are staged from scoped.diff, since no triage runs)
 *
 * Deliberately NOT staged here: pr.diff at full/scoped depth (it is derived
 * from pattern-triage's reviewFiles, which is model output) and
 * author-disputes.json (a judgment about what a reply chain concedes, which is
 * the one thread-derived input that is genuinely model work). The router's
 * second pass stays mid-run by design.
 *
 * Parity: the eval's live producer stages cases through the same lib
 * functions this module calls (eval/live-stage.ts: route, computeDiffProvenance,
 * decideReReviewDepth, buildScopedDiff, annotateDiffLineNumbers), so the A/B
 * keeps measuring the production pipeline.
 *
 * Failure stance: the PR metadata, file, and review-thread fetches are hard
 * prerequisites (no staging, no review; the step fails before any AI spend).
 * Threads join that list rather than degrading to `[]` because an empty
 * staging is not the conservative direction: it silently drops the flip gate's
 * `keptBlockingCount` to zero, and a reduced-depth re-review may then flip a
 * prior REQUEST_CHANGES to APPROVE past still-open blocking threads nobody
 * read (submission.ts's `keptBlockingFloor`). A failed fetch is also usually
 * transient, and the review re-runs on the next push. Everything else
 * downstream degrades toward MORE review, never less, matching the CLIs it
 * wraps. The added-lines hunk hash is computed here exactly as Step 1
 * specified it for the orchestrator (leading `+` stripped, trailing
 * whitespace trimmed, newline-joined); a prior run whose model-computed
 * hash disagreed simply leaves those hunks in scope: over-review on the
 * transition, never a skipped hunk.
 *
 * Determinism boundary: GitHub fetches plus pure functions of their results;
 * no model call, no prose about the code under review.
 */

import {createHash} from "node:crypto";

import {
    annotateDiffLineNumbers,
    splitPatchHunks,
    splitUnifiedDiff,
} from "./diff";
import {runProvenanceCli} from "./provenance";
import type {StagedThread} from "./rereview";
import {stageTicketContext, type TicketFetch} from "./stage-ticket";
import {runRereviewPlanCli} from "./rereview-mode";
import {runCli as runRouterCli} from "./router";
import {
    collectReviewThreads,
    isReviewBotAuthor,
    withGraphqlRateLimitRetry,
    type GhGraphql,
} from "./threads";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

const REVIEW_DIR = "/tmp/gh-aw/review";
const OUT_DIR = `${REVIEW_DIR}/out`;
const CACHE_MEMORY_DIR = "/tmp/gh-aw/cache-memory";

/**
 * One named constant per staged path (the sibling CLIs' convention), so a
 * typo cannot silently desync a filename from the CLI or sub-agent that
 * reads it.
 */
const PR_CONTEXT_OUT = `${REVIEW_DIR}/pr-context.json`;
const TICKET_CONTEXT_OUT = `${REVIEW_DIR}/ticket-context.json`;
const FILES_OUT = `${REVIEW_DIR}/files.json`;
const FULL_DIFF_OUT = `${REVIEW_DIR}/full.diff`;
const DIFF_FACTS_OUT = `${REVIEW_DIR}/diff-facts.json`;
const NEW_SCOPE_OUT = `${REVIEW_DIR}/new-scope.json`;
const PRIOR_REVIEWS_OUT = `${REVIEW_DIR}/prior-reviews.json`;
const THREADS_OUT = `${REVIEW_DIR}/threads.json`;
const HUMAN_THREADS_OUT = `${REVIEW_DIR}/human-threads.json`;
const ADJUDICATED_THREADS_OUT = `${REVIEW_DIR}/adjudicated-threads.json`;
const ROUTING_OUT = `${REVIEW_DIR}/routing.json`;
const PROVENANCE_OUT = `${REVIEW_DIR}/provenance.json`;
const STRIPPED_DIFF_OUT = `${REVIEW_DIR}/full-stripped.diff`;
const ANNOTATED_DIFF_OUT = `${REVIEW_DIR}/full-stripped-annotated.diff`;
const PLAN_OUT = `${REVIEW_DIR}/rereview-plan.json`;
const PLAN_ARTIFACT_OUT = `${OUT_DIR}/rereview-plan.json`;
const SCOPED_DIFF_PATH = `${REVIEW_DIR}/scoped.diff`;
const PR_DIFF_OUT = `${REVIEW_DIR}/pr.diff`;
const PR_ANNOTATED_OUT = `${REVIEW_DIR}/pr-annotated.diff`;
const REVIEW_FILES_OUT = `${REVIEW_DIR}/review-files.json`;
const DISCIPLINES_OUT = `${REVIEW_DIR}/disciplines.md`;

export type StagePrFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

/**
 * One authenticated GitHub API GET, returning parsed JSON. `path` is
 * api-root-relative (`/repos/...`). Injected so tests never touch the
 * network; the default implementation lives in the CLI entry.
 */
export type GhGet = (path: string) => Promise<unknown>;

/** The per-file shape GET /pulls/{n}/files returns (fields read here). */
type PullFile = {
    filename: string;
    status: string;
    patch?: string;
    additions?: number;
    deletions?: number;
    previous_filename?: string;
};

export type StagePrOptions = {
    /** `owner/repo` (production: `$GITHUB_REPOSITORY`). */
    repo: string;
    prNumber: number;
    /** The PR checkout the router/provenance read repo files from. */
    repoRoot: string;
    /** Env forwarded to the router (`REVIEW_MAX_AI_CREDITS`). */
    env?: Record<string, string | undefined>;
    /** Cache-memory dir override (tests). */
    cacheMemoryDir?: string;
    /** Rendered-prompt path override (tests); default gh-aw's prompt.txt. */
    promptPath?: string;
};

export type StagePrResult = {
    /** Absolute paths written, in order. */
    staged: string[];
    /** Non-fatal degradations, fixed-format. */
    warnings: string[];
    /** The re-review depth the plan staged (informational). */
    depth: string;
    changedFileCount: number;
    /**
     * How many unresolved threads landed in each file. Logged by the CLI, for
     * the same reason #302 needed a tripwire: an empty `threads.json` on a PR
     * that has open bot threads is invisible in every downstream report, so
     * the count belongs in the step log where a human diagnosing a re-review
     * can see it.
     */
    botThreadCount: number;
    humanThreadCount: number;
};

/* -------------------------------------------------------------------------- */
/* Pure pieces                                                                */
/* -------------------------------------------------------------------------- */

const sha256 = (text: string): string =>
    createHash("sha256").update(text).digest("hex");

/**
 * Rebuild the standard unified diff from per-file patches, exactly as Step 1
 * specified it: a `diff --git a/<old> b/<new>` header per file (real names on
 * both sides, matching git's own delete/add headers), `---`/`+++` lines with
 * `/dev/null` for an added/deleted side, then the patch hunks verbatim. Files
 * without a patch (binary / too large) contribute nothing.
 */
export const buildUnifiedDiff = (files: PullFile[]): string => {
    const sections: string[] = [];
    for (const file of files) {
        if (file.patch === undefined || file.patch === "") {
            continue;
        }
        const newPath = file.filename;
        const oldPath = file.previous_filename ?? file.filename;
        const oldSide = file.status === "added" ? "/dev/null" : `a/${oldPath}`;
        const newSide =
            file.status === "removed" ? "/dev/null" : `b/${newPath}`;
        sections.push(
            [
                `diff --git a/${oldPath} b/${newPath}`,
                `--- ${oldSide}`,
                `+++ ${newSide}`,
                file.patch,
            ].join("\n"),
        );
    }
    return sections.length === 0 ? "" : `${sections.join("\n")}\n`;
};

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The Step 1 added-lines hunk hash: SHA-256 of the hunk's `+` lines, leading
 * `+` stripped, trailing whitespace trimmed, newline-joined in order. This is
 * the comment-scoping signature (`reviewedHunks`), distinct from the
 * re-review stamp's +/- signature in rereview-mode.ts.
 */
export const hashHunkAddedLines = (hunkText: string): string =>
    sha256(
        hunkText
            .split("\n")
            // Every `+`-prefixed hunk-body line is an added line: per-file
            // patches carry no `+++` file headers inside hunks, and an added
            // source line whose content starts with `++` serializes as
            // `+++...`, so a header-shaped exclusion would silently drop it
            // from the hash (and desync it from hunkAddedLineNumbers below).
            .filter((line) => line.startsWith("+"))
            .map((line) => line.slice(1).replace(/\s+$/, ""))
            .join("\n"),
    );

/** The RIGHT-side line numbers of a hunk's added lines. */
const hunkAddedLineNumbers = (hunkText: string): number[] => {
    const lines = hunkText.split("\n");
    const header = HUNK_HEADER_RE.exec(lines[0] ?? "");
    if (header === null) {
        return [];
    }
    let right = Number(header[1]);
    const added: number[] = [];
    for (const line of lines.slice(1)) {
        if (line.startsWith("+")) {
            added.push(right);
            right += 1;
        } else if (line.startsWith("-") || line.startsWith("\\")) {
            // LEFT-only / no-newline marker: RIGHT side does not advance.
        } else {
            right += 1;
        }
    }
    return added;
};

export type NewScope = {
    priorReview: boolean;
    inScope: Record<string, number[]>;
};

/**
 * The newly-changed-code scope (review.md Step 1): a hunk is in scope when
 * its added-lines hash is not in the previous run's `reviewedHunks[path]`.
 * `reviewedHunks` absent (no prior review, evicted cache, or a shape this
 * parser does not recognize) puts the whole diff in scope.
 */
export const computeNewScope = (
    files: PullFile[],
    reviewedHunks: unknown,
): NewScope => {
    const prior =
        typeof reviewedHunks === "object" &&
        reviewedHunks !== null &&
        !Array.isArray(reviewedHunks)
            ? (reviewedHunks as Record<string, unknown>)
            : undefined;
    if (prior === undefined) {
        return {priorReview: false, inScope: {}};
    }
    const inScope: Record<string, number[]> = {};
    for (const file of files) {
        if (file.patch === undefined || file.patch === "") {
            continue;
        }
        const seenRaw = prior[file.filename];
        const seen = new Set(
            Array.isArray(seenRaw)
                ? seenRaw.filter((h): h is string => typeof h === "string")
                : [],
        );
        const lines: number[] = [];
        for (const hunk of splitPatchHunks(file.patch)) {
            if (!seen.has(hashHunkAddedLines(hunk))) {
                lines.push(...hunkAddedLineNumbers(hunk));
            }
        }
        if (lines.length > 0) {
            inScope[file.filename] = lines;
        }
    }
    return {priorReview: true, inScope};
};

/** The Step 1 / Step 9 diff fingerprint: per-file patch SHA-256, sorted. */
export const computeDiffFingerprint = (
    files: PullFile[],
): Record<string, string> => {
    const fingerprint: Record<string, string> = {};
    for (const file of [...files].sort((a, b) =>
        a.filename < b.filename ? -1 : 1,
    )) {
        fingerprint[file.filename] =
            file.patch !== undefined && file.patch !== ""
                ? sha256(file.patch)
                : sha256(
                      `${file.status}/${file.additions ?? 0}/${
                          file.deletions ?? 0
                      }`,
                  );
    }
    return fingerprint;
};

/* -------------------------------------------------------------------------- */
/* The staging run                                                            */
/* -------------------------------------------------------------------------- */

const fetchAllFiles = async (
    ghGet: GhGet,
    repo: string,
    prNumber: number,
): Promise<PullFile[]> => {
    const files: PullFile[] = [];
    for (let page = 1; ; page++) {
        const batch = (await ghGet(
            `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        )) as PullFile[];
        if (!Array.isArray(batch)) {
            throw new Error("GET /pulls/{n}/files returned a non-array");
        }
        files.push(...batch);
        if (batch.length < 100) {
            return files;
        }
    }
};

export const runStagePrCli = async (
    fs: StagePrFs,
    ghGet: GhGet,
    ghGraphql: GhGraphql,
    ticketFetch: TicketFetch,
    options: StagePrOptions,
): Promise<StagePrResult> => {
    const {repo, prNumber, repoRoot} = options;
    const env = options.env ?? {};
    const cacheDir = options.cacheMemoryDir ?? CACHE_MEMORY_DIR;
    // Canary staging (REVIEW_CANARY=1, set only by the canary workflow that
    // dogfoods an unreleased reviewer on a labeled PR): every carrier of the
    // production reviewer's own history is staged empty, so the run reviews
    // like a first encounter with the PR. Both workflows post as the same bot
    // identity, so without this the canary would read the production run's
    // reviews, threads, and stamps as its own: its re-review plan would scope
    // to hunks the PRODUCTION reviewer covered, and its reconciler would
    // adjudicate threads the production reviewer opened. Human threads stay
    // staged; they are PR context any first review would see, not reviewer
    // history.
    const canary = env.REVIEW_CANARY === "1";
    const staged: string[] = [];
    const warnings: string[] = [];
    if (canary) {
        warnings.push(
            "canary staging (REVIEW_CANARY=1): prior bot reviews, bot threads, adjudicated threads, and cache memory staged empty; depth degrades to full",
        );
    }
    const write = (path: string, data: string): void => {
        fs.writeFileSync(path, data);
        staged.push(path);
    };

    fs.mkdirSync(OUT_DIR, {recursive: true});

    // 1. PR metadata → pr-context.json (hard prerequisite).
    const pr = (await ghGet(`/repos/${repo}/pulls/${prNumber}`)) as {
        number?: number;
        title?: string;
        body?: string | null;
        user?: {login?: string};
        base?: {ref?: string};
        head?: {sha?: string; ref?: string};
        draft?: boolean;
    };
    if (
        typeof pr.head?.sha !== "string" ||
        pr.head.sha === "" ||
        typeof pr.base?.ref !== "string" ||
        pr.base.ref === ""
    ) {
        // Metadata is a hard prerequisite: an empty headSha or base ref would
        // flow into Step 2's merge-parent check and every sub-agent context.
        throw new Error(
            `PR metadata missing load-bearing fields (head.sha/base.ref) for ${repo}#${prNumber}`,
        );
    }
    write(
        PR_CONTEXT_OUT,
        JSON.stringify(
            {
                number: pr.number ?? prNumber,
                title: pr.title ?? "",
                description: pr.body ?? "",
                author: pr.user?.login ?? "",
                baseBranch: pr.base?.ref ?? "",
                headSha: pr.head?.sha ?? "",
                isDraft: pr.draft === true,
                repo,
                diffPath: FULL_DIFF_OUT,
                filesPath: FILES_OUT,
            },
            null,
            2,
        ),
    );

    // 1b. The linked Jira tickets → ticket-context.json (never a
    // prerequisite: every degradation stages {available: false, reason} and
    // the intent-reading sub-agents fall back to the PR description).
    // stage-ticket.ts owns every degradation shape, including the
    // unconfigured one, so an env without REVIEW_JIRA_* never fetches.
    const ticket = await stageTicketContext(ticketFetch, {
        baseUrl: env.REVIEW_JIRA_BASE_URL ?? "",
        email: env.REVIEW_JIRA_EMAIL ?? "",
        apiToken: env.REVIEW_JIRA_API_TOKEN ?? "",
        title: pr.title ?? "",
        headBranch: pr.head?.ref ?? "",
        description: pr.body ?? "",
    });
    warnings.push(...ticket.warnings);
    write(TICKET_CONTEXT_OUT, JSON.stringify(ticket.context, null, 2));

    // 2. Changed files → files.json + full.diff (hard prerequisite).
    const files = await fetchAllFiles(ghGet, repo, prNumber);
    write(
        FILES_OUT,
        JSON.stringify(
            files.map((file) => ({
                path: file.filename,
                status: file.status,
                hasPatch: file.patch !== undefined && file.patch !== "",
            })),
            null,
            2,
        ),
    );
    write(FULL_DIFF_OUT, buildUnifiedDiff(files));

    // 3. Code-computed diff facts: the fingerprint Step 2 compares and the
    // hunk signature Step 9 saves as reviewedHunks.
    write(
        DIFF_FACTS_OUT,
        JSON.stringify(
            {
                diffFingerprint: computeDiffFingerprint(files),
                hunkSignature: Object.fromEntries(
                    files
                        .filter(
                            (file) =>
                                file.patch !== undefined && file.patch !== "",
                        )
                        .map((file) => [
                            file.filename,
                            splitPatchHunks(file.patch as string).map(
                                hashHunkAddedLines,
                            ),
                        ]),
                ),
            },
            null,
            2,
        ),
    );

    // 4. new-scope.json against cache memory's reviewedHunks. A canary run
    // ignores the cache record: its scope is always the whole diff.
    let reviewedHunks: unknown;
    const cachePath = `${cacheDir}/pr-${prNumber}.json`;
    if (!canary && fs.existsSync(cachePath)) {
        try {
            reviewedHunks = (
                JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
                    reviewedHunks?: unknown;
                }
            ).reviewedHunks;
        } catch {
            warnings.push(
                `cache memory unparseable (${cachePath}): whole diff in scope`,
            );
        }
    }
    write(
        NEW_SCOPE_OUT,
        JSON.stringify(computeNewScope(files, reviewedHunks), null, 2),
    );

    // 5. Prior bot reviews (fetch failure degrades to []: full review). A
    // canary run stages [] without fetching: the reviews on the PR are the
    // production reviewer's, not this code's.
    let priorReviews: {
        body: string;
        submittedAt?: string;
        id?: number;
        state?: string;
    }[] = [];
    try {
        type RawReview = {
            id?: number;
            state?: string;
            user?: {login?: string};
            body?: string | null;
            submitted_at?: string;
        };
        const reviews: RawReview[] = [];
        if (!canary) {
            for (let page = 1; ; page++) {
                const batch = (await ghGet(
                    `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
                )) as RawReview[];
                if (!Array.isArray(batch)) {
                    throw new Error(
                        "GET /pulls/{n}/reviews returned a non-array",
                    );
                }
                reviews.push(...batch);
                if (batch.length < 100) {
                    break;
                }
            }
        }
        priorReviews = reviews
            // REST renders this account as `github-actions[bot]`; the shared
            // predicate accepts GraphQL's bare spelling too, so the producer
            // and the suppression guard cannot drift apart on the identity
            // (threads.ts, and the #302 postmortem it carries).
            .filter((review) => isReviewBotAuthor(review.user?.login ?? ""))
            .map((review) => ({
                body: review.body ?? "",
                ...(typeof review.submitted_at === "string"
                    ? {submittedAt: review.submitted_at}
                    : {}),
                // The numeric review id and state feed the reduced-depth
                // clearance (submission.ts): a CHANGES_REQUESTED review's id
                // is what the dismissal post-step dismisses. Optional so an
                // older reader is unaffected; a staging without them skips
                // the dismissal (the block stands).
                ...(typeof review.id === "number" ? {id: review.id} : {}),
                ...(typeof review.state === "string"
                    ? {state: review.state}
                    : {}),
            }));
    } catch (error) {
        warnings.push(
            `prior-reviews fetch failed (${
                error instanceof Error ? error.message : String(error)
            }): staged []; re-review degrades to full`,
        );
    }
    write(PRIOR_REVIEWS_OUT, JSON.stringify(priorReviews, null, 2));

    // 5b. The unresolved review threads, split by who opened them. This was
    // the last load-bearing staging left in the prompt: review.md Step 3 asked
    // the ORCHESTRATOR to fetch the threads and write both files in a
    // particular shape, and everything downstream then depended on a
    // model-produced file: `hasThreads` (which decides whether the
    // thread-reconciler is dispatched at all, so it changes the roster),
    // open-thread suppression (dedup-threads.ts), and the accountability recap
    // (rereview.ts). Khan/actions#302 patched a symptom of that seam: a
    // CONFORMING staging produced zero usable threads for a whole release
    // because the prompt's selection rule and the code's guard spelled the
    // bot's login differently. Code on both sides of one shared predicate
    // (threads.ts's `isReviewBotAuthor`) is what removes the seam rather than
    // re-patching it.
    //
    // The misfiling direction matters more than a duplicate comment: a BOT
    // thread landing in human-threads.json becomes a `skipLines` entry, and
    // the submission then DROPS a fresh finding on that line instead of merely
    // duplicating one. Hence one fetch, one partition: a thread is in exactly
    // one file, and neither list is assembled by hand.
    const [owner = "", repoName = ""] = repo.split("/");
    const fetchedThreads = await collectReviewThreads(
        ghGraphql,
        owner,
        repoName,
        prNumber,
    );
    // The unresolved partition, in the exact `StagedThread` shape every
    // downstream reader of threads.json / human-threads.json already parses:
    // the resolution and reaction fields are stripped, not carried, because
    // both files serialize these objects verbatim.
    const allThreads = fetchedThreads
        .filter((thread) => !thread.resolved)
        .map(
            ({
                resolved: _resolved,
                resolvedBy: _resolvedBy,
                openerDownvotes: _openerDownvotes,
                ...thread
            }) => thread,
        );
    // The OPENER decides which file a thread lands in (its opening comment is
    // the finding), so a thread with no opener at all is staged in NEITHER. A
    // real review thread always has one and a partial GraphQL response throws
    // upstream, but an unattributable thread staged as human would put a
    // `skipLines` entry on a line that may be the bot's own, and that drops a
    // fresh finding; left out, the worst case is a comment landing where a
    // human conversation is open, which is noise.
    //
    // "No opener" is two shapes, not one: no opening comment at all, and an
    // opening comment whose `author` is null (a deleted account), which
    // `threads.ts` maps to "". Only the first is absent; the empty string is a
    // login that matches no bot, so testing for `undefined` alone would send a
    // null-authored thread down the human path the comment above rules out.
    const openerAuthor = (thread: StagedThread): string | undefined => {
        const author = thread.comments[0]?.author;
        return author === undefined || author === "" ? undefined : author;
    };
    const openedByBot = (thread: StagedThread): boolean => {
        const author = openerAuthor(thread);
        return author !== undefined && isReviewBotAuthor(author);
    };
    const openedByHuman = (thread: StagedThread): boolean => {
        const author = openerAuthor(thread);
        return author !== undefined && !isReviewBotAuthor(author);
    };
    const botThreads = canary ? [] : allThreads.filter(openedByBot);
    write(
        THREADS_OUT,
        JSON.stringify(
            botThreads.map((thread) => ({
                ...thread,
                // Unresolved by construction (the partition above drops
                // resolved threads), but written anyway: dedup-threads.ts requires an
                // explicit `resolved: false` and fails closed without one.
                // That guard stays deliberately, rather than trusting this
                // producer.
                resolved: false,
            })),
            null,
            2,
        ),
    );
    // 5b'. The adjudicated corpus: bot-opened threads a HUMAN resolved, or
    // whose opening comment a reviewer downvoted. A human resolving a bot
    // thread is the strongest "this is settled" signal the PR surface
    // carries, and before this file existed it was also an anti-signal:
    // resolution removed the thread from threads.json, so the suppression
    // corpus, so the next run was free to re-derive the same defect with
    // fresh wording as a brand-new thread (webapp#41290: six resolved
    // variants of one concern at moderation_helpers.go:135, then a seventh
    // posted anyway). A 👎 on the opener is the same judgment delivered
    // through the OTHER feedback channel the bot advertises, and before
    // this it dead-ended in the retired thumbs sweep's counters. dedup-adjudicated.ts's suppression reads this
    // file; only non-blocking candidates are suppressed by it, so a genuine
    // regression re-flag at blocking severity always posts.
    //
    // The resolver identity decides resolution membership, not resolution
    // alone: a thread the BOT resolved (the reconciler, after a code change
    // addressed it) is a fixed defect, and a fixed defect that reappears is
    // a fresh finding that must post. `resolvedBy` is "" for an
    // unattributable resolver (a deleted account), which fails toward
    // posting a duplicate, never toward suppression on unverifiable
    // authority. A downvoted thread joins whatever its resolution state:
    // still-open downvoted threads are also in threads.json, and the
    // composed suppression attributes a candidate matching both corpora to
    // the OPEN thread, whose blocking state floors the verdict.
    const adjudicatedThreads = fetchedThreads.filter(
        (thread) =>
            !canary &&
            openedByBot(thread) &&
            ((thread.resolved &&
                thread.resolvedBy !== "" &&
                !isReviewBotAuthor(thread.resolvedBy)) ||
                thread.openerDownvotes > 0),
    );
    write(ADJUDICATED_THREADS_OUT, JSON.stringify(adjudicatedThreads, null, 2));
    // The reconciler echoes these into `skipLines`, so a thread with no
    // RIGHT-side line (outdated, or file-level) has nothing to contribute and
    // is dropped rather than staged as a line the submission cannot match.
    // Deduplicated on `path:line`: several human threads routinely share one
    // line, and the reconciler's echo would repeat each of them.
    const humanLines = new Map<string, {path: string; line: number}>();
    for (const thread of allThreads) {
        if (
            !openedByHuman(thread) ||
            thread.path === "" ||
            thread.line === null
        ) {
            continue;
        }
        humanLines.set(`${thread.path}:${thread.line}`, {
            path: thread.path,
            line: thread.line,
        });
    }
    write(HUMAN_THREADS_OUT, JSON.stringify([...humanLines.values()], null, 2));

    // 5c. The shared disciplines (#247: extraction becomes a pre-step, its
    // verify becomes code). The specialist-lens disciplines live once in the
    // rendered prompt; the marker-delimited section is extracted mechanically
    // and verified to carry the schema section every lens depends on. A
    // failed extraction is a warning, not a crash: the orchestrator prompt
    // keeps a byte-for-byte fallback for exactly that case.
    const promptPath = options.promptPath ?? "/tmp/gh-aw/aw-prompts/prompt.txt";
    if (fs.existsSync(promptPath)) {
        const promptLines = fs.readFileSync(promptPath, "utf8").split("\n");
        const from = promptLines.indexOf("<!-- BEGIN REVIEW DISCIPLINES -->");
        const to = promptLines.indexOf("<!-- END REVIEW DISCIPLINES -->");
        const section =
            from !== -1 && to > from
                ? `${promptLines.slice(from, to + 1).join("\n")}\n`
                : null;
        if (
            section !== null &&
            section.includes("## Structured finding schema and hunts")
        ) {
            write(DISCIPLINES_OUT, section);
        } else {
            warnings.push(
                section === null
                    ? `disciplines markers not found in ${promptPath}: not staged (orchestrator fallback applies)`
                    : "disciplines section fails the schema-heading verify: not staged (orchestrator fallback applies)",
            );
        }
    } else {
        warnings.push(
            `rendered prompt not found (${promptPath}): disciplines not staged (orchestrator fallback applies)`,
        );
    }

    // 6-8. The deterministic CLI chain, in the order review.md Step 3 ran it:
    // router pass 1 → provenance → re-review plan.
    runRouterCli(fs, repoRoot, env);
    staged.push(ROUTING_OUT);
    runProvenanceCli(fs, repoRoot);
    staged.push(PROVENANCE_OUT, STRIPPED_DIFF_OUT, ANNOTATED_DIFF_OUT);
    const {plan, warnings: planWarnings, stampSource} = runRereviewPlanCli(fs);
    warnings.push(...planWarnings);
    staged.push(PLAN_OUT);
    // Mirror the staged plan verbatim, stampSource included, so the run
    // artifact records which fingerprint carrier anchored the depth.
    write(PLAN_ARTIFACT_OUT, JSON.stringify({...plan, stampSource}, null, 2));

    // 9. The scoped swap (review.md Step 3's depth semantics). When the plan
    // stages new-hunks, the whole-change surfaces shrink to the unseen hunks;
    // at flip-gated depth pattern-triage never runs, so the review diff and
    // file list are staged directly from scoped.diff.
    const scopedPath = SCOPED_DIFF_PATH;
    if (plan.staging === "new-hunks" && !fs.existsSync(scopedPath)) {
        // Unreachable today (a new-hunks plan implies a usable anchor, so
        // the plan CLI wrote scoped.diff), but if that invariant ever
        // breaks, the run silently reviewing the WHOLE diff at a reduced
        // depth deserves a visible warning, not a shrug.
        warnings.push(
            `re-review plan staged new-hunks but ${scopedPath} is missing: whole-change surfaces left unscoped`,
        );
    }
    if (plan.staging === "new-hunks" && fs.existsSync(scopedPath)) {
        const scoped = fs.readFileSync(scopedPath, "utf8");
        write(STRIPPED_DIFF_OUT, scoped);
        write(ANNOTATED_DIFF_OUT, annotateDiffLineNumbers(scoped));
        if (plan.depth === "flip-gated") {
            const scopedPaths = new Set(
                splitUnifiedDiff(scoped).map((section) => section.path),
            );
            write(PR_DIFF_OUT, scoped);
            write(PR_ANNOTATED_OUT, annotateDiffLineNumbers(scoped));
            write(
                REVIEW_FILES_OUT,
                JSON.stringify(
                    files
                        .filter((file) => scopedPaths.has(file.filename))
                        .map((file) => ({
                            path: file.filename,
                            status: file.status,
                            hasPatch: true,
                        })),
                    null,
                    2,
                ),
            );
        }
    }

    return {
        staged,
        warnings,
        depth: plan.depth,
        changedFileCount: files.length,
        botThreadCount: botThreads.length,
        humanThreadCount: humanLines.size,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                  */
/* -------------------------------------------------------------------------- */

// Run only when executed directly (review.md pre-agent-steps), never on
// import (tests). A staging failure fails the step BEFORE any AI spend; the
// agent job never starts a review it has no inputs for.
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs") as StagePrFs;
    const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
    const authHeaders = {
        accept: "application/vnd.github+json",
        ...(token !== "" ? {authorization: `Bearer ${token}`} : {}),
    };
    /**
     * One authenticated request with the shared retry policy (network failure,
     * 5xx, and rate limiting retried; any other 4xx fails the staging at
     * once). Shared by the REST reads and the GraphQL POST so both inherit the
     * same behavior on a throttled runner.
     */
    const request = async (
        path: string,
        init?: {method: string; body: string; contentType: string},
    ): Promise<unknown> => {
        const ATTEMPTS = 3;
        let lastError: unknown;
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            let response: Awaited<ReturnType<typeof fetch>> | null = null;
            try {
                response = await fetch(`${apiUrl}${path}`, {
                    headers: {
                        ...authHeaders,
                        ...(init === undefined
                            ? {}
                            : {"content-type": init.contentType}),
                    },
                    ...(init === undefined
                        ? {}
                        : {method: init.method, body: init.body}),
                });
            } catch (error) {
                // Network-level failure: retryable.
                lastError = error;
            }
            if (response !== null) {
                if (response.ok) {
                    return await response.json();
                }
                const error = new Error(
                    `${init?.method ?? "GET"} ${path} -> ${response.status} ${
                        response.statusText
                    }`,
                );
                // GitHub's secondary rate limit surfaces as a 403 with a
                // Retry-After header, not 429; that one 4xx heals on retry.
                const retryAfterSeconds = Number(
                    response.headers.get("retry-after") ?? "",
                );
                const rateLimited =
                    response.status === 429 ||
                    (response.status === 403 && retryAfterSeconds > 0);
                if (response.status < 500 && !rateLimited) {
                    // Any other 4xx (bad token, missing PR) will not heal on
                    // retry; fail the staging immediately.
                    throw error;
                }
                lastError = error;
                if (rateLimited && retryAfterSeconds > 0) {
                    await sleep(Math.min(retryAfterSeconds, 60) * 1000);
                }
            }
            if (attempt < ATTEMPTS - 1) {
                await sleep(1000 * (attempt + 1));
            }
        }
        throw lastError;
    };
    const ghGet: GhGet = (path) => request(path);
    // The HTTP-200 `RATE_LIMITED` retry, and the transport-level
    // `assertNoGraphqlErrors` that detects it, both live in `threads.ts` so
    // autofix's port inherits them; the reader keeps its own copy of the guard.
    const ghGraphql: GhGraphql = withGraphqlRateLimitRetry(
        (query, variables) =>
            request("/graphql", {
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({query, variables}),
            }),
        sleep,
    );

    const repo = process.env.GITHUB_REPOSITORY ?? "";
    const prNumber = Number(process.env.REVIEW_PR_NUMBER ?? "");
    const repoRoot =
        process.env.REVIEW_REPO_ROOT ?? process.env.GITHUB_WORKSPACE ?? ".";
    if (repo === "" || !Number.isInteger(prNumber) || prNumber <= 0) {
        // eslint-disable-next-line no-console
        console.error(
            "::error title=review staging::GITHUB_REPOSITORY and REVIEW_PR_NUMBER are required",
        );
        process.exit(2);
    }
    // The linked-ticket GET (stage-ticket.ts). Plain fetch, no retry, and a
    // hard 10s bound per candidate, fetched in parallel (a blackholed Jira
    // host must not stall staging until the job timeout): a ticket is
    // context, not a prerequisite, and stage-ticket degrades every failure
    // rather than failing the staging.
    const ticketFetch = async (
        url: string,
        headers: Record<string, string>,
    ): Promise<{status: number; json: unknown}> => {
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10_000),
        });
        return {
            status: response.status,
            json: await response.json().catch(() => null),
        };
    };
    void runStagePrCli(nodeFs, ghGet, ghGraphql, ticketFetch, {
        repo,
        prNumber,
        repoRoot,
        env: process.env,
    })
        .then((result) => {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(result, null, 2));
            for (const warning of result.warnings) {
                // eslint-disable-next-line no-console
                console.log(`::warning title=review staging::${warning}`);
            }
        })
        .catch((error: unknown) => {
            // eslint-disable-next-line no-console
            console.error(
                `::error title=review staging::staging failed before the agent started: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            process.exit(1);
        });
}
