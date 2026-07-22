/**
 * The dispatch-conformance gate: a review verdict cannot leave the agent job
 * unless the sub-agent outputs it claims to summarize actually exist.
 *
 * The production failure this module exists for (the review-v1.7.0 acceptance
 * trial, Khan/webapp#40992, run 29865480728): the orchestrator ran no router,
 * dispatched zero sub-agents, did no claim validation, reviewed the diff
 * itself, labeled its audit record "streamlined direct review", and submitted
 * a REQUEST_CHANGES whose body disclosed none of it. Nothing on the PR
 * distinguishes such a run from a conforming one (the previous day's review
 * of Khan/actions#272 dispatched correctly and disclosed its sheds), the eval
 * harness dispatches sub-agents from a script so it can never observe
 * protocol fidelity, and an orchestrator that skips dispatch also skips
 * prompt-mandated self-checks; code at the submission chokepoint is the only
 * lever. Same design family as v1.6.1's non-empty-body rule.
 *
 * Where it runs: a gh-aw `post-steps:` step in the agent job. gh-aw v0.81.6
 * compiles post-steps after "Ingest agent output" (which finalizes
 * `/tmp/gh-aw/agent_output.json`, the validated safe-output queue) and before
 * "Upload agent artifacts" (which ships that file to the `safe_outputs` job,
 * the separate job that actually calls the GitHub API). The gate therefore
 * sees the exact queue the API-calling job will execute, plus the real
 * `/tmp/gh-aw/review/` staging on the same runner, and a rewrite here BLOCKS
 * the submission rather than detecting it after the fact.
 *
 * What it enforces (per re-review depth; `rereview-plan.json` is the staged
 * source of truth, missing plan defaults to `full`, the strictest):
 *
 *   1. A queued review verdict requires `out/correctness-reviewer.json` to
 *      exist at every depth that dispatches the correctness pass (`full`,
 *      `scoped`, `flip-gated`). The one waiver: `pattern-triage` returned an
 *      empty `reviewFiles` (nothing needed review), proven by its own staged
 *      output. `fast` dispatches no finding producers, so it carries no
 *      correctness requirement.
 *   2. Queued inline review comments require a parseable
 *      `out/claim-validator.json`, or the disclosed skipped-dimension note
 *      ("claim validation not assessed this run ...") in the verdict body
 *      (the #258 shed rules allow shedding the validator near a hard
 *      ceiling, but never silently).
 *   3. Planned-but-undispatched reviewers must be disclosed: every name in
 *      `routing.json`'s `enabledReviewers`/`lensesToSpawn` with no `out/`
 *      file needs its "not assessed this run" note in the verdict body.
 *   4. An APPROVE cannot carry a blocking inline comment (Step 4's verdict
 *      is a mechanical function of the labels; slice 3).
 *   5. The reduced-depth flip veto (Step 4): at flip-gated/fast depth over a
 *      prior REQUEST_CHANGES stamp, APPROVE requires `rereview.json`'s
 *      `keptBlockingCount` to be zero (slice 3; the #246 flip-gate
 *      chokepoint).
 *   6. Every queued thread resolution must be one the reconciler decided
 *      (`out/thread-reconciler.json` `resolve`); the deficit direction is
 *      reported as executed-vs-decided accounting, never blocked (slice 3;
 *      the #244 ledger).
 *   7. When a submission plan is staged (`submission-plan.json`, scripted
 *      mode, slice 4), the queued event, body, and inline comments must
 *      match it under a sanitizer-tolerant normalization; any splice or
 *      omission blocks (the #244 accountability-splice check, as code).
 *
 * Violation behavior: strip every posting/mutating item from the queue
 * (keeping the diagnostics and the `out/` artifact upload so the evidence
 * still lands), preserve the original queue beside the agent artifact, and
 * exit non-zero, which fails the agent job and files gh-aw's failure issue.
 * A violated run is a red run that posts nothing, never a silently-passing
 * one. Existence is the contract, not authenticity: the gate proves the
 * orchestrator staged reviewer outputs, not that a model produced them
 * (script-driven dispatch, the next migration slice, closes that residual).
 *
 * Deliberately NOT enforced, to keep the false-positive rate at zero:
 * `thread-reconciler` and `skill-auditor` existence (production shows a
 * conforming first review with no prior threads dispatches no reconciler,
 * e.g. Khan/actions#272), `pattern-triage` itself, and the router having run
 * (a routerless freelancing run is already caught by rule 1).
 *
 * Determinism boundary: pure functions of the queued items and the staged
 * files; no model call, no clock, no prose about the code under review.
 */

