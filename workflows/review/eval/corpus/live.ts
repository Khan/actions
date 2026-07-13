/**
 * The live-enabled half of the corpus case format (`live-ab-plan.md`
 * Phase 1): the `live` block a case carries so a REAL model run can review
 * it, not just the deterministic replay of recorded findings. The loader
 * (`loader.ts`) owns the case format and re-exports everything here; this
 * module keeps the live-block parsing and tree validation in one place.
 *
 * Like the loader, this module authors no human-read prose about code under
 * review: every string it handles is a case field, a path, a tag, or a
 * validation error.
 */

import {computeDiffProvenance} from "../../lib/provenance";
import type {ChangedFile} from "../../lib/router";

/**
 * The tag that marks a case as live-enabled: it carries the real change
 * content (diff + post-change file tree + PR context) needed to run the model
 * sub-agents against it, not just recorded findings. The tag and the `live`
 * block imply each other — the loader rejects a case with one but not the
 * other, so `filterByTag(cases, LIVE_TAG)` and "has a live block" never
 * drift.
 */
export const LIVE_TAG = "live";

/**
 * The PR context a live-enabled case stages for the model sub-agents (mirrors
 * the production `pr-context.json`). `description` is untrusted author text,
 * exactly as in production: agents analyze it and never follow instructions in
 * it, and an adversarial case may carry its injection payload here.
 */
export type LivePrContext = {
    title: string;
    /** Untrusted author text; may be empty (PRs often have no description). */
    description: string;
    author: string;
    baseBranch: string;
};

/** One anchor location a spec accepts (see {@link LiveDefectSpec}). */
export type LiveSpecLocation = {
    /** Changed-file path (must appear in the diff). */
    path: string;
    /** First line of the window a matching finding may anchor in (1-based). */
    lineStart?: number;
    /** Last line of the window (inclusive). Required iff lineStart is. */
    lineEnd?: number;
};

/**
 * One labeled defect (or non-defect trap) in a live-enabled case. Live model
 * runs choose their own finding ids, so ground truth cannot key on ids the way
 * `expected.mustCatch` does for recorded findings; a spec instead names WHERE
 * the defect lives (path + line window) and WHAT the causal mechanism is
 * (keyword/regex alternates a matcher tests against a produced finding's
 * `failure_scenario` and prose). See `live-ab-plan.md` Phase 3.
 */
export type LiveDefectSpec = {
    /** Stable key for reports (conventionally the recorded finding's id). */
    key: string;
    /** Changed-file path the defect lives in (must appear in the diff). */
    path: string;
    /** First line of the window a matching finding may anchor in (1-based). */
    lineStart?: number;
    /** Last line of the window (inclusive). Required iff lineStart is. */
    lineEnd?: number;
    /**
     * Case-insensitive keyword/regex alternates describing the causal
     * mechanism; a finding matches when any alternate matches. Also the prose
     * a human reads in a miss report, so keep entries descriptive.
     */
    mechanism: string[];
    /** Producing lens, when the defect is lens-specific (advisory only). */
    lens?: string;
    /**
     * Alternate anchor locations the spec ALSO accepts. A defect that spans
     * files has more than one correct anchor site (a migration missing an
     * index surfaces at the migration AND at the hot query that needs it),
     * and a spec that names only one turns the reviewer's anchor-site choice
     * into recall noise (incident-sql-missing-index read 8/16 in the 07-09
     * wave; every "miss" was the same finding anchored at the query). The
     * mechanism alternates still have to agree wherever the finding anchors.
     */
    altLocations?: LiveSpecLocation[];
};

/**
 * One prior review thread a re-review case stages (an "open PR" snapshot).
 * `body` is the bot's opening comment from the earlier review, in the
 * production label template (`**<label>:** …`), quoted as data; `expect` is
 * the reconciliation ground truth for THIS push's diff.
 */
