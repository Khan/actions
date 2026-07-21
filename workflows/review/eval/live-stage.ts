/**
 * Case staging for the live eval arm (`live-ab-plan.md` Phase 2b).
 *
 * Production sub-agents have no GitHub access: `review.md` Step 1 stages the
 * PR on disk under `/tmp/gh-aw/review/` and every sub-agent prompt names
 * those paths. This module materializes the SAME layout for a live-enabled
 * corpus case, so the extracted prompts run against a case exactly as they
 * run against a real PR:
 *
 *   <dest>/context/pr-context.json    PR metadata (from the case's live block)
 *   <dest>/context/full.diff          the case diff (git-style unified diff)
 *   <dest>/context/full-stripped.diff = full.diff (corpus diffs carry no
 *                                       generated files to strip)
 *   <dest>/context/pr.diff            = full.diff (no pattern-triage pass:
 *                                       every changed file is a review file)
 *   <dest>/context/full-stripped-annotated.diff, pr-annotated.diff
 *                                     line-number-annotated copies (read by
 *                                     review.md versions that name them)
 *   <dest>/context/files.json         path/status/hasPatch per changed file
 *   <dest>/context/review-files.json  = files.json entries (see pr.diff)
 *   <dest>/context/provenance.json    the diff's changed-line map
 *   <dest>/context/routing.json       deterministic router output
 *   <dest>/context/out/               sub-agent output directory
 *   <dest>/checkout/                  the case's post-change file tree
 *
 * Prompts are then rewritten with {@link rewriteAgentPrompt}, which swaps the
 * production staging root for the case's context directory.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";

import {annotateDiffLineNumbers, splitUnifiedDiff} from "../lib/diff";
import {computeDiffProvenance} from "../lib/provenance";
import {
    buildScopedDiff,
    computeHunkSignature,
    decideReReviewDepth,
    renderRereviewStamp,
    STAMP_SCHEMA_VERSION,
    type ReReviewPlan,
} from "../lib/rereview-mode";
import {route, type RouterConfig} from "../lib/router";
import type {ReReviewMode} from "../lib/routing-config";
import type {CaseRereview, CorpusCase} from "./corpus/loader";

/** The staging root production prompts reference (review.md Step 1). */
export const PRODUCTION_REVIEW_DIR = "/tmp/gh-aw/review";

/** Filesystem seam so staging is testable against memfs. */
export type StageFs = {
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: true}) => void;
    readdirSync: (
        p: string,
        opts: {withFileTypes: true},
    ) => {name: string; isDirectory: () => boolean; isFile: () => boolean}[];
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
};

const DEFAULT_FS: StageFs = {
    existsSync,
    mkdirSync: (p, opts) => {
        mkdirSync(p, opts);
    },
    readdirSync: (p, opts) =>
        readdirSync(p, opts) as unknown as ReturnType<StageFs["readdirSync"]>,
    readFileSync: (p, enc) => readFileSync(p, enc),
    writeFileSync: (p, data) => {
        writeFileSync(p, data);
    },
};

/** A staged case: the directories a sub-agent dispatch needs. */
export type StagedCase = {
    caseId: string;
    /** The staging root (`destDir` as given). */
    rootDir: string;
    /** The context directory prompts are rewritten to point at. */
    contextDir: string;
    /** The post-change checkout the sub-agent runs in (its cwd). */
    checkoutDir: string;
    /**
     * The re-review depth plan, present iff the case carries a
     * `live.rereview` block: the same {@link ReReviewPlan} production's
     * rereview-mode CLI computes, staged as `rereview-plan.json`. The
     * producer reads `dispatch` off it to size the roster.
     */
    rereviewPlan?: ReReviewPlan;
};

/** Options for {@link stageCase}. */
export type StageOptions = {
    /**
     * The repo's re-review mode for this run (the ROUTING `re-review` line in
     * production; an arm parameter here, so the A/B can price a mode).
     * Ignored for cases with no `rereview` block. Default `full`.
     */
    reReviewMode?: ReReviewMode;
};

/** Recursively copy a directory through the fs seam. */
const copyDir = (src: string, dest: string, fs: StageFs): void => {
    fs.mkdirSync(dest, {recursive: true});
    for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
        const from = `${src}/${entry.name}`;
        const to = `${dest}/${entry.name}`;
        if (entry.isDirectory()) {
            copyDir(from, to, fs);
        } else if (entry.isFile()) {
            fs.writeFileSync(to, fs.readFileSync(from, "utf8"));
        }
    }
};