import {extractJsonValue} from "./agent-json";
import {isBlockingLabel} from "./render-comment";
import {parseLeadingLabel} from "./rereview";
import {findLatestStamp, stampFromCacheMemory} from "./rereview-mode";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** One queued safe-output item (only the fields the gate reads are typed). */
export type SafeOutputItem = {
    type?: unknown;
    event?: unknown;
    body?: unknown;
} & Record<string, unknown>;

/** Mirrors `ReReviewDepth` (rereview-mode.ts); parsed defensively here. */
export type DispatchGateDepth = "full" | "scoped" | "flip-gated" | "fast";

const GATE_DEPTHS: readonly DispatchGateDepth[] = [
    "full",
    "scoped",
    "flip-gated",
    "fast",
];

export type DispatchGateViolationCode =
    | "correctness-missing"
    | "correctness-unparseable-undisclosed"
    | "validator-missing-with-findings"
    | "shed-undisclosed"
    | "approve-with-blocking-comment"
    | "flip-vetoed-kept-blocking"
    | "resolve-not-decided"
    | "submission-plan-mismatch";

export type DispatchGateViolation = {
    /** Fixed-format code (never prose). */
    code: DispatchGateViolationCode;
    /** The reviewer / lens / dimension the violation is about. */
    dimension: string;
    /** One sentence for the step log and the failure issue. */
    detail: string;
};

export type DispatchGateEvaluation = {
    conformant: boolean;
    violations: DispatchGateViolation[];
    /** The queued verdict event; null when no review submission is queued. */
    verdictEvent: string | null;
    /** Queued inline review comment count. */
    commentCount: number;
    /** The depth the rules ran under (defaulted to `full` when unstaged). */
    depth: DispatchGateDepth;
    /** Non-blocking observations (unstaged inputs, applied waivers). */
    notes: string[];
};

export type DispatchGateInput = {
    /** The validated safe-output queue (`agent_output.json` `items`). */
    items: SafeOutputItem[];
    /** Parsed `rereview-plan.json`; undefined when not staged. */
    plan: unknown;
    /** Parsed `routing.json`; undefined when not staged. */
    routing: unknown;
    /** `out/` basename → raw file text, e.g. `correctness-reviewer.json`. */
    outFiles: Record<string, string>;
    /** Parsed `prior-reviews.json` (the flip rule's stamp source). */
    priorReviews?: unknown;
    /**
     * Parsed cache-memory record (`pr-<n>.json`), the fallback stamp
     * carrier: posted bodies never keep their stamp (the ingest sanitizer
     * strips HTML comments), so the flip rule reads the same carrier the
     * plan CLI anchored on.
     */
    cacheMemory?: unknown;
    /** Parsed `rereview.json` (the accountability result; `keptBlockingCount`). */
    rereviewAccounting?: unknown;
    /** Parsed `submission-plan.json` (scripted mode; slice 4). */
    submissionPlan?: unknown;
};

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

const SUBMIT_TYPE = "submit_pull_request_review";
const COMMENT_TYPE = "create_pull_request_review_comment";
const RESOLVE_TYPE = "resolve_pull_request_review_thread";
const RECONCILER_OUT = "thread-reconciler.json";

const CORRECTNESS_OUT = "correctness-reviewer.json";
const VALIDATOR_OUT = "claim-validator.json";
const TRIAGE_OUT = "pattern-triage.json";

/** The Step 6 skipped-dimension phrasing shared by both note wordings. */
const NOT_ASSESSED_PHRASE = "not assessed this run";

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/**
 * Sub-agent OUT-FILE parses use the shared lenient extraction
 * (`agent-json.ts`), the same rule the dispatcher applies: a prose-prefixed
 * or fence-wrapped payload is an output that exists, and the gate must not
 * call unparseable what the dispatcher parsed (run 29893634730 blocked a
 * conforming submission exactly that way). Code-written inputs (the agent
 * output queue, staged routing) stay on strict {@link parseJson}.
 */
const parseAgentOutFile = (text: string): unknown => extractJsonValue(text);

/**
 * Lowercase and collapse the separator variants (`-`, `_`, `/`) note authors
 * use, so `test-adequacy` matches "test adequacy" and `security-auth`
 * matches "security/auth".
 */
const normalize = (text: string): string =>
    text
        .toLowerCase()
        .replace(/[-_/]+/g, " ")
        .replace(/\s+/g, " ");

