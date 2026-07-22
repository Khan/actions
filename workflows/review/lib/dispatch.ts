/**
 * Script-driven dispatch and collection (deterministic-orchestrator slice 2):
 * the code that runs review.md Step 3's Phases 1-3 — triage, the reviewer
 * fan-out, output collection and normalization, the provenance gate, the
 * scope filter, and claim validation — as ONE deterministic program the
 * orchestrator invokes once, instead of protocol the model executes turn by
 * turn.
 *
 * Why: the 07-21 conformance failure (webapp#40992, run 29865480728) showed
 * prompt-executed dispatch is skippable; the slice-0 gate makes that a red
 * run, and this slice makes it structural — dispatch cannot be skipped when
 * dispatch is code (an orchestrator that skips *this CLI* stages no outputs
 * and the gate still blocks it). It is also the cost cut: the loop's longest
 * phase stops being model turns that re-read the whole conversation.
 *
 * Where it runs: inside the agent job's firewall sandbox, invoked by the
 * orchestrator via Bash. The sandbox's api-proxy injects Anthropic auth and
 * meters every request against the run's AI-credit cap, so script-spawned
 * sub-agents are priced and capped exactly like Task-spawned ones (verified
 * from a production run's awf config: `--env-all --exclude-env
 * ANTHROPIC_API_KEY` plus `apiProxy.enabled`). Sub-agent definitions are the
 * gh-aw inline agents the activation job extracted to `.claude/agents/`,
 * so the prompts dispatched here are byte-identical to what the Task tool
 * would launch.
 *
 * Opt-in: the consumer ROUTING file's `dispatch scripted` line (default
 * `task` keeps today's Task-tool path). This is the flagged production probe
 * the migration plan names; reviewer-visible deltas are live-trial-gated
 * (the script-driven eval cannot see the difference by construction: BOTH
 * of its arms already dispatch from a script).
 *
 * Parity: the shapes and rules here mirror the eval producer
 * (eval/live-producer.ts) and reuse the same lib functions it does
 * (validateFinding, labelForFinding, applyProvenanceGate), so the pipeline
 * the A/Bs measure stays the pipeline production runs.
 *
 * Determinism boundary: the sub-agents are models; everything around them
 * (roster, budget sheds, parsing, gating, scoping, verification application,
 * note lines) is pure code. No prose about the code under review.
 */

import {
    dedupeClaims,
    suppressOpenThreadDuplicates,
    type ClaimMerge,
    type OpenThread,
    type ThreadSuppression,
} from "./dedup";
import {annotateDiffLineNumbers, splitUnifiedDiff} from "./diff";
import {
    applyScopeFilter,
    buildClaims,
    contractValidator,
    parseFinderOutput,
    parseJsonObject,
    parseValidatorOutput,
    applyVerifications,
    anchorPathLine,
    isRecord,
    type Candidate,
    type Claim,
} from "./dispatch-contracts";
import {
    applyProvenanceGate,
    type DiffProvenance,
    type ProvenanceGateResult,
} from "./provenance";

// Re-exported so callers and tests have one import surface for the dispatch
// machinery (the split is a lint/file-size concern, not an API one).
export {
    applyScopeFilter,
    applyVerifications,
    buildClaims,
    contractValidator,
    parseFinderOutput,
    parseValidatorOutput,
    type Candidate,
    type Claim,
    type ContractKind,
    type Verification,
} from "./dispatch-contracts";
export {
    dedupeClaims,
    suppressOpenThreadDuplicates,
    type ClaimMerge,
    type ThreadSuppression,
} from "./dedup";

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

export type DispatchFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
    readdirSync: (p: string) => string[];
};

/** One sub-agent dispatch request (mirrors the eval's LiveAgentRequest). */
export type AgentRequest = {
    name: string;
    model: string;
    prompt: string;
    cwd: string;
    maxTurns: number;
    timeoutMs: number;
    /**
     * The structured-final contract check (trial suggestion h). When set,
     * the runner exposes a `submit_result` tool whose input is validated by
     * this function BEFORE it is accepted: null accepts the payload as the
     * agent's result; a string rejects it back to the model, which corrects
     * and re-calls in the same session (a few turns, not the $2-3 full
     * re-dispatch the malformed-output retry costs). Free-text finals stay as
     * the fallback for a model that never calls the tool.
     */
    validate?: (payload: Record<string, unknown>) => string | null;
};

