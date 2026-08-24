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

import type {AlsoFlagged} from "./attribution";
import {
    validateFinding,
    type Anchor,
    type Finding,
    type Lens,
} from "./finding-schema";
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
        // An empty final is a different failure from a malformed one: the
        // agent returned nothing at all, which on cyber-adjacent input is how
        // a refusal presents (#294: it surfaces "as a missing agent result,
        // not an error"). Reporting it as malformed output sent three eval
        // runs after the wrong cause.
        throw new Error(
            output.trim() === ""
                ? "agent returned no final text (empty output)"
                : "output carries no parseable JSON object",
        );
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
 * Fold a prose token toward its stem so an inflection difference does not
 * defeat the restatement check below ("drops" vs "dropped", "cache" vs
 * "caches"). Deliberately crude: strip one of ing/ed/es/s, collapse a
 * doubled final consonant ("dropped" -> "dropp" -> "drop"), then strip a
 * trailing "e" so "caches" -> "cach" meets "cache" -> "cach". Both sides
 * of every comparison fold identically, and a miss is safe — the subject
 * is kept and the body merely stays as long as it is today.
 */
const foldToken = (token: string): string => {
    if (token.length <= 3) {
        return token;
    }
    let folded = token;
    for (const suffix of ["ing", "ed", "es", "s"]) {
        if (folded.endsWith(suffix) && folded.length - suffix.length >= 3) {
            folded = folded.slice(0, folded.length - suffix.length);
            break;
        }
    }
    if (/([b-df-hj-np-tv-z])\1$/.test(folded)) {
        folded = folded.slice(0, -1);
    }
    return folded.length >= 4 && folded.endsWith("e")
        ? folded.slice(0, -1)
        : folded;
};

/**
 * Function words that carry no claim content; ignored on the SUBJECT side
 * of the restatement check so "turns are dropped" still matches "drops
 * turns" (the sentence has no "are"). Never filtered from the sentence
 * side — there they can only help containment, not hurt it. Distinct from
 * dedup-text.ts's STOPWORDS (near-identical list, different semantics:
 * that one filters both sides of a similarity score).
 */
/**
 * Split point for "the discussion's first sentence": a sentence terminator
 * followed by whitespace. Shared by the restatement drop and buildClaims'
 * subject recovery, which must agree on what the first sentence IS: the
 * drop's whole safety argument is that buildClaims recovers the same text
 * the subject restated.
 */
const FIRST_SENTENCE_SPLIT = /(?<=[.!?])\s/;

const SUBJECT_STOPWORDS: ReadonlySet<string> = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "by",
    "for",
    "with",
    "as",
    "at",
    "so",
]);

/**
 * The comparable word tokens of a prose fragment: markdown emphasis
 * stripped, lowercased, internal punctuation kept (`counts.go` is one
 * token) but trailing punctuation shed ("turns." and "turns" are the same
 * word).
 */
