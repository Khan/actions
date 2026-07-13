/**
 * Shared eval-corpus loader — the SINGLE dataset format and loader used by
 * both the smoke benchmark (a tagged subset) and the full eval
 * suite (four datasets, five metrics, judge). "One harness" (
 * the spec): the smoke set is not a separate format, it is the cases in the
 * corpus that carry the {@link SMOKE_TAG} tag, so the smoke gate and the full
 * suite read exactly the same files through this loader.
 *
 * A corpus *case* is a JSON file describing one PR the reviewer should be run
 * against, plus the recorded sub-agent findings for it and the expected outcome.
 * The runner (`../runner.ts`) replays the deterministic review path over a case
 * with no GitHub write; the full suite's metrics/judge score a run against the same
 * case's `expected` block. Cases are data (JSON), not code, so a human (or a
 * future generator) can add one without touching TypeScript.
 *
 * This module authors no human-read prose about code under review (the
 * tripwire the lib modules observe): every string it handles is a case field, a
 * path, a tag, or a validation error — never a sentence composed about a diff.
 */

import {existsSync, readdirSync, readFileSync} from "node:fs";

import {
    validateFinding,
    type Finding,
    type Severity,
} from "../../lib/finding-schema";
import {LIVE_TAG, liveTreeErrors, parseLive, type CaseLive} from "./live";
import type {ChangedFile, FileStatus, RiskTier} from "../../lib/router";
import type {VerdictEvent} from "../../lib/render-comment";
import type {DimensionStatus} from "../../lib/verdict";

/* -------------------------------------------------------------------------- */
/* Tags, categories, and the on-disk case shape                              */
/* -------------------------------------------------------------------------- */

/** The tag that marks a case as part of the smoke subset . */
export const SMOKE_TAG = "smoke";

/** The live-enabled half of the case format lives in `./live`; re-exported
 * here so the loader stays the single public surface of the corpus format. */
export {LIVE_TAG} from "./live";
export type {CaseLive, LiveDefectSpec, LivePrContext} from "./live";

/** Default corpus root, relative to the repo checkout (the workflow's cwd). */
export const CORPUS_ROOT = "workflows/review/eval/corpus";

/**
 * Case categories. The three the smoke set requires (`incident-repro`,
 * `adversarial-injection`, `clean`) plus the two the full suite adds
 * (`golden` human-comment cases, `synthetic-mutation` lens-mapped mutations), so
 * the format does not need to change when the full suite lands its datasets.
 */
export const CASE_CATEGORIES = [
    "incident-repro",
    "adversarial-injection",
    "clean",
    "golden",
    "synthetic-mutation",
] as const;

export type CaseCategory = typeof CASE_CATEGORIES[number];

/**
 * A single recorded sub-agent finding, as it appears in a case file. `source` is
 * the reviewer/lens that produced it (e.g. `security-auth`, `correctness`),
 * carried so the runner and the full suite's counters can attribute findings; the
 * finding body itself is a full {@link Finding} validated against the schema.
 */
export type RecordedFinding = {
    /** Producing reviewer/lens name (provenance; e.g. `correctness`). */
    source: string;
    /** The structured finding the sub-agent emitted (schema-validated). */
    finding: Finding;
};

/**
 * Availability of the verdict-relevant dimensions for a case. Optional in the
 * file; the loader defaults every dimension to `assessed` (the common case — a
 * run where every core pass produced output). A case sets one to `unavailable`
 * to exercise the hold-for-human gate.
 */
export type CaseDimensions = {
    correctness: DimensionStatus;
    skillSeverity: DimensionStatus;
    patternTriage: DimensionStatus;
};

/** A policy-named conflict a lens surfaced but could not adjudicate (hold). */
export type CasePolicyConflict = {
    policy: string;
    detail: string;
};

/**
 * The newly-changed-code scope for a case (mirrors `review.md` Step 1's
 * `new-scope.json`). When present with `priorReview: true`, the runner scopes
 * inline candidates to `inScope` exactly as the workflow does. Absent → the
 * whole diff is in scope (first review).
 */
export type CaseScope = {
    priorReview: boolean;
    /** path → RIGHT-side line numbers considered newly-changed. */
    inScope: Record<string, number[]>;
};