export type AgentResult = {
    /** The agent's final text (expected to be its JSON contract). */
    output: string;
    usd: number;
    turns: number;
    wallMs: number;
    /** The output came through the structured-final tool, pre-validated. */
    structured?: boolean;
};

/** The model seam; the SDK-backed production runner lives in the CLI entry. */
export type AgentRunner = (request: AgentRequest) => Promise<AgentResult>;

/* -------------------------------------------------------------------------- */
/* Fixed paths and contracts                                                  */
/* -------------------------------------------------------------------------- */

const REVIEW_DIR = "/tmp/gh-aw/review";
const OUT_DIR = `${REVIEW_DIR}/out`;

const DEFAULT_MAX_TURNS = 30;
/**
 * Per-sub-agent wall-clock cap. 15 minutes, not 5: trial run 29901690493
 * killed both default finders (correctness-reviewer, skill-auditor) at
 * exactly the old 5-minute mark while every lighter reviewer finished in
 * 60-115s; the heavy investigators routinely need 5-10 minutes (the prior
 * pin's correctness pass ran ~8 minutes to completion). The cap is a hang
 * backstop, not a budget: credit spend is metered separately by the
 * sandbox's api-proxy.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;

const TRIAGE = "pattern-triage";
const RECONCILER = "thread-reconciler";
const VALIDATOR = "claim-validator";
const DEFAULT_FINDERS = ["correctness-reviewer", "skill-auditor"] as const;

/**
 * The Step 3 dispatch/shed ranking, first-shed first. Fill order under the
 * invocation cap is this list reversed after the defaults and matched
 * lenses. An enabled reviewer this table does not know sheds after
 * `conventions` (generic before targeted).
 */
const SHED_RANKING = [
    "conventions",
    "first-principles",
    "holistic",
    "completeness",
    "test-adequacy",
] as const;

/* -------------------------------------------------------------------------- */
/* Agent definitions (.claude/agents/<name>.md)                               */
/* -------------------------------------------------------------------------- */

export type AgentDefinition = {name: string; model: string; prompt: string};

/**
 * Parse one gh-aw inline agent file: YAML-ish frontmatter carrying `name:`
 * and `model:`, body = the prompt. Deliberately minimal — these files are
 * machine-written by gh-aw's extraction, not hand-authored.
 */
export const parseAgentFile = (text: string): AgentDefinition | null => {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (match === null) {
        return null;
    }
    const front = match[1];
    const prompt = match[2].trim();
    const field = (key: string): string | undefined => {
        const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front);
        return line?.[1]?.trim();
    };
    const name = field("name");
    if (name === undefined || prompt === "") {
        return null;
    }
    return {name, model: field("model") ?? "", prompt};
};

const loadAgents = (
    fs: DispatchFs,
    agentsDir: string,
): Map<string, AgentDefinition> => {
    const agents = new Map<string, AgentDefinition>();
    if (!fs.existsSync(agentsDir)) {
        return agents;
    }
    for (const entry of fs.readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) {
            continue;
        }
        try {
            const parsed = parseAgentFile(
                fs.readFileSync(`${agentsDir}/${entry}`, "utf8"),
            );
            if (parsed !== null) {
                agents.set(parsed.name, parsed);
            }
        } catch {
            // An unreadable definition surfaces later as an unavailable
            // dimension for whatever roster entry needed it.
        }
    }
    return agents;
};

/* -------------------------------------------------------------------------- */
/* Roster                                                                     */
/* -------------------------------------------------------------------------- */

export type RosterShed = {name: string; cause: "budget"};

export type Roster = {
    /** Finding producers to dispatch, in dispatch-ranking order. */
    finders: string[];
    /** Planned finding producers shed under the invocation cap. */
    shed: RosterShed[];
    /** Whether pattern-triage runs (full/scoped only). */
    triage: boolean;
    /** Whether the reconciler runs (staged threads exist). */
    reconcile: boolean;
};