export type RereviewPriorThread = {
    /** Stable key for staging (`t-<key>` thread id) and scoring. */
    key: string;
    /** Path the thread anchors on. */
    path: string;
    /** RIGHT-side line, or null for a file-level thread. */
    line: number | null;
    /** The opening bot comment, label template included. */
    body: string;
    /** The author's reply on the thread, when they left one. */
    authorReply?: string;
    /** Ground truth: this push fixed the thread (`resolve`) or not (`keep`). */
    expect: "resolve" | "keep";
    /**
     * Case-insensitive keyword/regex alternates for the thread's mechanism,
     * used to score duplicate suppression: a fresh finding matching a KEPT
     * thread's path/window and mechanism is a duplicate comment. Optional;
     * without it dup detection falls back to path + line proximity.
     */
    mechanism?: string[];
};

/**
 * The re-review block: what makes a live case an OPEN-PR snapshot (a push
 * onto an already-reviewed PR) rather than a first review. `priorDiff` is the
 * diff the last full-depth review reviewed — the anchor fingerprint and the
 * body stamp are derived from it, exactly as production derives them — and
 * `priorThreads` are the unresolved bot threads that review left, with
 * per-thread reconciliation ground truth. The case's own top-level `diff` and
 * `tree` are the state AFTER this push.
 */
export type CaseRereview = {
    /** The previously fully-reviewed unified diff (anchor fingerprint). */
    priorDiff: string;
    /** The prior review's submitted event (rides into the staged stamp). */
    priorVerdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    /** The depth the prior review executed (staged stamp; default `full`). */
    priorDepth: "full" | "scoped" | "flip-gated" | "fast";
    /** Unresolved bot threads at this push, with reconciliation ground truth. */
    priorThreads: RereviewPriorThread[];
};

/**
 * The live block of a live-enabled case: everything a real model run needs
 * that the recorded replay does not. Requires the case to carry a `diff` and
 * the {@link LIVE_TAG} tag; the post-change file tree lives on disk next to
 * the case file (the `<id>/case.json` + `<id>/tree/` layout).
 */