/** The claim-validator's three-state verification (review.md Step 3 Phase 3). */
export const VERIFICATION_STATES = [
    "confirmed",
    "plausible",
    "refuted",
] as const;

export type VerificationState = typeof VERIFICATION_STATES[number];

/**
 * One recorded claim-validator verification for a case finding. The runner
 * replays the Phase 3 apply rules mechanically: `refuted` drops the finding,
 * `plausible` downgrades it to non-blocking (only a `confirmed` claim may carry
 * a blocking label into the verdict), `confirmed` keeps it. `confidence`
 * optionally overrides the finding's confidence (the validator lowers it for
 * `plausible`). Absent from a case → no validation replay (the recorded
 * findings are treated as the post-validation set, as before).
 */
export type CaseVerification = {
    /** The recorded finding id this verification applies to. */
    id: string;
    verification: VerificationState;
    /** Post-verification confidence in [0,1], when the validator changed it. */
    confidence?: number;
};

/**
 * The scored expectations for a case — the "ground truth" the full suite's metrics
 * read. `verdict` is the only field the smoke gate needs ; the rest
 * are optional and consumed by the full suite's recall/precision/noise metrics.
 */
export type CaseExpectation = {
    /** The verdict the deterministic path must compute for this case. */
    verdict: VerdictEvent;
    /**
     * Finding ids that MUST appear in the posted set (must-catch recall). A
     * clean case leaves this empty; an incident repro lists the id(s) that
     * reproduce the incident.
     */
    mustCatch?: string[];
    /**
     * Finding ids that must NOT be posted (false-positive / noise guard, e.g. a
     * candidate the scope filter should drop, or a clean case that must stay
     * silent).
     */
    mustNotPost?: string[];
    /** Exact count of inline comments the run should post, when pinned. */
    postedCommentCount?: number;
};

/**
 * One corpus case. The single dataset format shared by the smoke subset and the
 * full eval suite. `tags` carry `smoke` for the smoke subset; other tags (e.g. a
 * lens name, `holdout`, `adversarial`) let the full suite slice the corpus for its
 * holdout and adversarial gates without a format change.
 */
export type CorpusCase = {
    id: string;
    tags: string[];
    category: CaseCategory;
    description: string;
    changedFiles: ChangedFile[];
    /** Optional per-case router config overrides (lens/risk/reviewer rules). */
    routerConfig?: Record<string, unknown>;
    dimensions: CaseDimensions;
    findings: RecordedFinding[];
    /** Recorded claim-validator verifications the runner replays (Phase 3). */
    validation?: CaseVerification[];
    policyConflicts: CasePolicyConflict[];
    /** Absent → first review (whole diff in scope). */
    scope?: CaseScope;
    /**
     * The PR's unified diff text, when the case exercises the
     * change-provenance gate: the runner computes the changed-line map from it
     * and collapses out-of-provenance findings into one note. Absent → the
     * gate is skipped (every finding treated as change-anchored, the
     * pre-gate behavior).
     */
    diff?: string;
    /**
     * Present iff the case is live-enabled (tagged {@link LIVE_TAG}): the
     * change content a real model run reviews. Ignored by the deterministic
     * replay path.
     */
    live?: CaseLive;
    expected: CaseExpectation;
    /** Absolute or repo-relative path the case was loaded from (provenance). */
    sourcePath: string;
};

/* -------------------------------------------------------------------------- */
/* Filesystem seam (injected so the loader is testable without touching disk) */
/* -------------------------------------------------------------------------- */

export type Dirent = {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
};

export type LoaderFs = {
    existsSync: (p: string) => boolean;
    readdirSync: (p: string, opts: {withFileTypes: true}) => Dirent[];
    readFileSync: (p: string, enc: "utf8") => string;
};

const DEFAULT_DIMENSIONS: CaseDimensions = {
    correctness: "assessed",
    skillSeverity: "assessed",
    patternTriage: "assessed",
};

const FILE_STATUSES: readonly FileStatus[] = [
    "added",
    "modified",
    "removed",
    "renamed",
    "copied",
    "changed",
];

