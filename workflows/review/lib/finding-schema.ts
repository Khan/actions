/**
 * The versioned, structured finding schema shared by every reviewer
 * sub-agent and the deterministic determinism-boundary code that consumes it
 * (the computed verdict and the templated comment rendering).
 *
 * A "finding" is the single unit a lens sub-agent emits. Sub-agents write these
 * as JSON (the #194 per-run sub-agent artifacts), so the wire keys are
 * snake_case and this module validates that JSON before any downstream code
 * (verdict, renderer, metrics) trusts it. The division of labor is fixed:
 *
 *   - CODE owns structure: the schema version, labels/severity, anchors,
 *     templated wrapping.
 *   - MODELS own prose: only `model_authored_prose` (and the optional
 *     `suggested_patch` / `pre_merge_obligation` bodies) carry human-read text.
 *
 * Bumping the shape is a breaking change for artifacts on disk, so the version
 * is an exported constant and every finding carries it; the validator rejects a
 * finding stamped with a version it does not understand.
 */

/**
 * Monotonic schema version. Bump whenever a field is added/removed/retyped in a
 * way that invalidates previously-serialized findings. Consumers compare the
 * `schema_version` on each finding against this constant.
 */
export const FINDING_SCHEMA_VERSION = 1;

/**
 * The lenses (specialist + always-on) allowed to author a finding. The
 * deterministic router dispatches to these; keeping the canonical list
 * here means the validator can reject a finding attributed to an unknown lens
 * (e.g. a typo or a decommissioned lens) rather than letting it flow downstream.
 *
 * The specialist lenses cover the path-gated risk areas; the
 * remaining entries are the always-on / whole-change reviewers and triage.
 */
export const KNOWN_LENSES = [
    // Eleven specialist lenses.
    "security-auth",
    "ai-safety-moderation",
    "mass-comms-coppa",
    "caching-resource",
    "data-migrations",
    "concurrency-async",
    "api-federation-compat",
    "cross-deploy-serialization",
    "deploy-infra-config",
    "money-payments",
    "content-i18n",
    // Always-on / whole-change reviewers and triage.
    "correctness",
    "conventions",
    "pattern-triage",
    "first-principles",
] as const;

export type Lens = typeof KNOWN_LENSES[number];

/**
 * Per-finding severity. This is the blocking-relevant axis #194 introduced
 * (blocking vs. advisory); the computed verdict turns the mix of
 * severities plus posted-comment labels into a run-level outcome. Kept
 * deliberately small — richer taxonomy lives in Conventional-Comment labels,
 * which are code-owned at render time, not here.
 */
export const SEVERITIES = ["blocking", "advisory"] as const;

export type Severity = typeof SEVERITIES[number];

/**
 * Confidence axis (enables the eval suite's calibration metric). Numeric so a
 * calibration curve can be plotted; constrained to the closed unit interval.
 */
export const MIN_CONFIDENCE = 0;
export const MAX_CONFIDENCE = 1;

/**
 * Where a finding is anchored. A finding may be:
 *   - `line`: a specific line (or line range) on one side of the diff — the
 *     common case, rendered as an inline review comment.
 *   - `file`: a whole file, when the concern is not line-specific.
 *   - `pr`: the PR as a whole (e.g. an architectural or cross-file concern) —
 *     the PR-level anchor type the schema is required to support. It carries no
 *     path/line and renders as a top-level review comment.
 */
export const ANCHOR_TYPES = ["line", "file", "pr"] as const;

export type AnchorType = typeof ANCHOR_TYPES[number];

export type Side = "LEFT" | "RIGHT";

export type LineAnchor = {
    type: "line";
    path: string;
    /** 1-based line number the comment attaches to (the end line of a range). */
    line: number;
    /** Diff side; defaults to the added ("RIGHT") side when omitted. */
    side?: Side;
    /** 1-based first line of a multi-line range; when set, must be <= `line`. */
    start_line?: number;
};

export type FileAnchor = {
    type: "file";
    path: string;
};

export type PrAnchor = {
    type: "pr";
};

export type Anchor = LineAnchor | FileAnchor | PrAnchor;

/**
 * The structured finding. `snake_case` keys mirror the on-disk JSON artifact
 * that sub-agents emit.
 */
export type Finding = {
    /** Schema version this finding was authored against. */
    schema_version: number;
    /** Stable identifier, unique within a run (dedup + thumbs correlation). */
    id: string;
    /** Which lens authored the finding. */
    lens: Lens;
    /** Where the finding is anchored (line / file / PR-level). */
    anchor: Anchor;
    /** Blocking-relevant severity. */
    severity: Severity;
    /** Calibration confidence in [0, 1]. */
    confidence: number;
    /**
     * Ordered evidence the lens gathered to justify the finding (file/line
     * references, tool observations, reasoning steps). At least one entry — a
     * finding with no evidence is not actionable and is rejected.
     */
    evidence_trace: string[];
    /** Optional unified-diff patch the author suggests (rendered as a suggestion). */
    suggested_patch?: string;
    /**
     * Optional pre-merge obligation text. Drives the conditional-approval
     * (APPROVE-with-obligations) rendering.
     */
    pre_merge_obligation?: string;
    /**
     * Identifier of the concrete hunt/sub-agent run that produced this finding
     * (provenance for the live counters and validator drop-rate per lens).
     */
    producing_hunt: string;
    /** The single human-read sentence(s) authored by the model. */
    model_authored_prose: string;
};

