/**
 * The dispatcher's data contracts (deterministic-orchestrator slice 2), split
 * from `dispatch.ts` by concern (and its max-lines budget), following the
 * router/budgets/credit-cap precedent: everything here is a pure function of
 * sub-agent output text and staged JSON — parsing each reviewer contract into
 * schema findings, the out-of-lane handoff normalization, the scope filter,
 * the claims build, and the Phase 3 verification mechanics. `dispatch.ts`
 * owns the run itself (roster, agents, waves, artifact writes).
 *
 * Determinism boundary: no model call, no filesystem, no prose about the
 * code under review.
 */

import {validateFinding, type Anchor, type Finding} from "./finding-schema";
import {extractJsonObject} from "./agent-json";
import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
    isBlockingLabel,
    labelForFinding,
} from "./render-comment";

/** Production's confidence default for label-shape reviewers (review.md). */
const LABEL_SHAPE_CONFIDENCE = 0.7;

/**
 * The full Conventional-Comments vocabulary a label-shape reviewer may emit
 * (review.md's label contract). A finding whose label is not in this set is
 * rejected so the malformed-output retry re-dispatches the reviewer: trial
 * run 29897276810's correctness-reviewer emitted its ReportFindings tool
 * shape instead (no `label` at all), the old default of `""` was accepted,
 * and four blocking correctness findings posted label-less and demoted to
 * advisory.
 */
const KNOWN_LABELS: ReadonlySet<string> = new Set([
    ...BLOCKING_LABELS,
    ...NON_BLOCKING_LABELS,
]);

/* -------------------------------------------------------------------------- */
/* Output parsing                                                             */
/* -------------------------------------------------------------------------- */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Extract the JSON object from an agent's final text, via the shared
 * lenient extraction (`agent-json.ts`) the conformance gate also applies:
 * strict parse, then fenced blocks, then balanced spans. The old
 * first-brace-to-last-brace regex broke on any prose brace before or after
 * the payload.
 */
export const parseJsonObject = (output: string): Record<string, unknown> => {
    const parsed = extractJsonObject(output);
    if (parsed === undefined) {
        throw new Error("output carries no parseable JSON object");
    }
    return parsed;
};

/**
 * One internal candidate: a schema {@link Finding} plus its producing source
 * and the label override an out-of-lane handoff carries (code-assigned; an
 * out-of-lane observation can never block on its own).
 */
export type Candidate = {
    finding: Finding;
    source: string;
    labelOverride?: string;
    skill?: string;
    authorDispute?: string;
};

/**
 * Join the label contract's `subject` and `discussion` into one prose block.
 * A subject with no terminal punctuation gets a sentence break, not a bare
 * space (run 29897276810 posted "...memory Both TestExpiration..."); the
 * break also keeps `buildClaims`' first-sentence split recovering the
 * subject.
 */