const DIMENSION_STATUSES: readonly DimensionStatus[] = [
    "assessed",
    "unavailable",
];

const VERDICT_EVENTS: readonly VerdictEvent[] = [
    "APPROVE",
    "REQUEST_CHANGES",
    "HOLD_FOR_HUMAN",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

/* -------------------------------------------------------------------------- */
/* Validation (content-in, structure-out; every problem surfaced, not just #1) */
/* -------------------------------------------------------------------------- */

/** Thrown when a case file is structurally invalid; message lists every error. */
export class CorpusCaseError extends Error {
    constructor(sourcePath: string, errors: string[]) {
        super(
            `Invalid corpus case ${sourcePath}:\n${errors
                .map((e) => `  - ${e}`)
                .join("\n")}`,
        );
        this.name = "CorpusCaseError";
    }
}

const parseChangedFiles = (raw: unknown, errors: string[]): ChangedFile[] => {
    if (!Array.isArray(raw) || raw.length === 0) {
        errors.push("changedFiles: must be a non-empty array");
        return [];
    }
    const files: ChangedFile[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry)) {
            errors.push(`changedFiles[${i}]: must be an object`);
            return;
        }
        if (!isNonEmptyString(entry["path"])) {
            errors.push(`changedFiles[${i}].path: required non-empty string`);
        }
        const status = entry["status"];
        if (
            !isNonEmptyString(status) ||
            !FILE_STATUSES.includes(status as FileStatus)
        ) {
            errors.push(
                `changedFiles[${i}].status: must be one of ${FILE_STATUSES.join(
                    ", ",
                )}`,
            );
        }
        if (isNonEmptyString(entry["path"]) && isNonEmptyString(status)) {
            files.push({path: entry["path"], status: status as FileStatus});
        }
    });
    return files;
};

const parseDimensions = (raw: unknown, errors: string[]): CaseDimensions => {
    if (raw === undefined) {
        return {...DEFAULT_DIMENSIONS};
    }
    if (!isRecord(raw)) {
        errors.push("dimensions: must be an object when present");
        return {...DEFAULT_DIMENSIONS};
    }
    const out: CaseDimensions = {...DEFAULT_DIMENSIONS};
    for (const key of [
        "correctness",
        "skillSeverity",
        "patternTriage",
    ] as const) {
        const value = raw[key];
        if (value === undefined) {
            continue;
        }
        if (
            !isNonEmptyString(value) ||
            !DIMENSION_STATUSES.includes(value as DimensionStatus)
        ) {
            errors.push(
                `dimensions.${key}: must be one of ${DIMENSION_STATUSES.join(
                    ", ",
                )}`,
            );
            continue;
        }
        out[key] = value as DimensionStatus;
    }
    return out;
};

const parseFindings = (raw: unknown, errors: string[]): RecordedFinding[] => {
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        errors.push("findings: must be an array when present");
        return [];
    }
    const findings: RecordedFinding[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry)) {
            errors.push(`findings[${i}]: must be an object`);
            return;
        }
        if (!isNonEmptyString(entry["source"])) {
            errors.push(`findings[${i}].source: required non-empty string`);
        }
        const result = validateFinding(entry["finding"]);
        if (!result.ok) {
            for (const e of result.errors) {
                errors.push(`findings[${i}].finding.${e}`);
            }
            return;
        }
        if (isNonEmptyString(entry["source"])) {
            findings.push({source: entry["source"], finding: result.finding});
        }
    });
    return findings;
};