const proseTokens = (text: string): string[] =>
    (
        text
            .toLowerCase()
            .replace(/[`*_]/g, "")
            .match(/[a-z0-9][a-z0-9./:-]*/g) ?? []
    ).map((token) => token.replace(/[./:-]+$/, ""));

/**
 * Whether the subject merely restates the discussion's FIRST sentence:
 * every folded subject token already appears there, so prepending the
 * subject adds repetition and no vocabulary. This is the mechanical
 * subset of the prose repetition the 2026-08-20 version audit measured
 * in v1.11.0-v1.13.0 bodies (5 of 29 sampled bodies restated one fact two
 * to four times, vs 1 of 60 before): the v1.8.0 task-mode removal deleted
 * the orchestrator rewrite pass that used to absorb subject/discussion
 * overlap (PRA-46). Re-fetching the 5 audited fail bodies shows their
 * restatement is mostly paraphrase (same fact, different vocabulary),
 * which a token-containment check deliberately does not touch; that mode
 * is producer-side (finding-contract wording, PRA-46 follow-up). This
 * drop removes only the strict duplicate, where firing is provably safe.
 *
 * First-sentence-only is deliberate. When the drop fires, `buildClaims`'
 * first-sentence split recovers the discussion's opening sentence as
 * `claim.subject`, and that string is a visible header downstream (the
 * HOLD_FOR_HUMAN and over-cap collapsed lists, `renderPrLevelFold`), so it
 * must be the claim; matching a later sentence would leave setup prose
 * there. A subject restating a later sentence, one summarizing across
 * sentences, or one carrying any token the first sentence lacks is kept
 * whole. The comparison is an unordered token bag, so a subject reusing
 * the sentence's exact vocabulary to state a different relation would be
 * dropped too; accepted, since the audited failure mode is restatement and
 * the sentence carrying that vocabulary still posts.
 */
const subjectRestatesDiscussion = (
    subject: string,
    discussion: string,
): boolean => {
    const subjectTokens = proseTokens(subject)
        .filter((token) => !SUBJECT_STOPWORDS.has(token))
        .map(foldToken);
    if (subjectTokens.length === 0) {
        return false;
    }
    const firstSentence = discussion.split(FIRST_SENTENCE_SPLIT, 1)[0] ?? "";
    // A "first sentence" spanning lines means the discussion opens with an
    // unterminated line (a heading, a bullet list): dropping the subject
    // would promote that whole block into `claim.subject` via buildClaims'
    // identical split, and subjects print in one-line list contexts.
    if (firstSentence.includes("\n")) {
        return false;
    }
    const sentenceTokens = new Set(proseTokens(firstSentence).map(foldToken));
    return subjectTokens.every((token) => sentenceTokens.has(token));
};

/**
 * Join the label contract's `subject` and `discussion` into one prose block.
 * A subject with no terminal punctuation gets a sentence break, not a bare
 * space (run 29897276810 posted "...memory Both TestExpiration..."); the
 * break also keeps `buildClaims`' first-sentence split recovering the
 * subject.
 *
 * A subject that restates the discussion's opening sentence
 * ({@link subjectRestatesDiscussion}) is dropped instead of joined: the
 * posted body then opens with the discussion's own first claim, and
 * `buildClaims`' first-sentence split recovers that as the subject, so no
 * downstream field goes empty; the body loses the duplicate sentence.
 */
export const joinProse = (subject: string, discussion: string): string => {
    if (discussion === "") {
        return subject.trim();
    }
    if (subject === "" || subjectRestatesDiscussion(subject, discussion)) {
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
        // the discussion prose. A subject joinProse drops (restatement)
        // salvages from the discussion too: dedup's comparedText reads the
        // discussion only when failure_scenario prefix-matches
        // claim.subject (dedup.ts), and after the drop claim.subject is
        // the discussion's first sentence, which prefix-matches the
        // discussion itself but not an inflected or reordered dropped
        // subject; salvaging that subject would compare the claim on one
        // sentence plus its own restatement, the exact shape run
        // 30301235749 failed to merge.
        failure_scenario:
            raw["failure_scenario"] ??
            (subject !== "" && !subjectRestatesDiscussion(subject, discussion)
                ? subject
                : discussion),
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
 * The `lens` each label-shape reviewer's findings carry. `lens` is
 * code-assigned and never read from model output, and it is not merely
 * descriptive: `labelForFinding` derives the rendered Conventional-Comment
 * label from `severity` + `lens`, so this map is what makes a `documentation`
 * finding post as `suggestion (non-blocking, documentation)` — the only
 * channel by which a downstream consumer (autofix, which parses the label off
 * the posted comment) can tell a documentation thread from any other
 * non-blocking one. A reviewer absent from this map is correctness-shaped.
 */
const LABEL_SHAPE_LENS: Record<string, Lens> = {
    "skill-auditor": "conventions",
    documentation: "documentation",
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
                LABEL_SHAPE_LENS[agentName] ?? "correctness",
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
/* Defect clustering (the claim-clusterer contract)                           */
/* -------------------------------------------------------------------------- */

/**
 * One group of candidate claims the `claim-clusterer` says describe ONE
 * defect, plus the `evidence` it grounded the identity in: the code element,
 * literal, or quoted text every member refers to.
 *
 * `evidence` is not documentation. It is the load-bearing half of the
 * contract, because `dedup.ts` verifies the model's identity claim rather than
 * trusting it: a cluster whose evidence names no code element at all is
 * rejected outright, and a member whose own text never mentions that element
 * is dropped from the group (see `verifiableClusters` there). A model asked
 * for a grounded assertion is checkable; one asked only for a grouping is not.
 */
export type ProposedCluster = {evidence: string; ids: string[]};

/**
 * Parse the clusterer's output, per its contract (review.md):
 * `{"clusters": [{"evidence": "...", "ids": ["...", "..."]}]}`. Malformed
 * entries are skipped rather than thrown on — every skipped entry simply
 * merges nothing, which is the safe direction (a missed merge costs a
 * duplicate comment; a bad one drops a reviewer's distinct finding). A
 * missing `clusters` array IS thrown on, so the one corrective re-dispatch
 * fires: silently reading a drifted shape as "no duplicates" is how a paid-for
 * dimension goes missing without a trace.
 */
export const parseClustererOutput = (output: string): ProposedCluster[] => {
    const parsed = parseJsonObject(output);
    const raw = parsed["clusters"];
    if (!Array.isArray(raw)) {
        throw new Error("clusterer output has no clusters array");
    }
    return raw.flatMap((entry): ProposedCluster[] => {
        if (!isRecord(entry) || typeof entry["evidence"] !== "string") {
            return [];
        }
        const ids = entry["ids"];
        if (!Array.isArray(ids)) {
            return [];
        }
        const strings = [
            ...new Set(
                ids.filter((id): id is string => typeof id === "string"),
            ),
        ];
        return strings.length < 2
            ? []
            : [{evidence: entry["evidence"], ids: strings}];
    });
};

/* -------------------------------------------------------------------------- */
/* Structured-final contract checks                                           */
/* -------------------------------------------------------------------------- */

export type ContractKind =
    | "finder"
    | "lens"
    | "validator"
    | "clusterer"
    | "json";

/**
 * Build the structured-final contract check for one sub-agent: the exact
 * parse the collection phase will run, applied at the `submit_result` tool
 * boundary so a drifted shape is rejected back to the model in-session
 * instead of voiding the dimension after the run. Free-text finals stay the
 * fallback, so this never *loses* an output the old path would have kept.
 *
 * Why: three distinct correctness-reviewer shape drifts in five trial runs
 * (the defect-13 ledger line), each costing a corrective re-dispatch or the
 * whole dimension; free-text JSON contracts were the weakest link in the
 * scripted pipeline. `json` accepts any object (pattern-triage and the
 * reconciler already tolerate missing fields downstream, failing toward
 * more review / fewer resolutions).
 *
 * Side-effect-free: the finder parse runs against a throwaway id set, so
 * validation here never perturbs the collection phase's cross-agent id
 * collision handling.
 */
export const contractValidator = (
    name: string,
    kind: ContractKind,
): ((payload: Record<string, unknown>) => string | null) => {
    return (payload) => {
        try {
            const text = JSON.stringify(payload);
            if (kind === "validator") {
                parseValidatorOutput(text);
            } else if (kind === "clusterer") {
                parseClustererOutput(text);
            } else if (kind === "finder" || kind === "lens") {
                parseFinderOutput(name, text, new Set(), kind === "lens");
            }
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
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
    /**
     * The cross-source duplicate copies dedup folded into this claim (one
     * entry per other source; see dedup.ts). Structured rather than appended
     * to `discussion` so a validator `corrected.discussion` rewrite cannot
     * silently drop the record; the posting surface (submission.ts) renders
     * it into the comment's collapsed attribution footer (attribution.ts).
     */
    also_flagged_by?: AlsoFlagged[];
};

export const buildClaims = (candidates: Candidate[]): Claim[] =>
    candidates.map((candidate) => {
        const {finding} = candidate;
        const {path, line} = anchorPathLine(finding.anchor);
        const prose = finding.model_authored_prose;
        const firstSentence = prose.split(FIRST_SENTENCE_SPLIT, 1)[0] ?? prose;
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
            // Validate per key, not with one string-or-number check for all
            // of them: `fromLabelShape` already gates label drift on the
            // FINDER side, and leaving it ungated here is the same defect
            // one step later. A confirmed blocking claim whose `corrected.
            // label` drifts out of vocabulary (a truncated "issue") fails
            // `isBlockingLabel` and silently drops out of the
            // REQUEST_CHANGES verdict; a string in `line` lands a
            // non-numeric anchor. A rejected correction keeps the original
            // field, which is the safe direction: the claim still posts as
            // the finder wrote it.
            for (const key of [
                "line",
                "label",
                "subject",
                "discussion",
                "suggestion",
            ] as const) {
                const value = corrected[key];
                if (value === undefined) {
                    continue;
                }
                if (key === "line") {
                    if (
                        typeof value === "number" &&
                        Number.isInteger(value) &&
                        value > 0
                    ) {
                        updated = {...updated, line: value};
                    }
                    continue;
                }
                if (typeof value !== "string" || value.trim() === "") {
                    continue;
                }
                if (key === "label" && !KNOWN_LABELS.has(value)) {
                    continue;
                }
                updated = {...updated, [key]: value};
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