/**
 * Compute the dispatch roster per the staged depth plan and routing, capped
 * by `runBudget.maxReviewerInvocations` in the Step 3 dispatch ranking
 * (defaults, then matched lenses, then opt-ins by inverse shed order), every
 * capped-out entry recorded as a planned shed. Pipeline steps (triage,
 * reconciler, validator) never consume a slot.
 */
export const computeRoster = (
    depth: string,
    routing: {
        enabledReviewers?: unknown;
        lensesToSpawn?: unknown;
        runBudget?: {maxReviewerInvocations?: unknown};
    },
    hasThreads: boolean,
): Roster => {
    if (depth === "fast") {
        return {finders: [], shed: [], triage: false, reconcile: hasThreads};
    }
    if (depth === "flip-gated") {
        return {
            finders: ["correctness-reviewer"],
            shed: [],
            triage: false,
            reconcile: hasThreads,
        };
    }
    const strings = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string")
            : [];
    const lenses = strings(routing.lensesToSpawn);
    const enabled = strings(routing.enabledReviewers).filter(
        (name) => !lenses.includes(name),
    );
    const optIns = [...enabled].sort((a, b) => {
        const rank = (name: string): number => {
            const index = (SHED_RANKING as readonly string[]).indexOf(name);
            return index === -1 ? -0.5 : index;
        };
        return rank(b) - rank(a);
    });
    const ranked = [...DEFAULT_FINDERS, ...lenses, ...optIns];

    const capRaw = routing.runBudget?.maxReviewerInvocations;
    const cap =
        typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw >= 0
            ? capRaw
            : ranked.length;
    const finders = ranked.slice(0, Math.max(cap, DEFAULT_FINDERS.length));
    const shed = ranked
        .slice(finders.length)
        .map((name): RosterShed => ({name, cause: "budget"}));
    return {finders, shed, triage: true, reconcile: hasThreads};
};

/* -------------------------------------------------------------------------- */
/* The dispatch run                                                           */
/* -------------------------------------------------------------------------- */

export type PerAgentReport = {
    name: string;
    model: string;
    usd: number;
    turns: number;
    wallMs: number;
    /** This entry is the one malformed-output retry of the same agent. */
    retried?: boolean;
    /** The result arrived via the structured-final tool (pre-validated). */
    structuredFinal?: boolean;
    failed?: string;
};

export type DispatchSkippedDimension = {
    dimension: string;
    cause: "budget" | "unavailable";
};

export type DispatchResult = {
    depth: string;
    /** Finding producers planned / dispatched / shed (the gate's rule 3). */
    planned: string[];
    dispatched: string[];
    shed: RosterShed[];
    skippedDimensions: DispatchSkippedDimension[];
    /** Step 6 note lines, code-rendered, ready to append verbatim. */
    noteLines: string[];
    /** The validated claims Steps 4-6 act on. */
    claims: Claim[];
    /** Cross-source duplicates merged before validation (#245). */
    merges: ClaimMerge[];
    /**
     * Candidates dropped because an open bot thread already tracks the
     * defect (trial suggestion g). Blocking entries still floor the verdict
     * (submission.ts): the open thread is the actionable feedback.
     */
    threadSuppressions: ThreadSuppression[];
    /** The reconciler's decision, when it ran and parsed. */
    reconciliation?: {resolve: string[]; keep: string[]; skipLines: unknown};
    /** correctness-reviewer `files[]` risk levels (Steps 7-8). */
    riskFiles?: unknown;
    /** pattern-triage patterns + excluded files (Step 7). */
    patterns?: unknown;
    excludedFiles?: string[];
    perAgent: PerAgentReport[];
    totalUsd: number;
};

export type DispatchOptions = {
    fs: DispatchFs;
    runner: AgentRunner;
    /** The PR checkout (sub-agent cwd). */
    repoRoot: string;
    /** gh-aw's extracted inline agents (default `<repoRoot>/.claude/agents`). */
    agentsDir?: string;
    maxTurns?: number;
    timeoutMs?: number;
    concurrency?: number;
};