/**
 * Note aliases where the Step 6 dimension wording diverges from the
 * sub-agent name. Values are normalized substrings; the default alias is the
 * normalized name itself. `claim valid` covers both the observed production
 * wording ("claim validation not assessed this run (claim-validator output
 * unavailable)", Khan/actions#272) and the planned-shed variant.
 */
const DIMENSION_ALIASES: Record<string, string[]> = {
    "correctness-reviewer": ["correctness"],
    "claim-validator": ["claim valid"],
};

/**
 * Does the review body disclose this dimension as skipped? True when the
 * body carries the Step 6 "not assessed this run" phrasing and names the
 * dimension (either note wording: planned shed or output unavailable).
 */
export const disclosesSkippedDimension = (
    body: string,
    dimension: string,
): boolean => {
    const aliases = DIMENSION_ALIASES[dimension] ?? [normalize(dimension)];
    // The phrase and the dimension must co-occur on one line (the Step 6
    // notes are one line each): matched independently across the whole body,
    // one legitimate note would satisfy the phrase globally and any prose
    // mention of another dimension would then read as its disclosure.
    return body.split("\n").some((line) => {
        const norm = normalize(line);
        return (
            norm.includes(NOT_ASSESSED_PHRASE) &&
            aliases.some((alias) => norm.includes(alias))
        );
    });
};

const resolveDepth = (plan: unknown, notes: string[]): DispatchGateDepth => {
    const depth = (plan as {depth?: unknown} | undefined)?.depth;
    if (
        typeof depth === "string" &&
        (GATE_DEPTHS as readonly string[]).includes(depth)
    ) {
        return depth as DispatchGateDepth;
    }
    notes.push(
        plan === undefined
            ? "rereview plan not staged: rules ran at full depth"
            : "rereview plan depth unrecognized: rules ran at full depth",
    );
    return "full";
};

/** The names routing planned beyond the defaults (strings only, deduped). */
const plannedExtras = (routing: unknown): string[] => {
    const r = routing as
        | {enabledReviewers?: unknown; lensesToSpawn?: unknown}
        | undefined;
    const names = [
        ...(Array.isArray(r?.enabledReviewers) ? r.enabledReviewers : []),
        ...(Array.isArray(r?.lensesToSpawn) ? r.lensesToSpawn : []),
    ].filter((name): name is string => typeof name === "string");
    return [...new Set(names)];
};

/**
 * The one legitimate way a `full`/`scoped` run submits a verdict with no
 * correctness pass: `pattern-triage` ran and returned an empty `reviewFiles`
 * (every changed file was generated / formatting-only / pattern-only), proven
 * by its own staged output.
 */
const triageEmptiedReview = (outFiles: Record<string, string>): boolean => {
    const raw = outFiles[TRIAGE_OUT];
    if (raw === undefined) {
        return false;
    }
    const parsed = parseAgentOutFile(raw) as
        | {reviewFiles?: unknown}
        | undefined;
    return (
        parsed !== undefined &&
        Array.isArray(parsed.reviewFiles) &&
        parsed.reviewFiles.length === 0
    );
};

