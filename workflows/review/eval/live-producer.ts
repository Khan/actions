/**
 * The live finding producer (`live-ab-plan.md` Phase 2c): run the REAL model
 * sub-agents from a `review.md` over one live-enabled corpus case and return
 * findings + claim-validator verifications in exactly the shapes the
 * deterministic runner consumes (`RunOptions.produceFindings` +
 * `applyValidation`). Every downstream stage (provenance gate, scope filter,
 * verdict, rendering, metrics) is then identical between a recorded replay
 * and a live arm.
 *
 * The model seam is an injected {@link LiveAgentRunner} (mirroring how
 * `judge.ts` takes a `JudgeModel`): this module performs no model or network
 * call itself, so its logic is unit-testable with a stub. The one production
 * implementation (Agent SDK) lives in `live-runner.ts`.
 *
 * Deliberate deviations from production, documented here once:
 *  - No `pattern-triage` pass and no `thread-reconciler` (no threads exist in
 *    eval); the roster is the two default whole-change reviewers plus the
 *    router's `lensesToSpawn`.
 *  - `{{#runtime-import <path>}}` directives are compile-time inlines of
 *    consumer-repo files. Here they resolve against the case's checkout tree
 *    when the file exists there, so a case can opt into a skills index or a
 *    lens payload by carrying the file in its tree. A missing optional
 *    import (`{{#runtime-import? …}}`) resolves to empty exactly as in
 *    production; a missing required one resolves to a fixed "not
 *    configured" note where production would fail the run.
 *  - The investigation-cap CLI the prompts invoke is not staged; sub-agents
 *    run with read-only tools and treat the unavailable cap as a denied
 *    budget (the prompt's own fallback: stop investigating, report what you
 *    have).
 *
 * Cross-source dedup is NOT on that list any more, and its absence used to be
 * the load-bearing one: production has merged duplicate claims before validation
 * since #245, this module never did, so every duplicate production suppressed
 * still posted here and no report column could see a change to the merge rules.
 * {@link dedupeLiveFindings} closes that, arm-keyed on the clusterer agent.
 */

import {refusalFallbackFor} from "../lib/refusal-fallback";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";

import {isBlockingLabel, labelForFinding} from "../lib/render-comment";
import {route, type RouterConfig} from "../lib/router";
import {validateFinding, type Finding, type Lens} from "../lib/finding-schema";
import {
    dedupeClaims,
    type ClaimMerge,
    type ClusterRejection,
} from "../lib/dedup";
import {
    buildClaims as buildLibClaims,
    parseClustererOutput,
    type Candidate,
    type ProposedCluster,
} from "../lib/dispatch-contracts";
import {hasClusterableCandidatePair} from "../lib/dispatch-cluster";
import {
    VERIFICATION_STATES,
    type CaseVerification,
    type CorpusCase,
    type RecordedFinding,
    type VerificationState,
} from "./corpus/loader";
import type {ExtractedAgent} from "./agent-extract";
import {
    ENABLEABLE_REVIEWERS,
    type EnableableReviewer,
    type ReReviewMode,
} from "../lib/routing-config";
import {extractJsonObject} from "./extract-json";
import {
    rewriteAgentPrompt,
    stageCase,
    type StageFs,
    type StagedCase,
} from "./live-stage";

/* -------------------------------------------------------------------------- */
/* The model seam                                                             */
/* -------------------------------------------------------------------------- */

/** One sub-agent dispatch request. */
export type LiveAgentRequest = {
    /** Agent name (for labeling/telemetry). */
    name: string;
    /** Pinned model id from the agent's frontmatter. */
    model: string;
    /** The fully-resolved prompt (imports inlined, staging paths rewritten). */
    prompt: string;
    /** The staged checkout the agent investigates (its cwd). */
    cwd: string;
    /** Hard turn cap. */
    maxTurns: number;
    /** Hard wall-clock cap, enforced by the runner. */
    timeoutMs: number;
};

/** What a dispatch returned, with its measured cost. */
export type LiveAgentResult = {
    /** The agent's final text (expected to be the JSON contract). */
    output: string;
    /** Billed cost in USD (0 when the runner cannot price it). */
    usd: number;
    /** Turns consumed. */
    turns: number;
    /** Wall-clock milliseconds. */
    wallMs: number;
    /**
     * Tool calls the agent made. The harness-parity signal: a loop that
     * investigates with half the tool calls and scores lower has a toolbox
     * problem, not a model problem. Optional because a runner that cannot
     * count them reports nothing rather than a misleading zero.
     */
    toolCalls?: number;
    /** Provider stop reason for the last assistant message, when visible. */
    stopReason?: string;
    /** Why the call failed, when the runner can see it. */
    errorMessage?: string;
    /** The provider's own stop reason, before normalization. */
    rawStopReason?: string;
    /** Input and total tokens on the last assistant message. */
    tokensAtFailure?: {input: number; total: number};
    /** The provider blocked the request under its usage policy. */
    refused?: boolean;
};