const parseValidation = (
    raw: unknown,
    findings: RecordedFinding[],
    errors: string[],
): CaseVerification[] | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        errors.push("validation: must be an array when present");
        return undefined;
    }
    const findingIds = new Set(findings.map((f) => f.finding.id));
    const seen = new Set<string>();
    const verifications: CaseVerification[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry)) {
            errors.push(`validation[${i}]: must be an object`);
            return;
        }
        const id = entry["id"];
        if (!isNonEmptyString(id)) {
            errors.push(`validation[${i}].id: required non-empty string`);
            return;
        }
        if (!findingIds.has(id)) {
            errors.push(
                `validation[${i}].id: "${id}" does not match a recorded finding`,
            );
            return;
        }
        if (seen.has(id)) {
            errors.push(
                `validation[${i}].id: duplicate verification for "${id}"`,
            );
            return;
        }
        seen.add(id);
        const verification = entry["verification"];
        if (
            !isNonEmptyString(verification) ||
            !VERIFICATION_STATES.includes(verification as VerificationState)
        ) {
            errors.push(
                `validation[${i}].verification: must be one of ${VERIFICATION_STATES.join(
                    ", ",
                )}`,
            );
            return;
        }
        const out: CaseVerification = {
            id,
            verification: verification as VerificationState,
        };
        const confidence = entry["confidence"];
        if (confidence !== undefined) {
            if (
                typeof confidence !== "number" ||
                confidence < 0 ||
                confidence > 1
            ) {
                errors.push(
                    `validation[${i}].confidence: must be a number in [0,1]`,
                );
                return;
            }
            out.confidence = confidence;
        }
        verifications.push(out);
    });
    return verifications;
};

const parsePolicyConflicts = (
    raw: unknown,
    errors: string[],
): CasePolicyConflict[] => {
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        errors.push("policyConflicts: must be an array when present");
        return [];
    }
    const conflicts: CasePolicyConflict[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry)) {
            errors.push(`policyConflicts[${i}]: must be an object`);
            return;
        }
        if (!isNonEmptyString(entry["policy"])) {
            errors.push(
                `policyConflicts[${i}].policy: required non-empty string`,
            );
        }
        if (!isNonEmptyString(entry["detail"])) {
            errors.push(
                `policyConflicts[${i}].detail: required non-empty string`,
            );
        }
        if (
            isNonEmptyString(entry["policy"]) &&
            isNonEmptyString(entry["detail"])
        ) {
            conflicts.push({policy: entry["policy"], detail: entry["detail"]});
        }
    });
    return conflicts;
};

const parseScope = (raw: unknown, errors: string[]): CaseScope | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    if (!isRecord(raw)) {
        errors.push("scope: must be an object when present");
        return undefined;
    }
    if (typeof raw["priorReview"] !== "boolean") {
        errors.push("scope.priorReview: required boolean");
    }
    const inScope: Record<string, number[]> = {};
    const rawInScope = raw["inScope"];
    if (rawInScope !== undefined) {
        if (!isRecord(rawInScope)) {
            errors.push("scope.inScope: must be an object of path -> line[]");
        } else {
            for (const [path, lines] of Object.entries(rawInScope)) {
                if (
                    !Array.isArray(lines) ||
                    !lines.every(
                        (n) => Number.isInteger(n) && (n as number) > 0,
                    )
                ) {
                    errors.push(
                        `scope.inScope[${path}]: must be an array of positive integers`,
                    );
                    continue;
                }
                inScope[path] = lines as number[];
            }
        }
    }
    if (typeof raw["priorReview"] !== "boolean") {
        return undefined;
    }
    return {priorReview: raw["priorReview"], inScope};
};

const parseExpectation = (raw: unknown, errors: string[]): CaseExpectation => {
    if (!isRecord(raw)) {
        errors.push("expected: must be an object");
        return {verdict: "APPROVE"};
    }
    const verdict = raw["verdict"];
    if (
        !isNonEmptyString(verdict) ||
        !VERDICT_EVENTS.includes(verdict as VerdictEvent)
    ) {
        errors.push(
            `expected.verdict: must be one of ${VERDICT_EVENTS.join(", ")}`,
        );
    }
    const expectation: CaseExpectation = {
        verdict: (isNonEmptyString(verdict)
            ? verdict
            : "APPROVE") as VerdictEvent,
    };

    const strArray = (key: "mustCatch" | "mustNotPost"): void => {
        const value = raw[key];
        if (value === undefined) {
            return;
        }
        if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
            errors.push(
                `expected.${key}: must be an array of non-empty strings`,
            );
            return;
        }
        expectation[key] = value as string[];
    };
    strArray("mustCatch");
    strArray("mustNotPost");

    const count = raw["postedCommentCount"];
    if (count !== undefined) {
        if (!Number.isInteger(count) || (count as number) < 0) {
            errors.push(
                "expected.postedCommentCount: must be a non-negative integer",
            );
        } else {
            expectation.postedCommentCount = count as number;
        }
    }
    return expectation;
};