/** Pure conformance evaluation; the CLI below is its only production caller. */
export const evaluateDispatchConformance = (
    input: DispatchGateInput,
): DispatchGateEvaluation => {
    const notes: string[] = [];
    const violations: DispatchGateViolation[] = [];

    const submit = input.items.find((item) => item.type === SUBMIT_TYPE);
    const verdictEvent =
        submit === undefined
            ? null
            : typeof submit.event === "string"
            ? submit.event
            : "";
    const body =
        submit !== undefined && typeof submit.body === "string"
            ? submit.body
            : "";
    const commentCount = input.items.filter(
        (item) => item.type === COMMENT_TYPE,
    ).length;

    const depth = resolveDepth(input.plan, notes);
    const emptiedByTriage =
        (depth === "full" || depth === "scoped") &&
        triageEmptiedReview(input.outFiles);
    if (emptiedByTriage) {
        notes.push(
            "pattern-triage returned an empty reviewFiles: correctness and planned-roster rules waived",
        );
    }

    // Rule 1: a verdict requires the correctness pass at every depth that
    // dispatches one.
    if (submit !== undefined && depth !== "fast" && !emptiedByTriage) {
        const raw = input.outFiles[CORRECTNESS_OUT];
        if (raw === undefined) {
            violations.push({
                code: "correctness-missing",
                dimension: "correctness-reviewer",
                detail:
                    `verdict ${
                        verdictEvent || "(no event)"
                    } queued but out/${CORRECTNESS_OUT} does not exist ` +
                    `(depth ${depth} dispatches the correctness pass; even a failed dispatch stages an error note)`,
            });
        } else if (
            parseAgentOutFile(raw) === undefined &&
            !disclosesSkippedDimension(body, "correctness-reviewer")
        ) {
            violations.push({
                code: "correctness-unparseable-undisclosed",
                dimension: "correctness-reviewer",
                detail:
                    `out/${CORRECTNESS_OUT} is not valid JSON and the review body carries no ` +
                    `"correctness ${NOT_ASSESSED_PHRASE}" note disclosing the gap`,
            });
        }
    }

    // Rule 2: posted findings require the precision gate, or its disclosed
    // shed (the #258 shed rules permit shedding the validator only near a
    // hard ceiling, and never silently).
    if (commentCount > 0) {
        const raw = input.outFiles[VALIDATOR_OUT];
        const validated =
            raw !== undefined && parseAgentOutFile(raw) !== undefined;
        if (!validated && !disclosesSkippedDimension(body, "claim-validator")) {
            violations.push({
                code: "validator-missing-with-findings",
                dimension: "claim-validator",
                detail:
                    `${commentCount} inline review comment(s) queued but out/${VALIDATOR_OUT} is ` +
                    `${
                        raw === undefined ? "missing" : "unparseable"
                    } and the review body carries no ` +
                    `"claim validation ${NOT_ASSESSED_PHRASE}" note`,
            });
        }
    }

    // Rule 3: dispatched < planned requires a disclosure note per shed name.
    // Only full/scoped plan the extras (flip-gated and fast dispatch fixed
    // rosters, already covered by rule 1).
    if (
        submit !== undefined &&
        (depth === "full" || depth === "scoped") &&
        !emptiedByTriage
    ) {
        if (input.routing === undefined) {
            notes.push(
                "routing not staged: planned-roster rule skipped (the missing correctness pass, rule 1, is what catches a routerless run)",
            );
        } else {
            for (const name of plannedExtras(input.routing)) {
                const dispatched = `${name}.json` in input.outFiles;
                if (!dispatched && !disclosesSkippedDimension(body, name)) {
                    violations.push({
                        code: "shed-undisclosed",
                        dimension: name,
                        detail:
                            `routing planned ${name} but out/${name}.json does not exist and the review body ` +
                            `carries no "${name} ${NOT_ASSESSED_PHRASE}" note`,
                    });
                }
            }
        }
    }

    // Rule 4: an APPROVE cannot carry a blocking inline comment (Step 4 is a
    // mechanical function of the labels: a surviving validated blocking
    // finding means REQUEST_CHANGES at every depth). The inverse direction is
    // legitimate (a REQUEST_CHANGES may ride entirely on kept prior threads),
    // so only the APPROVE direction is enforced.
    if (verdictEvent === "APPROVE") {
        for (const item of input.items) {
            if (item.type !== COMMENT_TYPE || typeof item.body !== "string") {
                continue;
            }
            const label = parseLeadingLabel(item.body);
            if (label !== null && isBlockingLabel(label)) {
                violations.push({
                    code: "approve-with-blocking-comment",
                    dimension: "verdict",
                    detail:
                        `APPROVE queued alongside an inline comment labeled "${label}" ` +
                        `(a surviving blocking finding mechanically requires REQUEST_CHANGES)`,
                });
                break;
            }
        }
    }

    // Rule 5: the re-review flip veto (Step 4, reduced depths only): at
    // flip-gated/fast depth, a prior REQUEST_CHANGES (read from the stamp,
    // not the review state) may flip to APPROVE only when the code-rendered
    // accountability result says every blocking thread was resolved.
    if (
        verdictEvent === "APPROVE" &&
        (depth === "flip-gated" || depth === "fast")
    ) {
        const bodyStamp = Array.isArray(input.priorReviews)
            ? findLatestStamp(
                  // Defensive over agent-writable staged input, like every
                  // sibling parse in this file: a null or non-object element
                  // must not throw (a throw here escapes before the gate
                  // decides and fail-opens ALL rules).
                  input.priorReviews.filter(
                      (review): review is {body: string} =>
                          typeof review === "object" &&
                          review !== null &&
                          typeof (review as {body?: unknown}).body === "string",
                  ),
              )
            : null;
        const priorStamp = bodyStamp ?? stampFromCacheMemory(input.cacheMemory);
        if (priorStamp !== null && priorStamp.verdict === "REQUEST_CHANGES") {
            const kept = (
                input.rereviewAccounting as
                    | {keptBlockingCount?: unknown}
                    | undefined
            )?.keptBlockingCount;
            if (typeof kept === "number" && kept > 0) {
                violations.push({
                    code: "flip-vetoed-kept-blocking",
                    dimension: "verdict",
                    detail:
                        `APPROVE queued at ${depth} depth over a prior REQUEST_CHANGES stamp with ` +
                        `${kept} kept blocking thread(s) (rereview.json keptBlockingCount); the flip rule requires zero`,
                });
            } else if (typeof kept !== "number") {
                notes.push(
                    "flip rule: rereview.json accounting not staged or unparseable (veto not evaluable; fail-open)",
                );
            }
        }
    }

    // Rule 6: every queued thread resolution must be one the reconciler
    // decided. Resolving a thread the reconciler said to keep (or resolving
    // with no reconciler run at all) is the freelancing move this gate
    // exists for. The deficit direction (decided but not queued) is
    // accounting, not a violation: it is reported as a note.
    const queuedResolves = input.items
        .filter((item) => item.type === RESOLVE_TYPE)
        .map((item) =>
            typeof item["thread_id"] === "string" ? item["thread_id"] : "",
        );
    if (queuedResolves.length > 0) {
        const reconciler = parseAgentOutFile(
            input.outFiles[RECONCILER_OUT] ?? "",
        ) as {resolve?: unknown} | undefined;
        const decided = new Set(
            Array.isArray(reconciler?.resolve)
                ? reconciler.resolve.filter(
                      (id): id is string => typeof id === "string",
                  )
                : [],
        );
        for (const threadId of queuedResolves) {
            if (!decided.has(threadId)) {
                violations.push({
                    code: "resolve-not-decided",
                    dimension: "thread-reconciler",
                    detail:
                        `thread resolution queued for "${
                            threadId || "(missing thread_id)"
                        }" but ` +
                        `out/${RECONCILER_OUT} ${
                            reconciler === undefined
                                ? "is missing or unparseable"
                                : "does not list it in resolve"
                        }`,
                });
            }
        }
        const deficit = [...decided].filter(
            (id) => !queuedResolves.includes(id),
        );
        if (deficit.length > 0) {
            notes.push(
                `executed-vs-decided: ${
                    deficit.length
                } reconciler-decided resolution(s) not queued (${deficit.join(
                    ", ",
                )})`,
            );
        }
    }

    // Rule 7 (scripted mode, slice 4): when a submission plan is staged, the
    // queued outputs must match it. gh-aw's ingest sanitizer may neutralize
    // mentions and rewrite disallowed links, so bodies are compared under a
    // normalization that survives it (case, whitespace, backticks, and URL
    // bodies, which the sanitizer may rewrite); anything beyond that is a
    // splice (#244) and blocks. The rule also owns the NO-submission shapes:
    // queued comments with no submit would land as a COMMENT review, and a
    // silently-dropped plan would withhold a REQUEST_CHANGES verdict, so only
    // an APPROVE plan with no comments may legitimately queue nothing (the
    // Step 6 redundant-approval skip).
    const planStaged = input.submissionPlan as
        | {event?: unknown; body?: unknown; comments?: unknown}
        | undefined;
    const normalizeBody = (text: string): string =>
        text
            // The ingest sanitizer deletes ALL XML/HTML comments
            // (removeXmlComments), so the queued body can never carry the
            // plan's fingerprint stamp; comparing modulo comments is what
            // "sanitizer-tolerant" requires (trial run 29893634730 blocked
            // a byte-faithful transcription on exactly this).
            .replace(/<!--[\s\S]*?-->/g, "")
            // The sanitizer's hardenUnicodeText applies NFKC and strips
            // zero-width characters (gh-aw sanitize_content_core.cjs), which
            // rewrites compatibility characters: trial run 29903306596
            // blocked a jq-verbatim emission because one reviewer-authored
            // ellipsis came back as three dots (NFKC). Apply the same
            // normalization on both sides, plus the typographic quote/dash
            // folds NFKC does not cover.
            .normalize("NFKC")
            .replace(/\u034f/g, "")
            .replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
            .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
            .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
            .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
            .toLowerCase()
            .replace(/`/g, "")
            .replace(/https?:\/\/\S+/g, "<url>")
            .replace(/\s+/g, " ")
            .trim();
    if (planStaged !== undefined && submit === undefined) {
        const planComments = Array.isArray(planStaged.comments)
            ? planStaged.comments
            : [];
        if (commentCount > 0) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "verdict",
                detail: `${commentCount} inline comment(s) queued with no review submission (they would land as an ungated COMMENT review); the staged plan requires a ${String(
                    planStaged.event,
                )} submission`,
            });
        } else if (planStaged.event !== "APPROVE" || planComments.length > 0) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "verdict",
                detail: `nothing queued but the staged plan is ${String(
                    planStaged.event,
                )} with ${
                    planComments.length
                } comment(s); only an APPROVE plan with no comments may skip the submission`,
            });
        }
    }
    if (planStaged !== undefined && submit !== undefined) {
        if (
            typeof planStaged.event === "string" &&
            verdictEvent !== planStaged.event
        ) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "verdict",
                detail: `queued event ${
                    verdictEvent || "(none)"
                } does not match the staged submission plan's ${
                    planStaged.event
                }`,
            });
        }
        if (
            typeof planStaged.body === "string" &&
            normalizeBody(body) !== normalizeBody(planStaged.body)
        ) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "review body",
                detail: "queued review body does not match the staged submission plan (normalized comparison)",
            });
        }
        if (Array.isArray(planStaged.comments)) {
            const planned = planStaged.comments
                .filter(
                    (
                        comment,
                    ): comment is {path: string; line: number; body: string} =>
                        typeof (comment as {path?: unknown}).path ===
                            "string" &&
                        typeof (comment as {body?: unknown}).body === "string",
                )
                .map(
                    (comment) =>
                        `${comment.path}:${comment.line}:${normalizeBody(
                            comment.body,
                        )}`,
                )
                .sort();
            const queued = input.items
                .filter((item) => item.type === COMMENT_TYPE)
                .map(
                    (item) =>
                        `${
                            typeof item["path"] === "string" ? item["path"] : ""
                        }:${String(item["line"] ?? "")}:${normalizeBody(
                            typeof item.body === "string" ? item.body : "",
                        )}`,
                )
                .sort();
            if (JSON.stringify(planned) !== JSON.stringify(queued)) {
                violations.push({
                    code: "submission-plan-mismatch",
                    dimension: "inline comments",
                    detail: `queued inline comments (${queued.length}) do not match the staged submission plan (${planned.length})`,
                });
            }
        }
    }

    return {
        conformant: violations.length === 0,
        violations,
        verdictEvent,
        commentCount,
        depth,
        notes,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI: the post-agent gate step                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fixed gh-aw paths (agent job). `AGENT_OUTPUT_PATH` is written by gh-aw's
 * "Ingest agent output" step (a placeholder `{"items":[]}` is guaranteed by
 * "Write agent output placeholder if missing", which precedes post-steps)
 * and uploaded afterwards as the `agent` artifact the `safe_outputs` job
 * executes from. `REPORT_DIR` is `/tmp/gh-aw/agent/`, which the "Upload
 * agent artifacts" step already includes, so the gate report and the
 * pre-gate queue copy ride the run artifact for free.
 */
const AGENT_OUTPUT_PATH = "/tmp/gh-aw/agent_output.json";
const REVIEW_DIR = "/tmp/gh-aw/review";
const OUT_DIR = `${REVIEW_DIR}/out`;
const ROUTING_PATH = `${REVIEW_DIR}/routing.json`;
const PLAN_PATHS = [
    `${REVIEW_DIR}/rereview-plan.json`,
    `${OUT_DIR}/rereview-plan.json`,
];
const REPORT_DIR = "/tmp/gh-aw/agent";
const REPORT_PATH = `${REPORT_DIR}/dispatch-gate.json`;
const PRE_GATE_QUEUE_PATH = `${REPORT_DIR}/agent_output.pre-gate.json`;
/**
 * Written only when a violation was decided. The workflow step fails the job
 * only when this file exists, so an infra failure (npx bootstrap, a crash
 * before the decision) fails open instead of reading as a block.
 */
export const BLOCKED_SENTINEL_PATH = "/tmp/gh-aw/dispatch-gate.blocked";

/**
 * Item types a violated run may still execute: the artifact upload (the
 * evidence a human needs to diagnose the violation) and the non-posting
 * diagnostics. Everything else (the review submission, inline comments,
 * thread resolutions, the risks/patterns comment, reviewer requests, and any
 * type this list has never seen) is stripped: default-deny.
 */
export const KEEP_ITEM_TYPES: ReadonlySet<string> = new Set([
    "upload_artifact",
    "missing_tool",
    "missing_data",
    "noop",
]);

export type DispatchGateFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
    readdirSync: (p: string) => string[];
};

export type DispatchGateReport = DispatchGateEvaluation & {
    gateVersion: 1;
    /** True when the queue was rewritten and the job should fail. */
    blocked: boolean;
    /** `out/` basenames the gate saw (the dispatch evidence). */
    outFilesSeen: string[];
    /** Item types stripped from the queue, with counts (blocked runs). */
    strippedItemTypes: Record<string, number>;
};

const readJsonIfPresent = (fs: DispatchGateFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    return parseJson(fs.readFileSync(path, "utf8"));
};

/**
 * Run the gate over the staged run. Factored out (fs injected) so it is
 * testable without touching the real filesystem. Writes the report always;
 * rewrites the queue only on violation. Returns what it decided.
 */
export const runDispatchGateCli = (fs: DispatchGateFs): DispatchGateReport => {
    const notes: string[] = [];

    const rawQueue = fs.existsSync(AGENT_OUTPUT_PATH)
        ? fs.readFileSync(AGENT_OUTPUT_PATH, "utf8")
        : undefined;
    const queue = rawQueue === undefined ? undefined : parseJson(rawQueue);
    const items: SafeOutputItem[] = Array.isArray(
        (queue as {items?: unknown} | undefined)?.items,
    )
        ? ((queue as {items: unknown[]}).items.filter(
              (item): item is SafeOutputItem =>
                  typeof item === "object" && item !== null,
          ) as SafeOutputItem[])
        : [];
    if (queue === undefined) {
        notes.push(
            `agent output queue missing or unparseable (${AGENT_OUTPUT_PATH}): nothing to gate`,
        );
    }

    const outFiles: Record<string, string> = {};
    if (fs.existsSync(OUT_DIR)) {
        for (const name of fs.readdirSync(OUT_DIR)) {
            try {
                outFiles[name] = fs.readFileSync(`${OUT_DIR}/${name}`, "utf8");
            } catch {
                // A subdirectory or unreadable entry is not dispatch evidence.
            }
        }
    }

    const plan = PLAN_PATHS.map((path) => readJsonIfPresent(fs, path)).find(
        (parsed) => parsed !== undefined,
    );
    const routing = readJsonIfPresent(fs, ROUTING_PATH);
    if (routing === undefined && fs.existsSync(ROUTING_PATH)) {
        notes.push(
            `routing.json is present but unparseable (${ROUTING_PATH}): treated as not staged`,
        );
    }
    const priorReviews = readJsonIfPresent(
        fs,
        `${REVIEW_DIR}/prior-reviews.json`,
    );
    const rereviewAccounting = readJsonIfPresent(
        fs,
        `${REVIEW_DIR}/rereview.json`,
    );
    const submissionPlan = readJsonIfPresent(
        fs,
        `${REVIEW_DIR}/submission-plan.json`,
    );
    const prContext = readJsonIfPresent(fs, `${REVIEW_DIR}/pr-context.json`) as
        | {number?: unknown}
        | undefined;
    const cacheMemory =
        typeof prContext?.number === "number"
            ? readJsonIfPresent(
                  fs,
                  `/tmp/gh-aw/cache-memory/pr-${prContext.number}.json`,
              )
            : undefined;

    const evaluation = evaluateDispatchConformance({
        items,
        plan,
        routing,
        outFiles,
        priorReviews,
        rereviewAccounting,
        submissionPlan,
        cacheMemory,
    });
    evaluation.notes.unshift(...notes);

    const strippedItemTypes: Record<string, number> = {};
    const blocked = !evaluation.conformant;

    // Ordering is the fail-open invariant (module doc): every fallible write
    // before the queue rewrite may throw and leave the original queue intact
    // (the CLI entry then fails open); the queue rewrite comes LAST among the
    // mutating writes, and once `blocked` is decided the CLI's exit code no
    // longer depends on any write succeeding, so a post-rewrite error can
    // never turn a blocked run green.
    const report: DispatchGateReport = {
        gateVersion: 1,
        blocked,
        outFilesSeen: Object.keys(outFiles).sort(),
        strippedItemTypes,
        ...evaluation,
    };
    fs.mkdirSync(REPORT_DIR, {recursive: true});
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    if (blocked && rawQueue !== undefined) {
        const kept = items.filter(
            (item) =>
                typeof item.type === "string" && KEEP_ITEM_TYPES.has(item.type),
        );
        for (const item of items) {
            if (!kept.includes(item)) {
                const type =
                    typeof item.type === "string" ? item.type : "(untyped)";
                strippedItemTypes[type] = (strippedItemTypes[type] ?? 0) + 1;
            }
        }
        // The violation sentinel: the workflow step fails the job only when
        // this file exists, so a crash of the gate BEFORE this point (or of
        // the `npx tsx` bootstrap before the script runs at all) reads as an
        // infra failure and fails open instead of red-flagging the run.
        // Wrapped so a failed write here cannot escape to the entry's
        // fail-open catch with the queue still unstripped: the rewrite below
        // must run whenever `blocked` was decided (worst case is a blocked
        // run whose job stays green — quiet, but the violating queue never
        // posts).
        try {
            fs.writeFileSync(BLOCKED_SENTINEL_PATH, "blocked\n");
            fs.writeFileSync(PRE_GATE_QUEUE_PATH, rawQueue);
        } catch (error) {
            report.notes.push(
                `sentinel/pre-gate write failed (${
                    error instanceof Error ? error.message : String(error)
                }): block still enforced via the queue rewrite`,
            );
        }
        try {
            fs.writeFileSync(
                AGENT_OUTPUT_PATH,
                JSON.stringify(
                    {...(queue as Record<string, unknown>), items: kept},
                    null,
                    2,
                ),
            );
        } catch (error) {
            // A failed rewrite degrades block to detect: the run still goes
            // red (blocked is already decided), but the untouched queue may
            // post. Recorded so the forensics say which mode this run got.
            report.notes.push(
                `queue rewrite failed (${
                    error instanceof Error ? error.message : String(error)
                }): violation detected but the original queue may still post`,
            );
        }
        // Refresh the report with the strip counts and any rewrite note;
        // best-effort (the pre-rewrite report above already persisted).
        try {
            fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
        } catch {
            // The earlier report write already landed.
        }
    }

    return report;
};

/** Markdown for the job step summary; one glance says what happened. */
export const renderGateSummary = (report: DispatchGateReport): string => {
    const lines = [
        "## Dispatch-conformance gate",
        "",
        report.blocked
            ? "**BLOCKED**: the queued review does not conform to the dispatch protocol; every posting safe output was stripped and this job fails."
            : report.verdictEvent === null && report.commentCount === 0
            ? "Nothing to gate (no review submission or inline comments queued)."
            : "Conformant.",
        "",
        `- depth: \`${report.depth}\``,
        `- verdict queued: \`${report.verdictEvent ?? "none"}\``,
        `- inline comments queued: ${report.commentCount}`,
        `- out/ files seen: ${
            report.outFilesSeen.length > 0
                ? report.outFilesSeen.map((name) => `\`${name}\``).join(", ")
                : "none"
        }`,
    ];
    for (const violation of report.violations) {
        lines.push(
            `- **${violation.code}** (${violation.dimension}): ${violation.detail}`,
        );
    }
    for (const note of report.notes) {
        lines.push(`- note: ${note}`);
    }
    return `${lines.join("\n")}\n`;
};

// Run only when executed directly (review.md post-steps), never on import
// (tests). Fail-open ONLY on errors thrown before the gate decided (the
// queue is then untouched, by the write ordering in runDispatchGateCli);
// once `blocked` is decided, the exit code depends on nothing else — a
// failed report write or step-summary append can never turn a blocked run
// green.
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs") as DispatchGateFs & {
        appendFileSync: (p: string, data: string) => void;
    };
    let report: DispatchGateReport;
    try {
        report = runDispatchGateCli(nodeFs);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.log(
            `::warning title=dispatch-conformance gate::gate errored before deciding (fail-open, review not blocked): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        process.exit(0);
    }
    // Reporting is best-effort and must not affect the exit code in either
    // direction.
    try {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (summaryPath !== undefined && summaryPath !== "") {
            nodeFs.appendFileSync(summaryPath, renderGateSummary(report));
        }
    } catch {
        // The report file and stdout above are redundant surfaces; losing
        // one changes nothing about the verdict on this run.
    }
    if (report.blocked) {
        for (const violation of report.violations) {
            // eslint-disable-next-line no-console
            console.error(
                `::error title=dispatch-conformance gate::${violation.code} (${violation.dimension}): ${violation.detail}`,
            );
        }
        // eslint-disable-next-line no-console
        console.error(
            `::error title=dispatch-conformance gate::review submission blocked; original queue preserved at ${PRE_GATE_QUEUE_PATH} (agent artifact), report at ${REPORT_PATH}`,
        );
        process.exit(1);
    }
}