export type CaseLive = {
    prContext: LivePrContext;
    /**
     * Case-dir-relative path to the post-change tree (default `tree`).
     *
     * Trees are deliberately minimal: validation requires only the changed
     * files to exist. The staged copy of this tree is the sub-agent's whole
     * world (its cwd, with no network), so the agent WILL often try to read
     * an imported module or caller that is not there; that read returns an
     * ordinary not-found tool error the agent tolerates and works around,
     * not a run failure. The cost of a missing file is realism, not a crash:
     * include the context files whose absence would change what a reviewer
     * concludes (e.g. the decorator module a sibling handler imports), and
     * nothing more.
     */
    tree: string;
    /** Labeled defects a live run must catch. */
    mustCatchSpecs?: LiveDefectSpec[];
    /** Labeled traps a live run must NOT flag (clean-case ground truth). */
    mustNotFlagSpecs?: LiveDefectSpec[];
    /** Present iff the case is a re-review (open-PR) snapshot. */
    rereview?: CaseRereview;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

const parseDefectSpecs = (
    raw: unknown,
    key: "mustCatchSpecs" | "mustNotFlagSpecs",
    changedPaths: Set<string>,
    diffPaths: Set<string> | undefined,
    seenKeys: Set<string>,
    errors: string[],
): LiveDefectSpec[] | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        errors.push(`live.${key}: must be an array when present`);
        return undefined;
    }
    const specs: LiveDefectSpec[] = [];
    raw.forEach((entry, i) => {
        const at = `live.${key}[${i}]`;
        if (!isRecord(entry)) {
            errors.push(`${at}: must be an object`);
            return;
        }
        const specKey = entry["key"];
        if (!isNonEmptyString(specKey)) {
            errors.push(`${at}.key: required non-empty string`);
            return;
        }
        if (seenKeys.has(specKey)) {
            errors.push(`${at}.key: duplicate spec key "${specKey}"`);
            return;
        }
        seenKeys.add(specKey);
        const path = entry["path"];
        if (!isNonEmptyString(path)) {
            errors.push(`${at}.path: required non-empty string`);
            return;
        }
        if (!changedPaths.has(path)) {
            errors.push(`${at}.path: "${path}" is not in changedFiles`);
        }
        if (diffPaths !== undefined && !diffPaths.has(path)) {
            errors.push(`${at}.path: "${path}" has no section in the diff`);
        }
        const mechanism = entry["mechanism"];
        if (
            !Array.isArray(mechanism) ||
            mechanism.length === 0 ||
            !mechanism.every(isNonEmptyString)
        ) {
            errors.push(
                `${at}.mechanism: must be a non-empty array of non-empty strings`,
            );
            return;
        }
        const lineStart = entry["lineStart"];
        const lineEnd = entry["lineEnd"];
        if ((lineStart === undefined) !== (lineEnd === undefined)) {
            errors.push(`${at}: lineStart and lineEnd must be set together`);
            return;
        }
        if (lineStart !== undefined) {
            if (
                !Number.isInteger(lineStart) ||
                !Number.isInteger(lineEnd) ||
                (lineStart as number) < 1 ||
                (lineEnd as number) < (lineStart as number)
            ) {
                errors.push(
                    `${at}: lineStart/lineEnd must be positive integers with lineStart <= lineEnd`,
                );
                return;
            }
        }
        const lens = entry["lens"];
        if (lens !== undefined && !isNonEmptyString(lens)) {
            errors.push(`${at}.lens: must be a non-empty string when present`);
            return;
        }
        const rawAlt = entry["altLocations"];
        let altLocations: LiveSpecLocation[] | undefined;
        if (rawAlt !== undefined) {
            if (!Array.isArray(rawAlt) || rawAlt.length === 0) {
                errors.push(
                    `${at}.altLocations: must be a non-empty array when present`,
                );
                return;
            }
            altLocations = [];
            let altBroken = false;
            rawAlt.forEach((alt, j) => {
                const altAt = `${at}.altLocations[${j}]`;
                if (!isRecord(alt)) {
                    errors.push(`${altAt}: must be an object`);
                    altBroken = true;
                    return;
                }
                const altPath = alt["path"];
                if (!isNonEmptyString(altPath)) {
                    errors.push(`${altAt}.path: required non-empty string`);
                    altBroken = true;
                    return;
                }
                if (!changedPaths.has(altPath)) {
                    errors.push(
                        `${altAt}.path: "${altPath}" is not in changedFiles`,
                    );
                }
                if (diffPaths !== undefined && !diffPaths.has(altPath)) {
                    errors.push(
                        `${altAt}.path: "${altPath}" has no section in the diff`,
                    );
                }
                const altStart = alt["lineStart"];
                const altEnd = alt["lineEnd"];
                if ((altStart === undefined) !== (altEnd === undefined)) {
                    errors.push(
                        `${altAt}: lineStart and lineEnd must be set together`,
                    );
                    altBroken = true;
                    return;
                }
                if (altStart !== undefined) {
                    if (
                        !Number.isInteger(altStart) ||
                        !Number.isInteger(altEnd) ||
                        (altStart as number) < 1 ||
                        (altEnd as number) < (altStart as number)
                    ) {
                        errors.push(
                            `${altAt}: lineStart/lineEnd must be positive integers with lineStart <= lineEnd`,
                        );
                        altBroken = true;
                        return;
                    }
                }
                const location: LiveSpecLocation = {path: altPath};
                if (altStart !== undefined) {
                    location.lineStart = altStart as number;
                    location.lineEnd = altEnd as number;
                }
                altLocations?.push(location);
            });
            if (altBroken) {
                return;
            }
        }
        const spec: LiveDefectSpec = {
            key: specKey,
            path,
            mechanism: mechanism as string[],
        };
        if (lineStart !== undefined) {
            spec.lineStart = lineStart as number;
            spec.lineEnd = lineEnd as number;
        }
        if (isNonEmptyString(lens)) {
            spec.lens = lens;
        }
        if (altLocations !== undefined) {
            spec.altLocations = altLocations;
        }
        specs.push(spec);
    });
    return specs;
};

const RE_REVIEW_VERDICTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
const RE_REVIEW_DEPTHS = ["full", "scoped", "flip-gated", "fast"] as const;