/**
 * Validate + normalise one parsed JSON value into a {@link CorpusCase}. Collects
 * every structural problem and throws a single {@link CorpusCaseError} listing
 * them all, so a broken case is fully diagnosable in one pass.
 */
export const parseCase = (raw: unknown, sourcePath: string): CorpusCase => {
    const errors: string[] = [];

    if (!isRecord(raw)) {
        throw new CorpusCaseError(sourcePath, ["case: must be a JSON object"]);
    }

    if (!isNonEmptyString(raw["id"])) {
        errors.push("id: required non-empty string");
    }

    const tags = raw["tags"];
    if (
        !Array.isArray(tags) ||
        tags.length === 0 ||
        !tags.every(isNonEmptyString)
    ) {
        errors.push("tags: must be a non-empty array of non-empty strings");
    }

    const category = raw["category"];
    if (
        !isNonEmptyString(category) ||
        !CASE_CATEGORIES.includes(category as CaseCategory)
    ) {
        errors.push(`category: must be one of ${CASE_CATEGORIES.join(", ")}`);
    }

    if (!isNonEmptyString(raw["description"])) {
        errors.push("description: required non-empty string");
    }

    const changedFiles = parseChangedFiles(raw["changedFiles"], errors);
    const dimensions = parseDimensions(raw["dimensions"], errors);
    const findings = parseFindings(raw["findings"], errors);
    const validation = parseValidation(raw["validation"], findings, errors);
    const policyConflicts = parsePolicyConflicts(
        raw["policyConflicts"],
        errors,
    );
    const scope = parseScope(raw["scope"], errors);
    const expected = parseExpectation(raw["expected"], errors);

    if (raw["routerConfig"] !== undefined && !isRecord(raw["routerConfig"])) {
        errors.push("routerConfig: must be an object when present");
    }

    if (raw["diff"] !== undefined && !isNonEmptyString(raw["diff"])) {
        errors.push("diff: must be a non-empty string when present");
    }

    const live = parseLive(
        raw["live"],
        changedFiles,
        isNonEmptyString(raw["diff"]) ? raw["diff"] : undefined,
        errors,
    );
    const tagList = Array.isArray(tags) ? tags.filter(isNonEmptyString) : [];
    if (raw["live"] !== undefined && !tagList.includes(LIVE_TAG)) {
        errors.push(
            `tags: a case with a live block must carry the "${LIVE_TAG}" tag`,
        );
    }
    if (raw["live"] === undefined && tagList.includes(LIVE_TAG)) {
        errors.push(`tags: the "${LIVE_TAG}" tag requires a live block`);
    }

    if (errors.length > 0) {
        throw new CorpusCaseError(sourcePath, errors);
    }

    const result: CorpusCase = {
        id: raw["id"] as string,
        tags: [...(raw["tags"] as string[])],
        category: category as CaseCategory,
        description: raw["description"] as string,
        changedFiles,
        dimensions,
        findings,
        policyConflicts,
        expected,
        sourcePath,
    };
    if (isRecord(raw["routerConfig"])) {
        result.routerConfig = raw["routerConfig"];
    }
    if (validation !== undefined) {
        result.validation = validation;
    }
    if (scope !== undefined) {
        result.scope = scope;
    }
    if (isNonEmptyString(raw["diff"])) {
        result.diff = raw["diff"];
    }
    if (live !== undefined) {
        result.live = live;
    }
    return result;
};

/* -------------------------------------------------------------------------- */
/* Loading from disk                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Recursively collect every corpus case file path under `dir` (sorted).
 *
 * Two layouts coexist: a flat `<id>.json`, and a case directory
 * `<id>/case.json` whose siblings (a live case's `tree/`) are data, not corpus
 * JSON. A directory containing `case.json` is therefore taken as exactly that
 * one case and never recursed into — a `package.json` inside a live tree must
 * not be parsed as a corpus case.
 */