/** The injected model runner; the ONLY place a real model is invoked. */
export type LiveAgentRunner = (
    request: LiveAgentRequest,
) => Promise<LiveAgentResult>;

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** Per-agent accounting for the cost report. */
export type PerAgentReport = {
    name: string;
    model: string;
    usd: number;
    turns: number;
    wallMs: number;
    /** Whether the malformed-output retry fired. */
    retried: boolean;
    /** Tool calls across every attempt; see `LiveAgentResult.toolCalls`. */
    toolCalls?: number;
    /** Stop reason of the last attempt; set alongside `failed`. */
    stopReason?: string;
    /**
     * The pinned model refused and the dispatch fell back to this one. Never
     * silent: a fallback that nobody can see trades an invisible skip for an
     * invisible model swap.
     */
    fellBackTo?: string;
    /** Fixed-format failure note; the agent contributed nothing when set. */
    failed?: string;
    /**
     * The raw final text of the LAST attempt, captured ONLY when the agent
     * failed, and truncated. Exists because the failure note alone
     * ("no parseable JSON object") cannot distinguish a prose answer from a
     * refusal from a truncated contract, so diagnosing one cost a whole eval
     * run per hypothesis. Runs 30592964392 and 30596474354 each burned ~$10
     * establishing nothing more than that the same two cases fail.
     */
    rawOutput?: string;
    /**
     * This arm's `review.md` does not define the reviewer, so it was never
     * dispatched. Not a failure: it is the shape of a new-reviewer A/B, where
     * the baseline arm cannot have the reviewer the candidate arm adds. Kept
     * distinct from `failed` so the report can say which it was.
     */
    absent?: boolean;
};

/** The thread-reconciler's parsed decision over the staged prior threads. */
export type LiveReconciliation = {
    /** Thread ids to resolve (the staged synthetic `t-<key>` ids). */
    resolve: string[];
    /** Thread ids to keep open. */
    keep: string[];
};

export type ProduceLiveResult = {
    /** Schema-valid findings, in the corpus `RecordedFinding` shape. */
    findings: RecordedFinding[];
    /** Claim-validator verifications, in the corpus `validation` shape. */
    validation: CaseVerification[];
    perAgent: PerAgentReport[];
    staged: StagedCase;
    /**
     * The reconciler's decision, present iff the case carries a
     * `live.rereview` block and the reconciler dispatch produced parseable
     * output (a failed reconciler is reported in `perAgent` and leaves this
     * absent — the scorer then counts every prior thread unaccounted).
     */
    reconciliation?: LiveReconciliation;
    /**
     * What the cross-source merge did this run: the pre-merge candidate count,
     * the merged groups, and the clusterer's proposal/rejection counts. The
     * report reads its duplicate numbers from HERE rather than from the posted
     * set, for the same reason production reads them from
     * `dispatch-result.json`: downstream stages (and, in production, autofix)
     * hide duplicate comments after the fact.
     */
    dedup: LiveDedupReport;
};

export type ProduceLiveOptions = {
    runner: LiveAgentRunner;
    /** Directory to stage the case under (one case per directory). */
    stageDir: string;
    fs?: StageFs;
    maxTurns?: number;
    timeoutMs?: number;
    /** Concurrent sub-agent dispatches within the case. */
    concurrency?: number;
    /**
     * Re-review mode for cases carrying a `live.rereview` block (the ROUTING
     * `re-review` line in production; an arm parameter here so the A/B can
     * price a mode). The staged depth plan sizes the roster: `scoped` keeps
     * the full roster over the scoped diff, `flip-gated` keeps only the
     * correctness pass, `fast` dispatches the reconciler alone. Default
     * `full`.
     */
    reReviewMode?: ReReviewMode;
};

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;

