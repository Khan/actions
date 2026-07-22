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
 * What it stages under /tmp/gh-aw/review/ (the Step 1 contract, unchanged):
 *
 *   pr-context.json     PR metadata (untrusted author text included verbatim)
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
 *   prior-reviews.json  every github-actions[bot] review body, all states
 *                       (fetch failure degrades to [], which forces a full
 *                       review downstream, never a cheaper one)
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
 * from pattern-triage's reviewFiles, which is model output), threads.json /
 * human-threads.json (Phase 2; a later slice), and the disciplines extraction
 * (slice 3's ledger). The router's second pass stays mid-run by design.
 *
 * Parity: the eval's live producer stages cases through the same lib
 * functions this module calls (eval/live-stage.ts: route, computeDiffProvenance,
 * decideReReviewDepth, buildScopedDiff, annotateDiffLineNumbers), so the A/B
 * keeps measuring the production pipeline.
 *
 * Failure stance: the PR metadata and file fetches are hard prerequisites
 * (no staging, no review; the step fails before any AI spend). Everything
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
import {runRereviewPlanCli} from "./rereview-mode";
import {runCli as runRouterCli} from "./router";

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
const FILES_OUT = `${REVIEW_DIR}/files.json`;
const FULL_DIFF_OUT = `${REVIEW_DIR}/full.diff`;
const DIFF_FACTS_OUT = `${REVIEW_DIR}/diff-facts.json`;
const NEW_SCOPE_OUT = `${REVIEW_DIR}/new-scope.json`;
const PRIOR_REVIEWS_OUT = `${REVIEW_DIR}/prior-reviews.json`;
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
};

export type StagePrResult = {
    /** Absolute paths written, in order. */
    staged: string[];
    /** Non-fatal degradations, fixed-format. */
    warnings: string[];
    /** The re-review depth the plan staged (informational). */
    depth: string;
    changedFileCount: number;
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
    options: StagePrOptions,
): Promise<StagePrResult> => {
    const {repo, prNumber, repoRoot} = options;
    const env = options.env ?? {};
    const cacheDir = options.cacheMemoryDir ?? CACHE_MEMORY_DIR;
    const staged: string[] = [];
    const warnings: string[] = [];
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
        head?: {sha?: string};
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

    // 4. new-scope.json against cache memory's reviewedHunks.
    let reviewedHunks: unknown;
    const cachePath = `${cacheDir}/pr-${prNumber}.json`;
    if (fs.existsSync(cachePath)) {
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

    // 5. Prior bot reviews (fetch failure degrades to []: full review).
    let priorReviews: {body: string; submittedAt?: string}[] = [];
    try {
        type RawReview = {
            user?: {login?: string};
            body?: string | null;
            submitted_at?: string;
        };
        const reviews: RawReview[] = [];
        for (let page = 1; ; page++) {
            const batch = (await ghGet(
                `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
            )) as RawReview[];
            if (!Array.isArray(batch)) {
                throw new Error("GET /pulls/{n}/reviews returned a non-array");
            }
            reviews.push(...batch);
            if (batch.length < 100) {
                break;
            }
        }
        priorReviews = reviews
            .filter((review) => review.user?.login === "github-actions[bot]")
            .map((review) => ({
                body: review.body ?? "",
                ...(typeof review.submitted_at === "string"
                    ? {submittedAt: review.submitted_at}
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
    const ghGet: GhGet = async (path) => {
        const ATTEMPTS = 3;
        let lastError: unknown;
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            let response: Awaited<ReturnType<typeof fetch>> | null = null;
            try {
                response = await fetch(`${apiUrl}${path}`, {
                    headers: {
                        accept: "application/vnd.github+json",
                        ...(token !== ""
                            ? {authorization: `Bearer ${token}`}
                            : {}),
                    },
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
                    `GET ${path} -> ${response.status} ${response.statusText}`,
                );
                if (response.status < 500 && response.status !== 429) {
                    // A 4xx (bad token, missing PR) will not heal on retry;
                    // fail the staging immediately.
                    throw error;
                }
                lastError = error;
            }
            if (attempt < ATTEMPTS - 1) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 1000 * (attempt + 1)),
                );
            }
        }
        throw lastError;
    };

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
    void runStagePrCli(nodeFs, ghGet, {
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