/**
 * Stage the open-PR re-review state for a case carrying a `live.rereview`
 * block, mirroring production exactly:
 *
 *   threads.json          the unresolved bot threads (synthetic `t-<key>`
 *                         ids), each with its opening comment and any author
 *                         reply — the reconciler's whole input;
 *   human-threads.json    empty (corpus threads are all bot threads);
 *   prior-reviews.json    one prior review whose body carries the hidden
 *                         fingerprint stamp derived from `priorDiff`, so the
 *                         depth decision runs on the same stamp mechanics as
 *                         production;
 *   rereview-plan.json    the {@link ReReviewPlan} for this push under
 *                         `mode`; and when it stages `new-hunks`, the scoped
 *                         diff overwrites `full-stripped.diff` and `pr.diff`
 *                         (what review.md's scoped/flip-gated depths do), so
 *                         the dispatched reviewers read only unseen hunks.
 */
const stageRereview = (
    rereview: CaseRereview,
    currentDiff: string,
    contextDir: string,
    mode: ReReviewMode,
    fs: StageFs,
): ReReviewPlan => {
    const threads = rereview.priorThreads.map((thread) => ({
        thread_id: `t-${thread.key}`,
        path: thread.path,
        line: thread.line,
        comments: [
            {author: "github-actions[bot]", body: thread.body},
            ...(thread.authorReply !== undefined
                ? [{author: "case-author", body: thread.authorReply}]
                : []),
        ],
    }));
    fs.writeFileSync(
        `${contextDir}/threads.json`,
        JSON.stringify(threads, null, 2),
    );
    fs.writeFileSync(`${contextDir}/human-threads.json`, "[]");

    const anchorHunks = computeHunkSignature(rereview.priorDiff);
    const priorStamp = {
        schemaVersion: STAMP_SCHEMA_VERSION,
        depth: rereview.priorDepth,
        verdict: rereview.priorVerdict,
        anchorDraft: false,
        anchorHunks,
    };
    fs.writeFileSync(
        `${contextDir}/prior-reviews.json`,
        JSON.stringify(
            [
                {
                    body: renderRereviewStamp(priorStamp),
                    submittedAt: "2026-01-01T00:00:00Z",
                },
            ],
            null,
            2,
        ),
    );

    const plan = decideReReviewDepth({
        mode,
        isDraft: false,
        priorStamp,
        currentSignature: computeHunkSignature(currentDiff),
    });
    fs.writeFileSync(
        `${contextDir}/rereview-plan.json`,
        JSON.stringify(plan, null, 2),
    );

    if (plan.staging === "new-hunks") {
        const scoped = buildScopedDiff(currentDiff, anchorHunks);
        const scopedAnnotated = annotateDiffLineNumbers(scoped);
        fs.writeFileSync(`${contextDir}/scoped.diff`, scoped);
        fs.writeFileSync(`${contextDir}/full-stripped.diff`, scoped);
        fs.writeFileSync(`${contextDir}/pr.diff`, scoped);
        fs.writeFileSync(
            `${contextDir}/full-stripped-annotated.diff`,
            scopedAnnotated,
        );
        fs.writeFileSync(`${contextDir}/pr-annotated.diff`, scopedAnnotated);
        // Production parity (stage-pr.ts): with the review diff shrunk to
        // the unseen hunks, the reviewed-file roster shrinks with it, so the
        // dispatched reviewers see the same file list in both harnesses.
        const scopedPaths = new Set(
            splitUnifiedDiff(scoped).map((section) => section.path),
        );
        const files = JSON.parse(
            fs.readFileSync(`${contextDir}/review-files.json`, "utf8"),
        ) as {path?: unknown}[];
        fs.writeFileSync(
            `${contextDir}/review-files.json`,
            JSON.stringify(
                files.filter(
                    (entry) =>
                        typeof entry.path === "string" &&
                        scopedPaths.has(entry.path),
                ),
                null,
                2,
            ),
        );
    }
    return plan;
};

/**
 * Stage one live-enabled corpus case under `destDir`. Throws when the case is
 * not live-enabled (no `live` block / no diff) or its tree is missing: the
 * caller selects cases via `loadLiveCorpus()`, so a miss here is a bug, not
 * an input to tolerate.
 */