/** The real filesystem, in the staging seam's shape (mirrors live-stage). */
const NODE_FS: StageFs = {
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

/** Production's confidence default for label-shape reviewers (review.md). */
const LABEL_SHAPE_CONFIDENCE = 0.7;

/** The always-on finders (pattern-triage and thread-reconciler excluded). */
const DEFAULT_FINDERS = ["correctness-reviewer", "skill-auditor"] as const;

/**
 * The opt-in whole-change reviewers a case turns on, read from its
 * `routerConfig.enabledReviewers` (the case-level stand-in for the consumer
 * `ROUTING` file's `enable` lines, which the router threads in separately from
 * {@link RouterConfig}).
 *
 * Production dispatches these alongside the defaults; the live producer did
 * not, so an opt-in reviewer had no live arm at all and could not earn its
 * `enable` line the way the repo's policy says it must. Cases that name none
 * (every case before this existed) are unaffected: the roster is the defaults
 * plus routed lenses, exactly as before.
 *
 * An unrecognised name throws rather than being skipped. A typo here would
 * otherwise produce a full, green, expensive run that silently measured
 * nothing about the reviewer the case exists to measure.
 */
const enabledReviewersOf = (corpusCase: CorpusCase): EnableableReviewer[] => {
    const raw = corpusCase.routerConfig?.["enabledReviewers"];
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw) || !raw.every((n) => typeof n === "string")) {
        throw new Error(
            `case "${corpusCase.id}": routerConfig.enabledReviewers must be an array of strings`,
        );
    }
    const known: ReadonlySet<string> = new Set(ENABLEABLE_REVIEWERS);
    const unknown = raw.filter((name) => !known.has(name));
    if (unknown.length > 0) {
        throw new Error(
            `case "${corpusCase.id}": unknown enabledReviewers ${unknown.join(
                ", ",
            )}; known: ${ENABLEABLE_REVIEWERS.join(", ")}`,
        );
    }
    // Canonical order, deduplicated: the roster (and so the report) must not
    // depend on the order a case happened to list them in.
    return ENABLEABLE_REVIEWERS.filter((name) => raw.includes(name));
};

const VALIDATOR = "claim-validator";

const RECONCILER = "thread-reconciler";

/** Parse the reconciler's `{resolve, keep}` output (thread-id arrays). */
const parseReconciliation = (output: string): LiveReconciliation => {
    const parsed = extractJsonObject(output);
    const ids = (value: unknown, key: string): string[] => {
        if (
            !Array.isArray(value) ||
            !value.every((v) => typeof v === "string")
        ) {
            throw new Error(`${key} is not a string array`);
        }
        return value;
    };
    return {
        resolve: ids(parsed["resolve"], "resolve"),
        keep: ids(parsed["keep"], "keep"),
    };
};

/* -------------------------------------------------------------------------- */
/* Prompt resolution                                                          */
/* -------------------------------------------------------------------------- */