export const joinProse = (subject: string, discussion: string): string => {
    if (discussion === "") {
        return subject.trim();
    }
    if (subject === "") {
        return discussion.trim();
    }
    const trimmed = subject.trimEnd();
    // Terminal punctuation may sit inside closing quotes/brackets/emphasis.
    const core = trimmed.replace(/["'`)\]*_]+$/, "");
    const glue = /[.!?:;]$/.test(core) ? " " : ". ";
    return `${trimmed}${glue}${discussion.trim()}`;
};

/** Map one label-shape finding into a schema finding (the eval's rule). */
const fromLabelShape = (
    agentName: string,
    lens: string,
    raw: unknown,
    index: number,
): Candidate => {
    if (!isRecord(raw)) {
        throw new Error(`findings[${index}] is not an object`);
    }
    // Near-miss salvage before the label check: a reviewer drifting into a
    // ReportFindings-style shape still carries the anchor in `anchor`/`file`
    // and the subject in `summary`.
    const rawAnchor = isRecord(raw["anchor"]) ? raw["anchor"] : undefined;
    const path = raw["path"] ?? rawAnchor?.["path"] ?? raw["file"];
    const line = raw["line"] ?? rawAnchor?.["line"];
    const subject =
        typeof raw["subject"] === "string"
            ? raw["subject"]
            : typeof raw["summary"] === "string"
            ? raw["summary"]
            : typeof raw["title"] === "string"
            ? raw["title"]
            : "";
    const discussion =
        typeof raw["discussion"] === "string" ? raw["discussion"] : "";
    const label = typeof raw["label"] === "string" ? raw["label"] : "";
    if (!KNOWN_LABELS.has(label)) {
        throw new Error(
            `findings[${index}] label ${JSON.stringify(
                label,
            )} is not a Conventional Comments label; every finding needs a ` +
                `"label" field set to one of: ${[...KNOWN_LABELS].join(", ")}`,
        );
    }
    const candidate: Record<string, unknown> = {
        schema_version: 2,
        id: `${agentName}-${index + 1}`,
        lens,
        anchor:
            path === undefined || line === undefined
                ? {type: "pr"}
                : {
                      type: "line",
                      path,
                      line,
                      side: "RIGHT",
                  },
        severity: isBlockingLabel(label) ? "blocking" : "advisory",
        confidence: LABEL_SHAPE_CONFIDENCE,
        evidence_trace: [
            `${agentName} label: ${label}`,
            ...(discussion === "" ? [] : [discussion]),
        ],
        // Salvage order: the contract field, then the subject, then the
        // discussion. Trial run 29906543140's correctness pass emitted
        // valid labels with only {id, anchor, discussion}; rejecting it for
        // the missing failure_scenario voided the whole correctness
        // dimension twice, which is strictly worse than validating against
        // the discussion prose.
        failure_scenario:
            raw["failure_scenario"] ?? (subject !== "" ? subject : discussion),
        producing_hunt: `dispatch:${agentName}`,
        model_authored_prose: joinProse(subject, discussion),
        // Suggestion salvage, like the anchor/subject salvage above: run
        // 29943085279's correctness pass drifted into the ReportFindings
        // shape with the AddDate one-line fix under `suggested_patch`, and
        // reading only `suggestion` posted the comment with no committable
        // fix. `suggestion` wins when both are present (it is the contract
        // key).
        ...(typeof raw["suggestion"] === "string" && raw["suggestion"] !== ""
            ? {suggested_patch: raw["suggestion"]}
            : typeof raw["suggested_patch"] === "string" &&
              raw["suggested_patch"] !== ""
            ? {suggested_patch: raw["suggested_patch"]}
            : {}),
    };
    const result = validateFinding(candidate);
    if (!result.ok) {
        throw new Error(`findings[${index}]: ${result.errors.join("; ")}`);
    }
    return {
        finding: result.finding,
        source: agentName,
        // The producer's own label wins over the lens-computed one: label
        // shapes carry the full Conventional-Comments vocabulary (questions,
        // thoughts, todos) that labelForFinding cannot reconstruct.
        labelOverride: label,
        ...(typeof raw["skill"] === "string" && raw["skill"] !== ""
            ? {skill: raw["skill"]}
            : {}),
    };
};

/** Out-of-lane observations become question (non-blocking) handoffs. */
const fromOutOfLane = (
    agentName: string,
    raw: unknown,
    index: number,
): Candidate | null => {
    if (!isRecord(raw)) {
        return null;
    }
    const observation =
        typeof raw["observation"] === "string" ? raw["observation"] : "";
    if (observation === "") {
        return null;
    }
    const candidate: Record<string, unknown> = {
        schema_version: 2,
        id: `${agentName}-ool-${index + 1}`,
        lens: "correctness",
        anchor:
            raw["path"] === undefined || raw["line"] === undefined
                ? {type: "pr"}
                : {
                      type: "line",
                      path: raw["path"],
                      line: raw["line"],
                      side: "RIGHT",
                  },
        severity: "advisory",
        confidence: LABEL_SHAPE_CONFIDENCE,
        evidence_trace: [`${agentName} out-of-lane handoff`],
        failure_scenario: raw["failure_scenario"] ?? observation,
        producing_hunt: `dispatch:${agentName}:out-of-lane`,
        model_authored_prose: observation,
    };
    const result = validateFinding(candidate);
    if (!result.ok) {
        return null;
    }
    return {
        finding: result.finding,
        source: `${agentName} (out-of-lane)`,
        labelOverride: "question (non-blocking)",
    };
};

/**
 * Parse one finder's output into candidates, per its contract. Every
 * label-shape reviewer (the defaults and the enabled whole-change reviewers)
 * returns `findings[]` with a `label` per finding; a routed specialist lens
 * (`isLens`) returns the structured finding schema instead.
 */
export const parseFinderOutput = (
    agentName: string,
    output: string,
    usedIds: Set<string>,
    isLens = false,
): {candidates: Candidate[]; riskFiles?: unknown; hunts?: unknown} => {
    const parsed = parseJsonObject(output);
    const rawFindings = parsed["findings"];
    // A finder with nothing to report routinely omits the empty findings
    // array (production run 29893634730's correctness-reviewer returned
    // only its `files` risk block, and the whole dimension was voided).
    // Absence is accepted as empty when another contract key proves the
    // object is the contract payload; anything else is malformed.
    const looksLikeContract =
        "files" in parsed ||
        "hunts" in parsed ||
        "out_of_lane_observations" in parsed;
    const findings = Array.isArray(rawFindings)
        ? rawFindings
        : rawFindings === undefined && looksLikeContract
        ? []
        : null;
    if (findings === null) {
        throw new Error("output JSON has no findings array");
    }
    const candidates = findings.map((raw, index): Candidate => {
        if (!isLens) {
            return fromLabelShape(
                agentName,
                agentName === "skill-auditor" ? "conventions" : "correctness",
                raw,
                index,
            );
        }
        const result = validateFinding(raw);
        if (!result.ok) {
            throw new Error(`findings[${index}]: ${result.errors.join("; ")}`);
        }
        return {finding: result.finding, source: agentName};
    });
    const outOfLane = parsed["out_of_lane_observations"];
    if (Array.isArray(outOfLane)) {
        outOfLane.forEach((raw, index) => {
            const candidate = fromOutOfLane(agentName, raw, index);
            if (candidate !== null) {
                candidates.push(candidate);
            }
        });
    }
    for (const candidate of candidates) {
        if (usedIds.has(candidate.finding.id)) {
            candidate.finding = {
                ...candidate.finding,
                id: `${agentName}:${candidate.finding.id}`,
            };
        }
        usedIds.add(candidate.finding.id);
    }
    return {
        candidates,
        riskFiles: parsed["files"],
        hunts: parsed["hunts"],
    };
};

/* -------------------------------------------------------------------------- */
/* Scope filter and label computation                                         */
/* -------------------------------------------------------------------------- */

const candidateLabel = (candidate: Candidate): string =>
    candidate.labelOverride ?? labelForFinding(candidate.finding);

export const anchorPathLine = (
    anchor: Anchor,
): {path?: string; line?: number} =>
    anchor.type === "pr"
        ? {}
        : {
              path: anchor.path,
              line: "line" in anchor ? anchor.line : undefined,
          };

/**
 * The Step 3 newly-changed-code scope filter: on a re-review, drop any
 * candidate whose (path, line) is not in scope, except plain blocking labels
 * (`issue (blocking)` / `todo (blocking)`), which post wherever the defect
 * is. PR-level candidates carry no line and pass.
 */
export const applyScopeFilter = (
    candidates: Candidate[],
    scope: {priorReview?: unknown; inScope?: unknown} | undefined,
): {kept: Candidate[]; dropped: Candidate[]} => {
    if (scope === undefined || scope.priorReview !== true) {
        return {kept: candidates, dropped: []};
    }
    const inScope = isRecord(scope.inScope) ? scope.inScope : {};
    const kept: Candidate[] = [];
    const dropped: Candidate[] = [];
    for (const candidate of candidates) {
        const {path, line} = anchorPathLine(candidate.finding.anchor);
        if (path === undefined || line === undefined) {
            kept.push(candidate);
            continue;
        }
        const lines = inScope[path];
        const inside = Array.isArray(lines) && lines.includes(line);
        const label = candidateLabel(candidate);
        const plainBlocking =
            label === "issue (blocking)" || label === "todo (blocking)";
        if (inside || plainBlocking) {
            kept.push(candidate);
        } else {
            dropped.push(candidate);
        }
    }
    return {kept, dropped};
};

/* -------------------------------------------------------------------------- */
/* Claims and verification                                                    */
/* -------------------------------------------------------------------------- */

export type Claim = {
    id: string;
    source: string;
    path?: string;
    line?: number;
    label: string;
    subject: string;
    discussion: string;
    failure_scenario: string;
    suggestion?: string;
    skill?: string;
    confidence: number;
    author_dispute?: string;
    rule_quote?: string;
};

export const buildClaims = (candidates: Candidate[]): Claim[] =>
    candidates.map((candidate) => {
        const {finding} = candidate;
        const {path, line} = anchorPathLine(finding.anchor);
        const prose = finding.model_authored_prose;
        const firstSentence = prose.split(/(?<=[.!?])\s/, 1)[0] ?? prose;
        return {
            id: finding.id,
            source: candidate.source,
            ...(path !== undefined ? {path} : {}),
            ...(line !== undefined ? {line} : {}),
            label: candidateLabel(candidate),
            subject: firstSentence,
            discussion: prose,
            failure_scenario: finding.failure_scenario,
            ...(finding.suggested_patch !== undefined
                ? {suggestion: finding.suggested_patch}
                : {}),
            ...(candidate.skill !== undefined ? {skill: candidate.skill} : {}),
            confidence: finding.confidence,
            ...(candidate.authorDispute !== undefined
                ? {author_dispute: candidate.authorDispute}
                : {}),
            ...(finding.rule_quote !== undefined
                ? {rule_quote: finding.rule_quote}
                : {}),
        };
    });

/** The Phase 3 blocking→non-blocking downgrade map (review.md, mechanical). */
const NON_BLOCKING_EQUIVALENT: Record<string, string> = {
    "issue (blocking)": "suggestion (non-blocking)",
    "issue (blocking, best-practice)":
        "suggestion (non-blocking, best-practice)",
    "todo (blocking)": "suggestion (non-blocking)",
};

export type Verification = {
    verification: "confirmed" | "plausible" | "refuted";
    confidence?: number;
    corrected?: Record<string, unknown>;
};

/**
 * Parse the validator's output, per its contract (review.md): a
 * `{"claims": [{id, verification, confidence?, corrected?}]}` array,
 * returned here as an id-keyed map for mechanical application. Entries with
 * an unknown verification state or no id are skipped (they neither drop nor
 * downgrade anything: fail toward retaining).
 */
export const parseValidatorOutput = (
    output: string,
): Record<string, Verification> => {
    const parsed = parseJsonObject(output);
    const rawClaims = parsed["claims"];
    if (!Array.isArray(rawClaims)) {
        throw new Error("validator output has no claims array");
    }
    const verifications: Record<string, Verification> = {};
    for (const raw of rawClaims) {
        if (!isRecord(raw) || typeof raw["id"] !== "string") {
            continue;
        }
        const state = raw["verification"];
        if (
            state !== "confirmed" &&
            state !== "plausible" &&
            state !== "refuted"
        ) {
            continue;
        }
        verifications[raw["id"]] = {
            verification: state,
            ...(typeof raw["confidence"] === "number"
                ? {confidence: raw["confidence"]}
                : {}),
            ...(isRecord(raw["corrected"])
                ? {corrected: raw["corrected"]}
                : {}),
        };
    }
    return verifications;
};

/**
 * Apply the Phase 3 verification rules to the claims, mechanically:
 * refuted drops; plausible retains never-as-blocking with lowered
 * confidence; confirmed applies `corrected` fields. An author-disputed claim
 * is capped at plausible unless the validator confirmed it, and posts as a
 * question. A claim the validator did not mention is retained unvalidated
 * (missing-output rule).
 */
export const applyVerifications = (
    claims: Claim[],
    verifications: Record<string, Verification>,
): Claim[] => {
    const surviving: Claim[] = [];
    for (const claim of claims) {
        const verdict = verifications[claim.id];
        if (verdict === undefined) {
            // Retained unvalidated (missing-output rule), EXCEPT the dispute
            // cap, which is a mechanical floor: an author-disputed claim can
            // never re-block on the same evidence without a confirmed
            // verification, validator or no validator.
            if (claim.author_dispute !== undefined) {
                surviving.push({
                    ...claim,
                    label: "question (non-blocking)",
                });
            } else {
                surviving.push(claim);
            }
            continue;
        }
        if (verdict.verification === "refuted") {
            continue;
        }
        let updated = {...claim};
        let state = verdict.verification;
        if (state === "confirmed" && updated.author_dispute !== undefined) {
            // Mechanical floor for the usage-depth rule: the validator's
            // confirmed stands, but the dispute must be engaged in the text;
            // an unconfirmed dispute is capped below.
        }
        if (state === "confirmed" && verdict.corrected !== undefined) {
            const corrected = verdict.corrected;
            for (const key of [
                "line",
                "label",
                "subject",
                "discussion",
                "suggestion",
            ] as const) {
                const value = corrected[key];
                if (
                    value !== undefined &&
                    (typeof value === "string" || typeof value === "number")
                ) {
                    updated = {...updated, [key]: value};
                }
            }
        }
        if (state !== "confirmed" && updated.author_dispute !== undefined) {
            state = "plausible";
            updated.label = "question (non-blocking)";
        }
        if (state === "plausible") {
            updated.label =
                NON_BLOCKING_EQUIVALENT[updated.label] ?? updated.label;
            if (verdict.confidence !== undefined) {
                updated.confidence = Math.min(
                    updated.confidence,
                    verdict.confidence,
                );
            }
        } else if (verdict.confidence !== undefined) {
            updated.confidence = verdict.confidence;
        }
        surviving.push(updated);
    }
    return surviving;
};