export const stageCase = (
    corpusCase: CorpusCase,
    destDir: string,
    fs: StageFs = DEFAULT_FS,
    options: StageOptions = {},
): StagedCase => {
    const live = corpusCase.live;
    const diff = corpusCase.diff;
    if (live === undefined || diff === undefined) {
        throw new Error(
            `stageCase: case "${corpusCase.id}" is not live-enabled`,
        );
    }

    const contextDir = `${destDir}/context`;
    const checkoutDir = `${destDir}/checkout`;
    fs.mkdirSync(`${contextDir}/out`, {recursive: true});
    fs.mkdirSync(checkoutDir, {recursive: true});

    // The diff surfaces. Corpus diffs carry no generated files, so the
    // stripped diff equals the full one; with no pattern-triage pass, the
    // review diff does too. The annotated siblings are staged for BOTH arms
    // unconditionally: only a review.md version that names them reads them,
    // so an A/B between a pre-annotation baseline and an annotated candidate
    // is a pure prompt delta with no staging flag.
    const annotated = annotateDiffLineNumbers(diff);
    fs.writeFileSync(`${contextDir}/full.diff`, diff);
    fs.writeFileSync(`${contextDir}/full-stripped.diff`, diff);
    fs.writeFileSync(`${contextDir}/pr.diff`, diff);
    fs.writeFileSync(`${contextDir}/full-stripped-annotated.diff`, annotated);
    fs.writeFileSync(`${contextDir}/pr-annotated.diff`, annotated);

    // files.json + review-files.json: path/status/hasPatch. `hasPatch` is
    // whether the diff carries a section for the path (the completeness
    // cross-check the provenance gate reads).
    const provenance = computeDiffProvenance(diff, corpusCase.fileLineCounts);
    const files = corpusCase.changedFiles.map((file) => ({
        path: file.path,
        status: file.status,
        hasPatch: provenance.files[file.path] !== undefined,
    }));
    const filesJson = JSON.stringify(files, null, 2);
    fs.writeFileSync(`${contextDir}/files.json`, filesJson);
    fs.writeFileSync(`${contextDir}/review-files.json`, filesJson);
    fs.writeFileSync(
        `${contextDir}/provenance.json`,
        JSON.stringify(provenance, null, 2),
    );

    // Deterministic routing, exactly as the no-post runner computes it.
    const routerConfig: RouterConfig = {
        generatedPatterns: [],
        ...(corpusCase.routerConfig as Partial<RouterConfig>),
    };
    const routing = route({files: corpusCase.changedFiles}, routerConfig);
    fs.writeFileSync(
        `${contextDir}/routing.json`,
        JSON.stringify(routing, null, 2),
    );

    // PR context (review.md Step 1's shape). Synthetic identity fields are
    // fixed values: nothing downstream may key on them.
    fs.writeFileSync(
        `${contextDir}/pr-context.json`,
        JSON.stringify(
            {
                number: 0,
                title: live.prContext.title,
                description: live.prContext.description,
                author: live.prContext.author,
                baseBranch: live.prContext.baseBranch,
                headSha: "0000000000000000000000000000000000000000",
                isDraft: false,
                repo: "eval/corpus",
                diffPath: `${contextDir}/full.diff`,
                filesPath: `${contextDir}/files.json`,
            },
            null,
            2,
        ),
    );

    // The post-change checkout the sub-agents read and investigate.
    const lastSlash = corpusCase.sourcePath.lastIndexOf("/");
    const caseDir =
        lastSlash === -1 ? "." : corpusCase.sourcePath.slice(0, lastSlash);
    const treeDir = `${caseDir}/${live.tree}`;
    if (!fs.existsSync(treeDir)) {
        throw new Error(
            `stageCase: case "${corpusCase.id}" tree "${treeDir}" does not exist`,
        );
    }
    copyDir(treeDir, checkoutDir, fs);

    // Re-review (open-PR) cases: stage the prior review state and the depth
    // plan LAST, so the scoped overwrite wins over the plain staging above.
    let rereviewPlan: ReReviewPlan | undefined;
    if (live.rereview !== undefined) {
        rereviewPlan = stageRereview(
            live.rereview,
            diff,
            contextDir,
            options.reReviewMode ?? "full",
            fs,
        );
    }

    return {
        caseId: corpusCase.id,
        rootDir: destDir,
        contextDir,
        checkoutDir,
        ...(rereviewPlan !== undefined ? {rereviewPlan} : {}),
    };
};

/**
 * Rewrite an extracted agent prompt to read the staged case instead of the
 * production staging root. Every occurrence of {@link PRODUCTION_REVIEW_DIR}
 * is replaced, so any staged filename a prompt names (pr.diff, files.json,
 * full-stripped.diff, out/...) resolves inside the case's context directory.
 */
export const rewriteAgentPrompt = (
    prompt: string,
    staged: StagedCase,
): string => prompt.split(PRODUCTION_REVIEW_DIR).join(staged.contextDir);