/** Parse + validate the `rereview` block (see {@link CaseRereview}). */
const parseRereview = (
    raw: unknown,
    errors: string[],
): CaseRereview | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    if (!isRecord(raw)) {
        errors.push("live.rereview: must be an object when present");
        return undefined;
    }

    const priorDiff = raw["priorDiff"];
    if (!isNonEmptyString(priorDiff)) {
        errors.push("live.rereview.priorDiff: required non-empty string");
    } else {
        const provenance = computeDiffProvenance(priorDiff);
        if (provenance.warnings.length > 0) {
            errors.push(
                `live.rereview.priorDiff: must parse cleanly (${provenance.warnings.join(
                    "; ",
                )})`,
            );
        }
    }

    const priorVerdict = raw["priorVerdict"];
    if (
        !(RE_REVIEW_VERDICTS as readonly string[]).includes(
            priorVerdict as string,
        )
    ) {
        errors.push(
            `live.rereview.priorVerdict: must be one of ${RE_REVIEW_VERDICTS.join(
                ", ",
            )}`,
        );
    }

    const rawDepth = raw["priorDepth"] ?? "full";
    if (!(RE_REVIEW_DEPTHS as readonly string[]).includes(rawDepth as string)) {
        errors.push(
            `live.rereview.priorDepth: must be one of ${RE_REVIEW_DEPTHS.join(
                ", ",
            )}`,
        );
    }

    const rawThreads = raw["priorThreads"];
    const threads: RereviewPriorThread[] = [];
    if (!Array.isArray(rawThreads) || rawThreads.length === 0) {
        errors.push(
            "live.rereview.priorThreads: required non-empty array " +
                "(a re-review with no prior threads is a plain live case)",
        );
    } else {
        const seen = new Set<string>();
        rawThreads.forEach((entry, i) => {
            const at = `live.rereview.priorThreads[${i}]`;
            if (!isRecord(entry)) {
                errors.push(`${at}: must be an object`);
                return;
            }
            const key = entry["key"];
            if (!isNonEmptyString(key)) {
                errors.push(`${at}.key: required non-empty string`);
                return;
            }
            if (seen.has(key)) {
                errors.push(`${at}.key: duplicate thread key "${key}"`);
                return;
            }
            seen.add(key);
            const path = entry["path"];
            const body = entry["body"];
            const line = entry["line"];
            const expect = entry["expect"];
            if (!isNonEmptyString(path)) {
                errors.push(`${at}.path: required non-empty string`);
                return;
            }
            if (!isNonEmptyString(body)) {
                errors.push(`${at}.body: required non-empty string`);
                return;
            }
            if (line !== null && !Number.isInteger(line)) {
                errors.push(`${at}.line: must be an integer or null`);
                return;
            }
            if (expect !== "resolve" && expect !== "keep") {
                errors.push(`${at}.expect: must be "resolve" or "keep"`);
                return;
            }
            const authorReply = entry["authorReply"];
            if (authorReply !== undefined && !isNonEmptyString(authorReply)) {
                errors.push(
                    `${at}.authorReply: must be a non-empty string when present`,
                );
                return;
            }
            const mechanism = entry["mechanism"];
            if (
                mechanism !== undefined &&
                (!Array.isArray(mechanism) ||
                    mechanism.length === 0 ||
                    !mechanism.every(isNonEmptyString))
            ) {
                errors.push(
                    `${at}.mechanism: must be a non-empty array of non-empty strings when present`,
                );
                return;
            }
            const thread: RereviewPriorThread = {
                key,
                path,
                line: line as number | null,
                body,
                expect,
            };
            if (authorReply !== undefined) {
                thread.authorReply = authorReply as string;
            }
            if (mechanism !== undefined) {
                thread.mechanism = mechanism as string[];
            }
            threads.push(thread);
        });
    }

    if (
        !isNonEmptyString(priorDiff) ||
        !(RE_REVIEW_VERDICTS as readonly string[]).includes(
            priorVerdict as string,
        ) ||
        !(RE_REVIEW_DEPTHS as readonly string[]).includes(rawDepth as string) ||
        threads.length === 0
    ) {
        return undefined;
    }
    return {
        priorDiff,
        priorVerdict: priorVerdict as CaseRereview["priorVerdict"],
        priorDepth: rawDepth as CaseRereview["priorDepth"],
        priorThreads: threads,
    };
};

/**
 * Parse + validate the `live` block. `diff` is the case's already-validated
 * diff text (undefined when absent/invalid): a live case requires one, and it
 * must parse cleanly — the provenance gate's fail-open path is acceptable for
 * a production run but a live eval case with an unparseable diff is authoring
 * error, not something to tolerate.
 */