const collectJsonFiles = (dir: string, fs: LoaderFs): string[] => {
    const out: string[] = [];
    const walk = (current: string): void => {
        const entries = fs.readdirSync(current, {withFileTypes: true});
        if (entries.some((e) => e.isFile() && e.name === "case.json")) {
            out.push(`${current}/case.json`);
            return;
        }
        for (const entry of entries) {
            const full = `${current}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith(".json")) {
                out.push(full);
            }
        }
    };
    walk(dir);
    return out.sort();
};

/**
 * Check a live case's on-disk tree (see `liveTreeErrors` in `./live` for the
 * rules). Throws {@link CorpusCaseError} listing every problem. Exported for
 * reuse by live tooling that loads a single case outside {@link loadCorpus}.
 */
export const validateLiveTree = (
    corpusCase: CorpusCase,
    fs: LoaderFs = DEFAULT_FS,
): void => {
    if (corpusCase.live === undefined) {
        return;
    }
    const errors = liveTreeErrors(
        corpusCase.live,
        corpusCase.changedFiles,
        corpusCase.sourcePath,
        fs.existsSync,
    );
    if (errors.length > 0) {
        throw new CorpusCaseError(corpusCase.sourcePath, errors);
    }
};

/**
 * The default filesystem — the real Node `fs`, adapted to {@link LoaderFs}. A
 * static import (not `require`) so the loader works unchanged under both the
 * CommonJS `node -r @swc-node/register` path and vitest's ESM transform.
 */
const DEFAULT_FS: LoaderFs = {
    existsSync,
    readdirSync: (p, opts) => readdirSync(p, opts) as unknown as Dirent[],
    readFileSync: (p, enc) => readFileSync(p, enc),
};

/**
 * Load every corpus case under `dir` (default {@link CORPUS_ROOT}), recursively.
 * Returns cases sorted by `id` for deterministic downstream runs. A missing
 * directory yields an empty list (a corpus that has not been populated yet is
 * not an error); a malformed case file throws {@link CorpusCaseError}. Duplicate
 * `id`s across files are an error — ids must be unique for metric attribution.
 */
export const loadCorpus = (
    dir: string = CORPUS_ROOT,
    fs: LoaderFs = DEFAULT_FS,
): CorpusCase[] => {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const cases = collectJsonFiles(dir, fs).map((path) =>
        parseCase(JSON.parse(fs.readFileSync(path, "utf8")), path),
    );
    for (const c of cases) {
        validateLiveTree(c, fs);
    }

    const seen = new Map<string, string>();
    for (const c of cases) {
        const prior = seen.get(c.id);
        if (prior !== undefined) {
            throw new Error(
                `Duplicate corpus case id "${c.id}" in ${c.sourcePath} (already defined in ${prior})`,
            );
        }
        seen.set(c.id, c.sourcePath);
    }

    return cases.sort((a, b) => a.id.localeCompare(b.id));
};

/** The cases carrying `tag`, in loaded (id-sorted) order. */
export const filterByTag = (cases: CorpusCase[], tag: string): CorpusCase[] =>
    cases.filter((c) => c.tags.includes(tag));

/**
 * Load the smoke subset: every case in the corpus tagged {@link SMOKE_TAG}. This
 * is the "tagged subset of the eval corpus"  — it reads the same root
 * the full suite reads and filters by tag, so the smoke gate and the full suite
 * never diverge in format or loader.
 */
export const loadSmokeCorpus = (
    dir: string = CORPUS_ROOT,
    fs: LoaderFs = DEFAULT_FS,
): CorpusCase[] => filterByTag(loadCorpus(dir, fs), SMOKE_TAG);

/**
 * Load the live-enabled subset: every case tagged {@link LIVE_TAG}, i.e. every
 * case carrying the change content a real model run needs. The live A/B
 * runner reads exactly this subset (`live-ab-plan.md`).
 */
export const loadLiveCorpus = (
    dir: string = CORPUS_ROOT,
    fs: LoaderFs = DEFAULT_FS,
): CorpusCase[] => filterByTag(loadCorpus(dir, fs), LIVE_TAG);

/** Re-exported for callers assembling expectations against finding severity. */
export type {Severity, RiskTier};
