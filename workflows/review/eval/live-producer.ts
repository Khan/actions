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
 *    when the file exists there, else to a fixed "not configured" note, so a
 *    case can opt into a skills index by carrying the file in its tree.
 *  - The investigation-cap CLI the prompts invoke is not staged; sub-agents
 *    run with read-only tools and treat the unavailable cap as a denied
 *    budget (the prompt's own fallback: stop investigating, report what you
 *    have).
 */

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
    VERIFICATION_STATES,
    type CaseVerification,
    type CorpusCase,
    type RecordedFinding,
    type VerificationState,
} from "./corpus/loader";
import type {ExtractedAgent} from "./agent-extract";
import type {ReReviewMode} from "../lib/routing-config";
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
    /** Fixed-format failure note; the agent contributed nothing when set. */
    failed?: string;
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

const RUNTIME_IMPORT = /\{\{#runtime-import\??\s+([^}\s]+)\s*\}\}/g;

const IMPORT_FALLBACK = "(not configured for this eval case)";

/**
 * Inline `{{#runtime-import <path>}}` directives from the case's checkout
 * tree, falling back to a fixed note when the tree does not carry the file.
 * Exported for the A/B runner's reporting (which imports resolved per case).
 */
export const resolveRuntimeImports = (
    prompt: string,
    checkoutDir: string,
    fs: Pick<StageFs, "existsSync" | "readFileSync">,
): string =>
    prompt.replace(RUNTIME_IMPORT, (_match, importPath: string) => {
        const full = `${checkoutDir}/${importPath}`;
        return fs.existsSync(full)
            ? fs.readFileSync(full, "utf8")
            : IMPORT_FALLBACK;
    });

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

    const labelLens: Record<string, {lens: Lens; source: string}> = {
        "correctness-reviewer": {lens: "correctness", source: "correctness"},
        "skill-auditor": {lens: "conventions", source: "skill"},
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
    for (let attempt = 0; attempt < 2; attempt++) {
        let failure: string;
        try {
            const result = await runner({...request, prompt: attemptPrompt});
            report.usd += result.usd;
            report.turns += result.turns;
            report.wallMs += result.wallMs;
            try {
                return {report, parsed: parse(result.output)};
            } catch (parseError) {
                failure = `malformed output: ${String(
                    parseError instanceof Error
                        ? parseError.message
                        : parseError,
                )}`;
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

    // Roster: default finders + routed specialist lenses — sized by the
    // re-review depth plan when the case is an open-PR snapshot. `scoped`
    // keeps the full roster (over the scoped diff the staging already wrote);
    // `flip-gated` keeps only the correctness pass; `fast` keeps none.
    const routerConfig: RouterConfig = {
        generatedPatterns: [],
        ...(corpusCase.routerConfig as Partial<RouterConfig>),
    };
    const routing = route({files: corpusCase.changedFiles}, routerConfig);
    const dispatch = staged.rereviewPlan?.dispatch ?? "all";
    const rosterNames =
        dispatch === "all"
            ? [...DEFAULT_FINDERS, ...routing.lensesToSpawn]
            : dispatch === "reconcile+correctness"
            ? ["correctness-reviewer"]
            : [];
    const roster = rosterNames.map((name) => {
        const agent = agents.get(name);
        if (agent === undefined) {
            throw new Error(
                `sub-agent "${name}" is not defined in the extracted review.md`,
            );
        }
        return agent;
    });

    const resolvePrompt = (agent: ExtractedAgent): string =>
        rewriteAgentPrompt(
            resolveRuntimeImports(agent.prompt, staged.checkoutDir, fs),
            staged,
        );

    const usedIds = new Set<string>();
    const findings: LiveFinding[] = [];
    const perAgent: PerAgentReport[] = [];

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
    };
};

/** Re-exported so the A/B runner types its recorded outputs without reaching
 * into internals. */
export type {Finding};