export const parseLive = (
    raw: unknown,
    changedFiles: ChangedFile[],
    diff: string | undefined,
    errors: string[],
): CaseLive | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    if (!isRecord(raw)) {
        errors.push("live: must be an object when present");
        return undefined;
    }

    let diffPaths: Set<string> | undefined;
    if (diff === undefined) {
        errors.push("live: requires a non-empty top-level diff");
    } else {
        const provenance = computeDiffProvenance(diff);
        if (provenance.warnings.length > 0) {
            errors.push(
                `live: diff must parse cleanly (${provenance.warnings.join(
                    "; ",
                )})`,
            );
        } else {
            diffPaths = new Set(Object.keys(provenance.files));
        }
    }

    const rawPr = raw["prContext"];
    let prContext: LivePrContext | undefined;
    if (!isRecord(rawPr)) {
        errors.push("live.prContext: required object");
    } else {
        for (const field of ["title", "author", "baseBranch"] as const) {
            if (!isNonEmptyString(rawPr[field])) {
                errors.push(
                    `live.prContext.${field}: required non-empty string`,
                );
            }
        }
        if (typeof rawPr["description"] !== "string") {
            errors.push(
                "live.prContext.description: required string (may be empty)",
            );
        }
        if (
            isNonEmptyString(rawPr["title"]) &&
            isNonEmptyString(rawPr["author"]) &&
            isNonEmptyString(rawPr["baseBranch"]) &&
            typeof rawPr["description"] === "string"
        ) {
            prContext = {
                title: rawPr["title"],
                description: rawPr["description"],
                author: rawPr["author"],
                baseBranch: rawPr["baseBranch"],
            };
        }
    }

    const rawTree = raw["tree"];
    let tree = "tree";
    if (rawTree !== undefined) {
        if (!isNonEmptyString(rawTree)) {
            errors.push("live.tree: must be a non-empty string when present");
        } else if (
            rawTree.startsWith("/") ||
            rawTree
                .split("/")
                .some((segment) => segment === ".." || segment === "")
        ) {
            errors.push(
                "live.tree: must be a case-dir-relative path with no .. segments",
            );
        } else {
            tree = rawTree;
        }
    }

    const changedPaths = new Set(changedFiles.map((f) => f.path));
    const seenKeys = new Set<string>();
    const mustCatchSpecs = parseDefectSpecs(
        raw["mustCatchSpecs"],
        "mustCatchSpecs",
        changedPaths,
        diffPaths,
        seenKeys,
        errors,
    );
    const mustNotFlagSpecs = parseDefectSpecs(
        raw["mustNotFlagSpecs"],
        "mustNotFlagSpecs",
        changedPaths,
        diffPaths,
        seenKeys,
        errors,
    );

    const rereview = parseRereview(raw["rereview"], errors);

    if (prContext === undefined) {
        return undefined;
    }
    const live: CaseLive = {prContext, tree};
    if (mustCatchSpecs !== undefined) {
        live.mustCatchSpecs = mustCatchSpecs;
    }
    if (mustNotFlagSpecs !== undefined) {
        live.mustNotFlagSpecs = mustNotFlagSpecs;
    }
    if (rereview !== undefined) {
        live.rereview = rereview;
    }
    return live;
};

/**
 * Errors for a live case's on-disk tree: the tree directory must exist next
 * to the case file, and every non-removed changed file must be present in it
 * (the post-change snapshot the sub-agents read). Returns fixed-format error
 * strings; the loader wraps them in its case error type.
 */
export const liveTreeErrors = (
    live: CaseLive,
    changedFiles: ChangedFile[],
    sourcePath: string,
    existsSync: (p: string) => boolean,
): string[] => {
    const lastSlash = sourcePath.lastIndexOf("/");
    const caseDir = lastSlash === -1 ? "." : sourcePath.slice(0, lastSlash);
    const treeDir = `${caseDir}/${live.tree}`;
    const errors: string[] = [];
    if (!existsSync(treeDir)) {
        errors.push(`live.tree: directory "${treeDir}" does not exist`);
        return errors;
    }
    for (const file of changedFiles) {
        if (file.status === "removed") {
            continue;
        }
        if (!existsSync(`${treeDir}/${file.path}`)) {
            errors.push(
                `live.tree: missing changed file "${file.path}" under "${treeDir}"`,
            );
        }
    }
    return errors;
};