export type ValidationResult =
    | {ok: true; finding: Finding}
    | {ok: false; errors: string[]};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

const validateAnchor = (value: unknown, errors: string[]): void => {
    if (!isRecord(value)) {
        errors.push("anchor: must be an object");
        return;
    }

    const type = value["type"];
    if (!isNonEmptyString(type) || !ANCHOR_TYPES.includes(type as AnchorType)) {
        errors.push(`anchor.type: must be one of ${ANCHOR_TYPES.join(", ")}`);
        return;
    }

    if (type === "pr") {
        // PR-level anchor carries no path/line.
        return;
    }

    if (!isNonEmptyString(value["path"])) {
        errors.push(
            `anchor.path: required non-empty string for ${type} anchor`,
        );
    }

    if (type === "line") {
        const line = value["line"];
        if (!Number.isInteger(line) || (line as number) < 1) {
            errors.push("anchor.line: must be a positive integer");
        }

        const side = value["side"];
        if (side !== undefined && side !== "LEFT" && side !== "RIGHT") {
            errors.push('anchor.side: must be "LEFT" or "RIGHT" when present');
        }

        const startLine = value["start_line"];
        if (startLine !== undefined) {
            if (!Number.isInteger(startLine) || (startLine as number) < 1) {
                errors.push("anchor.start_line: must be a positive integer");
            } else if (
                Number.isInteger(line) &&
                (startLine as number) > (line as number)
            ) {
                errors.push("anchor.start_line: must be <= anchor.line");
            }
        }
    }
};

/**
 * Validate an untrusted value (typically parsed sub-agent JSON) against the
 * finding schema. Returns every problem found — callers log the full list so a
 * lens's validator drop-rate is diagnosable — rather than failing on the first.
 */
export const validateFinding = (input: unknown): ValidationResult => {
    const errors: string[] = [];

    if (!isRecord(input)) {
        return {ok: false, errors: ["finding: must be an object"]};
    }

    const schemaVersion = input["schema_version"];
    if (schemaVersion !== FINDING_SCHEMA_VERSION) {
        errors.push(
            `schema_version: must equal ${FINDING_SCHEMA_VERSION} (got ${JSON.stringify(
                schemaVersion,
            )})`,
        );
    }

    if (!isNonEmptyString(input["id"])) {
        errors.push("id: required non-empty string");
    }

    if (
        !isNonEmptyString(input["lens"]) ||
        !KNOWN_LENSES.includes(input["lens"] as Lens)
    ) {
        errors.push(`lens: must be one of ${KNOWN_LENSES.join(", ")}`);
    }

    validateAnchor(input["anchor"], errors);

    if (
        !isNonEmptyString(input["severity"]) ||
        !SEVERITIES.includes(input["severity"] as Severity)
    ) {
        errors.push(`severity: must be one of ${SEVERITIES.join(", ")}`);
    }

    const confidence = input["confidence"];
    if (
        typeof confidence !== "number" ||
        Number.isNaN(confidence) ||
        confidence < MIN_CONFIDENCE ||
        confidence > MAX_CONFIDENCE
    ) {
        errors.push(
            `confidence: must be a number in [${MIN_CONFIDENCE}, ${MAX_CONFIDENCE}]`,
        );
    }

    const evidenceTrace = input["evidence_trace"];
    if (
        !Array.isArray(evidenceTrace) ||
        evidenceTrace.length === 0 ||
        !evidenceTrace.every(isNonEmptyString)
    ) {
        errors.push(
            "evidence_trace: must be a non-empty array of non-empty strings",
        );
    }

    if (!isNonEmptyString(input["producing_hunt"])) {
        errors.push("producing_hunt: required non-empty string");
    }

    if (!isNonEmptyString(input["model_authored_prose"])) {
        errors.push("model_authored_prose: required non-empty string");
    }

    // Optional fields: only constrained when present.
    if (
        input["suggested_patch"] !== undefined &&
        !isNonEmptyString(input["suggested_patch"])
    ) {
        errors.push("suggested_patch: must be a non-empty string when present");
    }

    if (
        input["pre_merge_obligation"] !== undefined &&
        !isNonEmptyString(input["pre_merge_obligation"])
    ) {
        errors.push(
            "pre_merge_obligation: must be a non-empty string when present",
        );
    }

    if (errors.length > 0) {
        return {ok: false, errors};
    }

    return {ok: true, finding: input as Finding};
};

/** Narrowing boolean wrapper around {@link validateFinding}. */
export const isValidFinding = (input: unknown): input is Finding =>
    validateFinding(input).ok;

/**
 * Throwing wrapper around {@link validateFinding} for call sites that treat a
 * malformed finding as a programmer error. The thrown message lists every
 * violation.
 */
export const assertFinding = (input: unknown): Finding => {
    const result = validateFinding(input);
    if (!result.ok) {
        throw new Error(
            `Invalid finding:\n${result.errors
                .map((e) => `  - ${e}`)
                .join("\n")}`,
        );
    }
    return result.finding;
};