const readJson = (fs: DispatchFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/** Bounded-concurrency map (order-preserving). */
const mapConcurrent = async <T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
): Promise<R[]> => {
    const results: R[] = new Array(items.length) as R[];
    let next = 0;
    const lanes = Array.from(
        {length: Math.max(1, Math.min(limit, items.length))},
        async () => {
            for (;;) {
                const index = next++;
                if (index >= items.length) {
                    return;
                }
                results[index] = await worker(items[index]);
            }
        },
    );
    await Promise.all(lanes);
    return results;
};

const noteLine = {
    shed: (dimension: string, tier: string): string =>
        `Note: ${dimension} not assessed this run (shed under the ${tier}-tier run budget).`,
    unavailable: (dimension: string, agent: string): string =>
        `Note: ${dimension} not assessed this run (${agent} output unavailable).`,
};

/**
 * Run Step 3 end to end over the staged review directory. Every sub-agent's
 * raw output (or error note) is written to `out/<agent>.json` exactly as the
 * prompt required of the orchestrator, so the run artifact and the
 * dispatch-conformance gate read the same evidence either dispatch mode.
 */
export const runDispatch = async (
    options: DispatchOptions,
): Promise<DispatchResult> => {
    const {fs, runner, repoRoot} = options;
    const agentsDir = options.agentsDir ?? `${repoRoot}/.claude/agents`;
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    fs.mkdirSync(OUT_DIR, {recursive: true});
    const agents = loadAgents(fs, agentsDir);
    const routing = (readJson(fs, `${REVIEW_DIR}/routing.json`) ?? {}) as {
        enabledReviewers?: unknown;
        lensesToSpawn?: unknown;
        runBudget?: {maxReviewerInvocations?: unknown; tier?: unknown};
    };
    const tier =
        typeof routing.runBudget?.tier === "string"
            ? routing.runBudget.tier
            : "Low";
    const plan = readJson(fs, `${REVIEW_DIR}/rereview-plan.json`) as
        | {depth?: unknown}
        | undefined;
    const depth = typeof plan?.depth === "string" ? plan.depth : "full";
    const threads = readJson(fs, `${REVIEW_DIR}/threads.json`);
    const hasThreads = Array.isArray(threads) && threads.length > 0;

    const roster = computeRoster(depth, routing, hasThreads);
    const lensNames = Array.isArray(routing.lensesToSpawn)
        ? routing.lensesToSpawn
        : [];
    /** The structured-final contract check for each dispatchable agent. */
    const validatorFor = (
        name: string,
    ): ((payload: Record<string, unknown>) => string | null) =>
        contractValidator(
            name,
            name === VALIDATOR
                ? "validator"
                : name === TRIAGE || name === RECONCILER
                ? "json"
                : lensNames.includes(name)
                ? "lens"
                : "finder",
        );
    const perAgent: PerAgentReport[] = [];
    const skippedDimensions: DispatchSkippedDimension[] = roster.shed.map(
        (shed) => ({
            dimension: shed.name,
            cause: "budget",
        }),
    );
    const writeOut = (name: string, content: string): void => {
        fs.writeFileSync(`${OUT_DIR}/${name}.json`, content);
    };

    /**
     * Dispatch one agent; stage its raw output; report cost and failure.
     * `malformedNote` marks the one contract-parse retry: it appends the
     * corrective instruction to the prompt and flags the report entry.
     */
    const dispatchAgent = async (
        name: string,
        malformedNote?: string,
    ): Promise<string | null> => {
        const definition = agents.get(name);
        if (definition === undefined) {
            writeOut(name, JSON.stringify({error: "agent definition missing"}));
            perAgent.push({
                name,
                model: "",
                usd: 0,
                turns: 0,
                wallMs: 0,
                failed: "definition-missing",
            });
            return null;
        }
        try {
            const corrective =
                malformedNote === undefined
                    ? ""
                    : `\n\nYour previous reply could not be used (${malformedNote}). Submit again now, and this time deliver the complete corrected JSON object through the submit_result tool (or, if that tool is unavailable, as your ENTIRE message: no prose before or after it, no code fence).`;
            const result = await runner({
                name,
                model: definition.model,
                prompt: `${definition.prompt}\n\nProceed now per your definition. Deliver your result by calling the submit_result tool ONCE, passing the ENTIRE JSON object your definition's output contract specifies as its \`result\` argument; if the tool rejects it, correct the object and call the tool again. After it is accepted, end the turn without repeating the JSON. If the submit_result tool is unavailable, your final message must be exactly that JSON object, nothing else.${corrective}`,
                cwd: repoRoot,
                maxTurns,
                timeoutMs,
                validate: validatorFor(name),
            });
            writeOut(name, result.output);
            perAgent.push({
                name,
                model: definition.model,
                usd: result.usd,
                turns: result.turns,
                wallMs: result.wallMs,
                ...(malformedNote === undefined ? {} : {retried: true}),
                ...(result.structured === true ? {structuredFinal: true} : {}),
            });
            return result.output;
        } catch (error) {
            writeOut(
                name,
                JSON.stringify({
                    error:
                        error instanceof Error ? error.message : String(error),
                }),
            );
            perAgent.push({
                name,
                model: definition.model,
                usd: 0,
                turns: 0,
                wallMs: 0,
                failed: "run-failed",
            });
            return null;
        }
    };

    /**
     * Parse an agent's output per its contract, re-dispatching ONCE with a
     * corrective note when the parse fails (the eval producer's
     * malformed-output rule). The retry's output overwrites the staged
     * out-file, so the gate reads whatever the run actually acted on. A
     * second failure returns null and the caller sheds the dimension with
     * its disclosure note; without the retry, one prose-wrapped reply
     * silently voids a dispatched (and paid-for) reviewer, which is how the
     * mandatory correctness pass went missing in trial run 29893634730.
     */
    const parseWithRetry = async <T>(
        name: string,
        output: string,
        parse: (output: string) => T,
    ): Promise<T | null> => {
        try {
            return parse(output);
        } catch (error) {
            const note = error instanceof Error ? error.message : String(error);
            const second = await dispatchAgent(name, note);
            if (second === null) {
                return null;
            }
            try {
                return parse(second);
            } catch {
                return null;
            }
        }
    };

    // Phase 1: triage (full/scoped), staging pr.diff and review-files.json.
    let excludedFiles: string[] | undefined;
    let patterns: unknown;
    let finders = roster.finders;
    if (roster.triage) {
        const output = await dispatchAgent(TRIAGE);
        let reviewFiles: string[] | null = null;
        const parsed =
            output === null
                ? null
                : await parseWithRetry(TRIAGE, output, parseJsonObject);
        if (parsed !== null) {
            patterns = parsed["patterns"];
            const raw = parsed["reviewFiles"];
            if (Array.isArray(raw)) {
                const strings = raw.filter(
                    (v): v is string => typeof v === "string",
                );
                // A non-empty array of non-strings is malformed triage
                // output, not an empty review: the gate's empty-reviewFiles
                // waiver reads the RAW staged array, so treating it as
                // empty here would dispatch no finders and render no
                // disclosure while rule 1 still demands the correctness
                // pass (a guaranteed false block). Fall through to the
                // triage-unavailable path instead (review everything).
                reviewFiles =
                    strings.length === 0 && raw.length > 0 ? null : strings;
            }
        }
        const diffPath =
            depth === "scoped" && fs.existsSync(`${REVIEW_DIR}/scoped.diff`)
                ? `${REVIEW_DIR}/scoped.diff`
                : `${REVIEW_DIR}/full.diff`;
        const diffText = fs.existsSync(diffPath)
            ? fs.readFileSync(diffPath, "utf8")
            : "";
        if (reviewFiles === null) {
            // Triage unavailable: review everything (fail toward more
            // review), and say so.
            skippedDimensions.push({
                dimension: "pattern triage",
                cause: "unavailable",
            });
            fs.writeFileSync(`${REVIEW_DIR}/pr.diff`, diffText);
            fs.writeFileSync(
                `${REVIEW_DIR}/pr-annotated.diff`,
                annotateDiffLineNumbers(diffText),
            );
            // The finder prompts read review-files.json for their file
            // list; with triage unavailable, everything is a review file.
            const allFiles = readJson(fs, `${REVIEW_DIR}/files.json`);
            fs.writeFileSync(
                `${REVIEW_DIR}/review-files.json`,
                JSON.stringify(
                    Array.isArray(allFiles) ? allFiles : [],
                    null,
                    2,
                ),
            );
        } else {
            const sections = splitUnifiedDiff(diffText);
            const wanted = new Set(reviewFiles);
            const prDiff = sections
                .filter((section) => wanted.has(section.path))
                .map((section) => section.text)
                .join("\n");
            fs.writeFileSync(`${REVIEW_DIR}/pr.diff`, prDiff);
            fs.writeFileSync(
                `${REVIEW_DIR}/pr-annotated.diff`,
                annotateDiffLineNumbers(prDiff),
            );
            const allFiles = readJson(fs, `${REVIEW_DIR}/files.json`);
            const fileList = Array.isArray(allFiles) ? allFiles : [];
            fs.writeFileSync(
                `${REVIEW_DIR}/review-files.json`,
                JSON.stringify(
                    fileList.filter(
                        (entry) =>
                            isRecord(entry) &&
                            typeof entry["path"] === "string" &&
                            wanted.has(entry["path"]),
                    ),
                    null,
                    2,
                ),
            );
            excludedFiles = fileList
                .map((entry) =>
                    isRecord(entry) && typeof entry["path"] === "string"
                        ? entry["path"]
                        : "",
                )
                .filter((path) => path !== "" && !wanted.has(path));
            if (reviewFiles.length === 0) {
                finders = [];
            }
        }
    }

    // Phase 2: the reviewer fan-out plus the reconciler, in parallel.
    const usedIds = new Set<string>();
    const candidates: Candidate[] = [];
    let riskFiles: unknown;
    let reconciliation: DispatchResult["reconciliation"];
    const wave = [
        ...finders.map((name) => ({name, kind: "finder" as const})),
        ...(roster.reconcile
            ? [{name: RECONCILER, kind: "reconciler" as const}]
            : []),
    ];
    const outputs = await mapConcurrent(wave, concurrency, async (entry) => ({
        entry,
        output: await dispatchAgent(entry.name),
    }));
    for (const {entry, output} of outputs) {
        const shedDimension = (): void => {
            skippedDimensions.push({
                dimension:
                    entry.kind === "reconciler"
                        ? "thread reconciliation"
                        : entry.name,
                cause: "unavailable",
            });
        };
        if (output === null) {
            shedDimension();
            continue;
        }
        if (entry.kind === "reconciler") {
            const parsed = await parseWithRetry(
                entry.name,
                output,
                parseJsonObject,
            );
            if (parsed === null) {
                shedDimension();
                continue;
            }
            reconciliation = {
                resolve: Array.isArray(parsed["resolve"])
                    ? parsed["resolve"].filter(
                          (v): v is string => typeof v === "string",
                      )
                    : [],
                keep: Array.isArray(parsed["keep"])
                    ? parsed["keep"].filter(
                          (v): v is string => typeof v === "string",
                      )
                    : [],
                skipLines: parsed["skipLines"] ?? [],
            };
        } else {
            const parsed = await parseWithRetry(entry.name, output, (raw) =>
                parseFinderOutput(
                    entry.name,
                    raw,
                    usedIds,
                    lensNames.includes(entry.name),
                ),
            );
            if (parsed === null) {
                shedDimension();
                continue;
            }
            candidates.push(...parsed.candidates);
            if (entry.name === "correctness-reviewer") {
                riskFiles = parsed.riskFiles;
            }
        }
    }

    // The change-provenance gate (code-computed), with its artifact records.
    const provenance = readJson(fs, `${REVIEW_DIR}/provenance.json`) as
        | DiffProvenance
        | undefined;
    let gated: ProvenanceGateResult = {
        kept: candidates.map((c) => c.finding),
        preExisting: [],
        snapped: [],
    };
    let provenanceSkipped = false;
    if (provenance !== undefined && Array.isArray(provenance.warnings)) {
        gated = applyProvenanceGate(
            candidates.map((c) => c.finding),
            provenance,
        );
        provenanceSkipped = provenance.warnings.length > 0;
    } else {
        provenanceSkipped = true;
    }
    const byId = new Map(candidates.map((c) => [c.finding.id, c]));
    const keptCandidates = gated.kept.map((finding) => ({
        ...(byId.get(finding.id) as Candidate),
        finding,
    }));
    if (gated.snapped.length > 0) {
        writeOut(
            "snapped",
            JSON.stringify(
                gated.snapped.map((snap) => ({
                    id: snap.finding.id,
                    path:
                        snap.originalAnchor.type === "pr"
                            ? undefined
                            : snap.originalAnchor.path,
                    from:
                        snap.originalAnchor.type === "line"
                            ? snap.originalAnchor.line
                            : undefined,
                    to:
                        snap.finding.anchor.type === "line"
                            ? snap.finding.anchor.line
                            : undefined,
                })),
                null,
                2,
            ),
        );
    }
    if (gated.preExisting.length > 0) {
        writeOut(
            "pre-existing",
            JSON.stringify(
                gated.preExisting.map((finding) => ({
                    id: finding.id,
                    anchor: finding.anchor,
                    prose: finding.model_authored_prose,
                })),
                null,
                2,
            ),
        );
    }

    // The newly-changed-code scope filter.
    const scope = readJson(fs, `${REVIEW_DIR}/new-scope.json`) as
        | {priorReview?: unknown; inScope?: unknown}
        | undefined;
    const scoped = applyScopeFilter(keptCandidates, scope);

    // Author disputes staged by the orchestrator (it read the threads).
    const disputes = readJson(fs, `${REVIEW_DIR}/author-disputes.json`);
    if (Array.isArray(disputes)) {
        for (const dispute of disputes) {
            if (!isRecord(dispute)) {
                continue;
            }
            for (const candidate of scoped.kept) {
                const {path, line} = anchorPathLine(candidate.finding.anchor);
                if (
                    path === dispute["path"] &&
                    line === dispute["line"] &&
                    typeof dispute["quote"] === "string"
                ) {
                    candidate.authorDispute = dispute["quote"];
                }
            }
        }
    }

    // Cross-source duplicate merge (#245), BEFORE validation so duplicate
    // claims are neither separately validated (the largest sub-agent cost
    // line) nor separately posted.
    const deduped = dedupeClaims(buildClaims(scoped.kept));
    let claims = deduped.claims;

    // Open-thread suppression (trial suggestion g), also before validation:
    // a defect an open bot thread already tracks is not re-validated or
    // re-posted at a new anchor. Threads the reconciler resolves this run
    // are exempt: a resolved thread's defect posting again is a fresh
    // finding, not a duplicate. When the reconciler was unavailable, nothing
    // resolves, so every staged thread suppresses (fail toward fewer
    // duplicate threads; the open thread remains the feedback).
    const resolvedIds = new Set(reconciliation?.resolve ?? []);
    const openThreads: OpenThread[] = (Array.isArray(threads) ? threads : [])
        .filter(isRecord)
        .filter(
            (thread) =>
                typeof thread["thread_id"] === "string" &&
                !resolvedIds.has(thread["thread_id"]),
        )
        .map((thread) => {
            const comments = thread["comments"];
            const opener =
                Array.isArray(comments) && isRecord(comments[0])
                    ? comments[0]["body"]
                    : undefined;
            return {
                thread_id: thread["thread_id"] as string,
                ...(typeof thread["path"] === "string"
                    ? {path: thread["path"]}
                    : {}),
                body: typeof opener === "string" ? opener : "",
            };
        });
    const suppression = suppressOpenThreadDuplicates(claims, openThreads);
    claims = suppression.kept;

    // Phase 3: claim validation.
    let validatorRan = false;
    if (claims.length > 0) {
        fs.writeFileSync(
            `${REVIEW_DIR}/claims.json`,
            JSON.stringify(claims, null, 2),
        );
        const output = await dispatchAgent(VALIDATOR);
        if (output !== null) {
            const verifications = await parseWithRetry(
                VALIDATOR,
                output,
                parseValidatorOutput,
            );
            if (verifications !== null) {
                claims = applyVerifications(claims, verifications);
                validatorRan = true;
            }
        }
        if (!validatorRan) {
            // The dispute cap still applies without a validator (the
            // mechanical floor applyVerifications enforces for unmentioned
            // claims).
            claims = applyVerifications(claims, {});
            skippedDimensions.push({
                dimension: "claim validation",
                cause: "unavailable",
            });
        }
    }

    const dispatched = [
        ...new Set(
            perAgent
                .filter((agent) => agent.failed === undefined)
                .map((agent) => agent.name),
        ),
    ];
    const noteLines = [
        ...roster.shed.map((shed) => noteLine.shed(shed.name, tier)),
        ...skippedDimensions
            .filter((skip) => skip.cause === "unavailable")
            .map((skip) =>
                noteLine.unavailable(
                    skip.dimension,
                    skip.dimension === "claim validation"
                        ? VALIDATOR
                        : skip.dimension === "thread reconciliation"
                        ? RECONCILER
                        : skip.dimension === "pattern triage"
                        ? TRIAGE
                        : skip.dimension,
                ),
            ),
        ...(provenanceSkipped
            ? [
                  "Note: change-provenance gate skipped this run (diff staging unparseable).",
              ]
            : []),
        ...(suppression.suppressed.length > 0
            ? [
                  `Note: ${suppression.suppressed.length} finding(s) not re-posted (already tracked in open review threads).`,
              ]
            : []),
    ];

    const result: DispatchResult = {
        depth,
        planned: [...roster.finders, ...roster.shed.map((shed) => shed.name)],
        dispatched,
        shed: roster.shed,
        skippedDimensions,
        noteLines,
        claims,
        merges: deduped.merges,
        threadSuppressions: suppression.suppressed,
        ...(reconciliation !== undefined ? {reconciliation} : {}),
        ...(riskFiles !== undefined ? {riskFiles} : {}),
        ...(patterns !== undefined ? {patterns} : {}),
        ...(excludedFiles !== undefined ? {excludedFiles} : {}),
        perAgent,
        totalUsd: perAgent.reduce((sum, agent) => sum + agent.usd, 0),
    };
    const serialized = JSON.stringify(result, null, 2);
    fs.writeFileSync(`${REVIEW_DIR}/dispatch-result.json`, serialized);
    // Also staged under out/ so the Step 9 artifact upload carries it: run
    // 29943085279's post-hoc could not tell whether the correctness output
    // arrived structured or via the text fallback because perAgent
    // (structuredFinal, retried, per-agent usd), merges, and
    // threadSuppressions lived only in the review dir, which the artifact
    // does not include. The dispatch gate tolerates non-agent out/ files
    // (rereview-plan.json already stages there).
    writeOut("dispatch-result", serialized);
    return result;
};

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                  */
/* -------------------------------------------------------------------------- */

// Run only when executed directly (review.md Step 3, scripted dispatch mode),
// never on import (tests). The SDK-backed runner (dispatch-runner.ts) is
// loaded lazily so unit tests and the task-mode path never require the SDK;
// the staging pre-step installs it (workflows/review/package.json) before
// the agent starts.
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs") as DispatchFs;
    void (async () => {
        const {createSdkRunner} = await import("./dispatch-runner");
        const runner = await createSdkRunner();
        const repoRoot =
            process.env.REVIEW_REPO_ROOT ?? process.env.GITHUB_WORKSPACE ?? ".";
        const result = await runDispatch({fs: nodeFs, runner, repoRoot});
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify(
                {
                    depth: result.depth,
                    dispatched: result.dispatched,
                    shed: result.shed,
                    skippedDimensions: result.skippedDimensions,
                    claims: result.claims.length,
                    totalUsd: result.totalUsd,
                },
                null,
                2,
            ),
        );
    })().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
            `::error title=review dispatch::${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        process.exit(1);
    });
}