const RUNTIME_IMPORT = /\{\{#runtime-import(\?)?\s+([^}\s]+)\s*\}\}/g;

const IMPORT_FALLBACK = "(not configured for this eval case)";

/**
 * Inline `{{#runtime-import <path>}}` directives from the case's checkout
 * tree. A missing OPTIONAL import (`{{#runtime-import? …}}`) resolves to the
 * empty string, matching production (gh-aw's runtime_import.cjs warns and
 * inlines nothing), so an absent lens payload is behavior-identical to
 * production. A missing REQUIRED import falls back to a fixed note; this is
 * the one deliberate deviation (production fails the run), so cases need not
 * carry every consumer config file. Exported for the A/B runner's reporting
 * (which imports resolved per case).
 */
export const resolveRuntimeImports = (
    prompt: string,
    checkoutDir: string,
    fs: Pick<StageFs, "existsSync" | "readFileSync">,
): string =>
    prompt.replace(
        RUNTIME_IMPORT,
        (_match, optional: string | undefined, importPath: string) => {
            const full = `${checkoutDir}/${importPath}`;
            if (fs.existsSync(full)) {
                return fs.readFileSync(full, "utf8");
            }
            return optional ? "" : IMPORT_FALLBACK;
        },
    );

/* -------------------------------------------------------------------------- */
/* Output parsing: the three sub-agent contracts -> RecordedFinding           */
/* -------------------------------------------------------------------------- */

/** A produced finding plus the claims-path extras the validator reads. */
type LiveFinding = RecordedFinding & {skill?: string};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Map one label-shape finding (correctness-reviewer / skill-auditor contract)
 * into a schema finding. The lens is code-assigned: `correctness` for the
 * correctness reviewer, `conventions` for the skill auditor (the one
 * best-practice lens, so `labelForFinding` reproduces the `, best-practice`
 * label variants the auditor emits).
 */
const fromLabelShape = (
    agentName: string,
    lens: Lens,
    source: string,
    raw: unknown,
    index: number,
): LiveFinding => {
    if (!isRecord(raw)) {
        throw new Error(`findings[${index}] is not an object`);
    }
    const label = typeof raw["label"] === "string" ? raw["label"] : "";
    const subject = typeof raw["subject"] === "string" ? raw["subject"] : "";
    const discussion =
        typeof raw["discussion"] === "string" ? raw["discussion"] : "";
    const candidate: Record<string, unknown> = {
        schema_version: 2,
        id: `live-${agentName}-${index + 1}`,
        lens,
        anchor: {
            type: "line",
            path: raw["path"],
            line: raw["line"],
            side: "RIGHT",
        },
        severity: isBlockingLabel(label) ? "blocking" : "advisory",
        confidence: LABEL_SHAPE_CONFIDENCE,
        evidence_trace: [
            `${agentName} label: ${label}`,
            ...(discussion === "" ? [] : [discussion]),
        ],
        failure_scenario: raw["failure_scenario"],
        producing_hunt: `live:${agentName}`,
        model_authored_prose:
            discussion === "" ? subject : `${subject} ${discussion}`.trim(),
        ...(typeof raw["suggestion"] === "string" && raw["suggestion"] !== ""
            ? {suggested_patch: raw["suggestion"]}
            : {}),
    };
    const result = validateFinding(candidate);
    if (!result.ok) {
        throw new Error(`findings[${index}]: ${result.errors.join("; ")}`);
    }
    return {
        source,
        finding: result.finding,
        ...(typeof raw["skill"] === "string" && raw["skill"] !== ""
            ? {skill: raw["skill"]}
            : {}),
    };
};

/**
 * Parse one agent's output into live findings, per its contract. Every id is
 * namespaced with the case id (`<caseId>:<id>`): live agents choose their own
 * ids, so without the namespace two cases produce colliding ids (every case's
 * first correctness finding would be `live-correctness-reviewer-1`), and the
 * judge's score join requires ids unique across the whole arm.
 */
const parseAgentFindings = (
    agent: ExtractedAgent,
    output: string,
    usedIds: Set<string>,
    caseId: string,
): LiveFinding[] => {
    const parsed = extractJsonObject(output);
    const rawFindings = parsed["findings"];
    if (!Array.isArray(rawFindings)) {
        throw new Error("output JSON has no findings array");
    }

    // Every reviewer that emits the label-bearing shape rather than the
    // structured finding schema: the two defaults, plus the opt-in
    // whole-change reviewers (reachable since a case may `enable` them). A
    // name missing here falls through to the specialist-lens branch and
    // throws on the first finding, so keep this in step with
    // ENABLEABLE_REVIEWERS.
    const labelLens: Record<string, {lens: Lens; source: string}> = {
        "correctness-reviewer": {lens: "correctness", source: "correctness"},
        "skill-auditor": {lens: "conventions", source: "skill"},
        holistic: {lens: "holistic", source: "holistic"},
        completeness: {lens: "completeness", source: "completeness"},
        "test-adequacy": {lens: "test-adequacy", source: "test-adequacy"},
        "first-principles": {
            lens: "first-principles",
            source: "first-principles",
        },
        conventions: {lens: "conventions", source: "conventions"},
        documentation: {lens: "documentation", source: "documentation"},
    };

    const findings = rawFindings.map((raw, index): LiveFinding => {
        const label = labelLens[agent.name];
        if (label !== undefined) {
            return fromLabelShape(
                agent.name,
                label.lens,
                label.source,
                raw,
                index,
            );
        }
        // Specialist lens: already the structured finding schema.
        const result = validateFinding(raw);
        if (!result.ok) {
            throw new Error(`findings[${index}]: ${result.errors.join("; ")}`);
        }
        return {source: agent.name, finding: result.finding};
    });

    // Namespace with the case id (see the function doc), then dedupe within
    // the case: prefix a collision with the producing agent's name rather
    // than dropping a real finding.
    for (const live of findings) {
        live.finding = {...live.finding, id: `${caseId}:${live.finding.id}`};
        if (usedIds.has(live.finding.id)) {
            live.finding = {
                ...live.finding,
                id: `${agent.name}:${live.finding.id}`,
            };
        }
        usedIds.add(live.finding.id);
    }
    return findings;
};

/* -------------------------------------------------------------------------- */
/* Cross-source dedup (production's pre-validation merge)                     */
/* -------------------------------------------------------------------------- */

const CLUSTERER = "claim-clusterer";

/** What an arm's dedup stage did, for the A/B report. */
export type LiveDedupReport = {
    /** Claims entering the merge (the pre-merge candidate count). */
    candidates: number;
    /** Merged groups, as `dispatch-result.json` records them. */
    merges: ClaimMerge[];
    /** Well-formed clusters the clusterer proposed (0 when it did not run). */
    proposed: number;
    /** Proposed members the merge rules rejected. */
    rejected: ClusterRejection[];
    /** The arm's review.md defines no clusterer: tier 1 only, by construction. */
    clustererAbsent: boolean;
};

/**
 * Run production's cross-source merge over an arm's live findings.
 *
 * Why this exists at all: the A/B never ran dedup, so a change to it was
 * unmeasurable by construction — the pipeline the eval measured posted every
 * duplicate that production merges, and no report column moved when the merge
 * rules changed. Both arms run tier 1 (it is shared code, and production has
 * had it since #245); tier 2 is carried by the arm's OWN review.md, exactly
 * like the provenance gate's anchor-snap emulation, so a baseline built from a
 * ref that predates the `claim-clusterer` agent runs tier 1 alone and the arm
 * delta prices the clusterer and nothing else.
 *
 * The claim projection is the LIB's `buildClaims`, not this module's
 * validator-contract one: the merge compares `subject` against
 * `failure_scenario` (falling back to `discussion`), and the eval's own
 * projection puts the whole prose in `subject` and the evidence trace in
 * `discussion`. Feeding that shape to the floors would measure a similarity
 * arithmetic production never runs.
 *
 * What is shared with production and what is not, since fidelity is the whole
 * point: the merge rules (`dedupeClaims`) and the dispatch precondition
 * (`hasClusterableCandidatePair`) are the SAME code `runClusterStep` runs. What
 * this function re-implements is the plumbing that step cannot lend: the
 * dispatch goes through the eval's own agent runner and per-agent cost report,
 * and the survivor's merged prose is written back onto a `LiveFinding` rather
 * than onto a staged claims.json. That is the seam to keep in step by hand
 * (the provenance gate's anchor-snap emulation has the same shape); a rule
 * change does not need mirroring here, a change to WHEN the step runs does.
 */
const dedupeLiveFindings = async (
    findings: LiveFinding[],
    clusterer: ExtractedAgent | undefined,
    io: {
        dispatch: (
            agent: ExtractedAgent,
            parse: (output: string) => ProposedCluster[],
        ) => Promise<{
            report: PerAgentReport;
            parsed?: ProposedCluster[];
        }>;
        write: (name: string, content: string) => void;
    },
): Promise<{
    kept: LiveFinding[];
    dedup: {report?: PerAgentReport; result: LiveDedupReport};
}> => {
    const claims = buildLibClaims(findings as Candidate[]);
    const clusterable = hasClusterableCandidatePair(claims);
    let proposals: ProposedCluster[] = [];
    let report: PerAgentReport | undefined;
    if (clusterable && clusterer !== undefined) {
        io.write("candidates.json", JSON.stringify(claims, null, 2));
        const dispatched = await io.dispatch(clusterer, parseClustererOutput);
        report = dispatched.report;
        proposals = dispatched.parsed ?? [];
    }
    const merged = dedupeClaims(claims, proposals);
    const dropped = new Set(
        merged.merges.flatMap((merge) => merge.merged.map((m) => m.id)),
    );
    const survivors = new Map(
        merged.claims.map((claim) => [claim.id, claim] as const),
    );
    const kept = findings
        .filter((live) => !dropped.has(live.finding.id))
        .map((live) => {
            const survivor = survivors.get(live.finding.id);
            if (
                survivor === undefined ||
                !merged.merges.some(
                    (merge) => merge.survivor === live.finding.id,
                )
            ) {
                return live;
            }
            // The survivor's claim carries the "also flagged by" note (the lib
            // projection puts the prose in `discussion`) and may have adopted a
            // merged copy's suggestion; both must reach the rendered comment.
            return {
                ...live,
                finding: {
                    ...live.finding,
                    model_authored_prose: survivor.discussion,
                    ...(survivor.suggestion !== undefined
                        ? {suggested_patch: survivor.suggestion}
                        : {}),
                },
            };
        });
    return {
        kept,
        dedup: {
            ...(report !== undefined ? {report} : {}),
            result: {
                candidates: claims.length,
                merges: merged.merges,
                proposed: proposals.length,
                rejected: merged.clusterRejections,
                clustererAbsent: clusterer === undefined,
            },
        },
    };
};

/* -------------------------------------------------------------------------- */
/* The claims path                                                            */
/* -------------------------------------------------------------------------- */

/** Build the claims.json entries the validator's contract names. */
const buildClaims = (findings: LiveFinding[]): Record<string, unknown>[] =>
    findings.map((live) => {
        const {finding} = live;
        return {
            id: finding.id,
            source: live.source,
            ...(finding.anchor.type !== "pr"
                ? {path: finding.anchor.path}
                : {}),
            ...(finding.anchor.type === "line"
                ? {line: finding.anchor.line}
                : {}),
            label: labelForFinding(finding),
            subject: finding.model_authored_prose,
            discussion: finding.evidence_trace.join(" | "),
            failure_scenario: finding.failure_scenario,
            confidence: finding.confidence,
            ...(finding.suggested_patch !== undefined
                ? {suggestion: finding.suggested_patch}
                : {}),
            ...(live.skill !== undefined ? {skill: live.skill} : {}),
        };
    });

/** Parse the validator's `{"claims": [...]}` output into verifications. */
const parseVerifications = (
    output: string,
    knownIds: Set<string>,
): CaseVerification[] => {
    const parsed = extractJsonObject(output);
    const rawClaims = parsed["claims"];
    if (!Array.isArray(rawClaims)) {
        throw new Error("validator output has no claims array");
    }
    const verifications: CaseVerification[] = [];
    rawClaims.forEach((raw, index) => {
        if (!isRecord(raw)) {
            throw new Error(`claims[${index}] is not an object`);
        }
        const id = raw["id"];
        const verification = raw["verification"];
        if (typeof id !== "string" || !knownIds.has(id)) {
            throw new Error(
                `claims[${index}].id does not match a produced finding`,
            );
        }
        if (
            typeof verification !== "string" ||
            !VERIFICATION_STATES.includes(verification as VerificationState)
        ) {
            throw new Error(`claims[${index}].verification is invalid`);
        }
        const out: CaseVerification = {
            id,
            verification: verification as VerificationState,
        };
        const confidence = raw["confidence"];
        if (
            typeof confidence === "number" &&
            confidence >= 0 &&
            confidence <= 1
        ) {
            out.confidence = confidence;
        }
        verifications.push(out);
    });
    return verifications;
};

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** A bounded-concurrency map that preserves input order in its results. */
const mapWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> => {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from(
        {length: Math.min(limit, items.length)},
        async () => {
            for (;;) {
                const index = next++;
                if (index >= items.length) {
                    return;
                }
                results[index] = await fn(items[index] as T);
            }
        },
    );
    await Promise.all(workers);
    return results;
};

/**
 * Dispatch one agent with the malformed-output retry: a first failure is fed
 * back verbatim and the agent gets exactly one more attempt; a second failure
 * marks the agent failed and the run continues without it.
 */
/**
 * How much of a failing agent's raw final text the report keeps. Enough to
 * see whether the model answered in prose, refused, or emitted a truncated
 * contract; short enough that a nine-case report stays readable.
 */
const RAW_OUTPUT_CAP = 4000;

export const capRawOutput = (text: string): string =>
    text.length <= RAW_OUTPUT_CAP
        ? text
        : `${text.slice(0, RAW_OUTPUT_CAP)}\n[truncated: ${
              text.length - RAW_OUTPUT_CAP
          } more characters]`;

const dispatchWithRetry = async <R>(
    agent: ExtractedAgent,
    prompt: string,
    request: Omit<LiveAgentRequest, "prompt">,
    runner: LiveAgentRunner,
    parse: (output: string) => R,
): Promise<{report: PerAgentReport; parsed?: R}> => {
    const report: PerAgentReport = {
        name: agent.name,
        model: agent.model,
        usd: 0,
        turns: 0,
        wallMs: 0,
        retried: false,
    };
    let attemptPrompt = prompt;
    let lastOutput: string | undefined;
    let failureDetail = "";
    // The model this attempt runs on. A refusal is deterministic in the model,
    // so the fallback swaps the pin rather than retrying it (see
    // lib/refusal-fallback.ts); every other failure keeps the pin and retries.
    let model = request.model;
    const tried: string[] = [model];
    for (let attempt = 0; attempt < 2; attempt++) {
        let failure: string;
        try {
            const result = await runner({
                ...request,
                model,
                prompt: attemptPrompt,
            });
            report.usd += result.usd;
            report.turns += result.turns;
            report.wallMs += result.wallMs;
            if (result.toolCalls !== undefined) {
                report.toolCalls = (report.toolCalls ?? 0) + result.toolCalls;
            }
            lastOutput = result.output;
            report.stopReason = result.stopReason;
            failureDetail = [
                result.rawStopReason === undefined
                    ? undefined
                    : `rawStopReason=${result.rawStopReason}`,
                result.tokensAtFailure === undefined
                    ? undefined
                    : `tokens=${result.tokensAtFailure.input}in/${result.tokensAtFailure.total}total`,
                result.errorMessage === undefined
                    ? undefined
                    : `error=${result.errorMessage}`,
            ]
                .filter((part) => part !== undefined)
                .join(" ");
            try {
                return {report, parsed: parse(result.output)};
            } catch (parseError) {
                // An EMPTY final is not malformed output, and conflating the
                // two hid the real signature for three eval runs: the agent
                // returned nothing at all, which on cyber-adjacent input is
                // how a refusal presents (#294: "a missing agent result, not
                // an error"). Say which one happened, and carry the stop
                // reason that distinguishes a refusal from a dropped result.
                failure =
                    result.output.trim() === ""
                        ? `empty output: the agent returned no final text${
                              result.stopReason === undefined
                                  ? ""
                                  : ` (stopReason=${result.stopReason})`
                          }${failureDetail === "" ? "" : ` ${failureDetail}`}`
                        : `malformed output: ${String(
                              parseError instanceof Error
                                  ? parseError.message
                                  : parseError,
                          )}`;
            }
            if (result.refused === true) {
                // The contract-parse retry cannot recover a refusal: it
                // corrects output shape, and a blocked request never produced
                // one. Keep the ORIGINAL prompt: the
                // rejection note is about output shape, and this failure was
                // not the model's output.
                // Only on a non-final attempt: `continue` from the last
                // iteration exits the loop, so recording a fallback there
                // would claim a dispatch that never happens.
                const fallback =
                    attempt === 0
                        ? refusalFallbackFor(model, tried)
                        : undefined;
                if (fallback !== undefined) {
                    model = fallback;
                    tried.push(fallback);
                    report.fellBackTo = fallback;
                    attemptPrompt = prompt;
                    report.retried = true;
                    continue;
                }
            }
            attemptPrompt =
                `${prompt}\n\n` +
                `Your previous output was rejected: ${failure}\n` +
                `Return ONLY the corrected JSON object.`;
        } catch (runError) {
            failure = `dispatch failed: ${String(
                runError instanceof Error ? runError.message : runError,
            )}`;
        }
        if (attempt === 0) {
            report.retried = true;
        } else {
            report.failed = failure;
            if (lastOutput !== undefined) {
                report.rawOutput = capRawOutput(lastOutput);
            }
        }
    }
    return {report};
};

/* -------------------------------------------------------------------------- */
/* The producer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Run the live sub-agent roster over one live-enabled corpus case: stage it,
 * dispatch the default finders plus the routed lenses, parse and
 * schema-validate their findings, then dispatch the claim-validator over the
 * assembled claims. Partial results are kept: a failed agent is reported in
 * `perAgent` and contributes nothing; a failed validator yields an empty
 * `validation` list (the deterministic replay then posts unvalidated
 * candidates, exactly production's fallback).
 */
export const produceLive = async (
    corpusCase: CorpusCase,
    agents: Map<string, ExtractedAgent>,
    options: ProduceLiveOptions,
): Promise<ProduceLiveResult> => {
    const {runner} = options;
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    const fs = options.fs ?? NODE_FS;
    const staged = stageCase(corpusCase, options.stageDir, fs, {
        reReviewMode: options.reReviewMode ?? "full",
    });

    // Roster: default finders + the case's enabled opt-in reviewers + routed
    // specialist lenses — sized by the re-review depth plan when the case is
    // an open-PR snapshot. `scoped` keeps the full roster (over the scoped
    // diff the staging already wrote); `flip-gated` keeps only the correctness
    // pass; `fast` keeps none.
    const routerConfig: RouterConfig = {
        generatedPatterns: [],
        ...(corpusCase.routerConfig as Partial<RouterConfig>),
    };
    const routing = route({files: corpusCase.changedFiles}, routerConfig);
    const dispatch = staged.rereviewPlan?.dispatch ?? "all";
    const enabled = enabledReviewersOf(corpusCase);
    const rosterNames =
        dispatch === "all"
            ? [...DEFAULT_FINDERS, ...enabled, ...routing.lensesToSpawn]
            : dispatch === "reconcile+correctness"
            ? ["correctness-reviewer"]
            : [];

    /**
     * An enabled opt-in reviewer this arm's `review.md` does not define is an
     * **asymmetric arm**, not a broken one, and it is the normal shape of the
     * A/B that graduates a new reviewer: the baseline arm is built from the
     * base tip, which by construction predates the reviewer the candidate arm
     * adds. Throwing here killed the whole A/B run before any report, since
     * `runArm` does not wrap its `produce` call.
     *
     * Tolerating absence cannot mask a typo, which is the failure mode the
     * `enabledReviewers` validation exists to prevent: the name is already
     * checked against `ENABLEABLE_REVIEWERS`, so absence can only mean this
     * arm predates the reviewer. Every other roster member stays a hard
     * error: the default finders are always-on, and a routed lens name is not
     * validated anywhere, so its absence really may be a mistake.
     */
    const absent: string[] = [];
    const roster = rosterNames.flatMap((name) => {
        const agent = agents.get(name);
        if (agent === undefined) {
            if ((enabled as readonly string[]).includes(name)) {
                absent.push(name);
                return [];
            }
            throw new Error(
                `sub-agent "${name}" is not defined in the extracted review.md`,
            );
        }
        return [agent];
    });

    const resolvePrompt = (agent: ExtractedAgent): string =>
        rewriteAgentPrompt(
            resolveRuntimeImports(agent.prompt, staged.checkoutDir, fs),
            staged,
        );

    const usedIds = new Set<string>();
    const findings: LiveFinding[] = [];
    // The absent reviewers lead the report: a dimension this arm never had is
    // recorded, never silent, so a reader can tell an asymmetric arm from an
    // arm whose reviewer ran and found nothing.
    const perAgent: PerAgentReport[] = absent.map((name) => ({
        name,
        model: "",
        usd: 0,
        turns: 0,
        wallMs: 0,
        retried: false,
        absent: true,
    }));

    const finderResults = await mapWithConcurrency(
        roster,
        concurrency,
        async (agent) =>
            dispatchWithRetry(
                agent,
                resolvePrompt(agent),
                {
                    name: agent.name,
                    model: agent.model,
                    cwd: staged.checkoutDir,
                    maxTurns,
                    timeoutMs,
                },
                runner,
                (output) =>
                    parseAgentFindings(agent, output, usedIds, corpusCase.id),
            ),
    );
    for (const {report, parsed} of finderResults) {
        perAgent.push(report);
        if (parsed !== undefined) {
            findings.push(...parsed);
        }
    }

    // Cross-source dedup, before validation, exactly where production runs it.
    // The merged set REPLACES the produced one from here on (the claims path,
    // the validator's `knownIds`, and the returned findings all act on what
    // production would post), so the collected array is rewritten in place
    // rather than shadowed: a stray reference to the pre-merge set downstream
    // would silently re-post the duplicates this stage just merged.
    const {kept: dedupedFindings, dedup} = await dedupeLiveFindings(
        findings,
        agents.get(CLUSTERER),
        {
            dispatch: (agent, parse) =>
                dispatchWithRetry(
                    agent,
                    resolvePrompt(agent),
                    {
                        name: agent.name,
                        model: agent.model,
                        cwd: staged.checkoutDir,
                        maxTurns,
                        timeoutMs,
                    },
                    runner,
                    parse,
                ),
            write: (name, content) =>
                fs.writeFileSync(`${staged.contextDir}/${name}`, content),
        },
    );
    if (dedup.report !== undefined) {
        perAgent.push(dedup.report);
    }
    findings.length = 0;
    findings.push(...dedupedFindings);

    // The claims path: skip entirely when nothing was found (production
    // skips Phase 3 on an empty candidate set).
    let validation: CaseVerification[] = [];
    if (findings.length > 0) {
        const validator = agents.get(VALIDATOR);
        if (validator === undefined) {
            throw new Error(
                `sub-agent "${VALIDATOR}" is not defined in the extracted review.md`,
            );
        }
        const claims = buildClaims(findings);
        fs.writeFileSync(
            `${staged.contextDir}/claims.json`,
            JSON.stringify(claims, null, 2),
        );
        const knownIds = new Set(findings.map((live) => live.finding.id));
        const {report, parsed} = await dispatchWithRetry(
            validator,
            resolvePrompt(validator),
            {
                name: validator.name,
                model: validator.model,
                cwd: staged.checkoutDir,
                maxTurns,
                timeoutMs,
            },
            runner,
            (output) => parseVerifications(output, knownIds),
        );
        perAgent.push(report);
        validation = parsed ?? [];
    }

    // Re-review cases: dispatch the reconciler over the staged threads (it
    // runs at EVERY depth — reconciliation is the fast path's whole job).
    let reconciliation: LiveReconciliation | undefined;
    if (corpusCase.live?.rereview !== undefined) {
        const reconciler = agents.get(RECONCILER);
        if (reconciler === undefined) {
            throw new Error(
                `sub-agent "${RECONCILER}" is not defined in the extracted review.md`,
            );
        }
        const {report, parsed} = await dispatchWithRetry(
            reconciler,
            resolvePrompt(reconciler),
            {
                name: reconciler.name,
                model: reconciler.model,
                cwd: staged.checkoutDir,
                maxTurns,
                timeoutMs,
            },
            runner,
            parseReconciliation,
        );
        perAgent.push(report);
        reconciliation = parsed;
    }

    return {
        findings: findings.map(
            ({source, finding}): RecordedFinding => ({source, finding}),
        ),
        validation,
        perAgent,
        staged,
        ...(reconciliation !== undefined ? {reconciliation} : {}),
        dedup: dedup.result,
    };
};

/** Re-exported so the A/B runner types its recorded outputs without reaching
 * into internals. */
export type {Finding};
