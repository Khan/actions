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

import {computeDiffProvenance} from "../lib/provenance";
import {route, type RouterConfig} from "../lib/router";
import type {CorpusCase} from "./corpus/loader";

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
 * Stage one live-enabled corpus case under `destDir`. Throws when the case is
 * not live-enabled (no `live` block / no diff) or its tree is missing: the
 * caller selects cases via `loadLiveCorpus()`, so a miss here is a bug, not
 * an input to tolerate.
 */
export const stageCase = (
    corpusCase: CorpusCase,
    destDir: string,
    fs: StageFs = DEFAULT_FS,
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
    // review diff does too.
    fs.writeFileSync(`${contextDir}/full.diff`, diff);
    fs.writeFileSync(`${contextDir}/full-stripped.diff`, diff);
    fs.writeFileSync(`${contextDir}/pr.diff`, diff);

    // files.json + review-files.json: path/status/hasPatch. `hasPatch` is
    // whether the diff carries a section for the path (the completeness
    // cross-check the provenance gate reads).
    const provenance = computeDiffProvenance(diff);
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

    return {caseId: corpusCase.id, rootDir: destDir, contextDir, checkoutDir};
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
