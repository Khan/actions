/**
 * The deterministic Step 9 cache-memory writer (trial suggestion b): in
 * scripted dispatch mode, the cache record (the divergence tripwire's
 * fingerprint carrier since the body stamp stopped surviving gh-aw's ingest
 * sanitizer, #287) is written by code, not serialized from
 * the orchestrator's memory. A model transcription slip in `stampHunks` or
 * `reviewedHunks` silently degrades every later run to a full review (the
 * carrier hashes are compared hash-for-hash), and the write itself cost
 * orchestrator turns that re-read the whole conversation.
 *
 * Where it runs: invoked by the orchestrator as ONE Bash call at Step 9,
 * inside the agent step, right after the safe outputs are emitted. It
 * cannot be a `post-step`: gh-aw's compiled agent job commits and uploads
 * `/tmp/gh-aw/cache-memory` (the `cache-memory` artifact the
 * `update_cache_memory` job persists) BEFORE post-steps run, so a post-step
 * write never reaches the saved cache; the write has to land where the
 * model's own Step 9 Write-tool call landed. Task mode is untouched: with
 * no staged submission plan the writer no-ops and the orchestrator's Step 9
 * write stands.
 *
 * What it refuses to write: anything it cannot corroborate. When the
 * in-run safe-output queue (`GH_AW_SAFE_OUTPUTS`, the JSONL the safeoutputs
 * MCP appends as the orchestrator emits) is readable, the record is only
 * written when the staged plan and the queued submission agree (or the
 * queue is legitimately empty: the Step 6 redundant-approval skip) and the
 * staged diff facts are present; on any doubt the previous run's record
 * survives untouched, which degrades the next run toward a fuller review,
 * never a cheaper one. When the queue is NOT readable, the plan alone is
 * trusted (the dispatch-conformance gate reds any run whose emission
 * diverges from the plan) and the two queue-derived supplements
 * (risksPatternsKey adoption, requestedTeams growth) degrade to
 * carry-forward. Note the same seam the model-written record always had:
 * the cache is committed before the gate runs, so a gate-blocked run's
 * record can persist either way; the divergence tripwire's full-review
 * re-arm is the backstop.
 *
 * `risksPatternsKey` is code-computed here too ({@link
 * computeRisksPatternsKey}): the submission CLI stages the canonical
 * signature for Step 7's compare, and this writer records it when the
 * guidance comment was actually queued, so the posting decision and the
 * cache agree on one code-owned format.
 *
 * Determinism boundary: pure serialization of staged files and the queue;
 * no model call, no prose about the code under review.
 */

/* -------------------------------------------------------------------------- */
/* Paths and seams                                                            */
/* -------------------------------------------------------------------------- */

const REVIEW_DIR = "/tmp/gh-aw/review";
const CACHE_MEMORY_DIR = "/tmp/gh-aw/cache-memory";
const AGENT_OUTPUT_PATH = "/tmp/gh-aw/agent_output.json";
const BLOCKED_SENTINEL_PATH = "/tmp/gh-aw/dispatch-gate.blocked";

export const RISKS_PATTERNS_KEY_PATH = `${REVIEW_DIR}/risks-patterns-key.txt`;

export type CacheRecordFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (fs: CacheRecordFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/**
 * The safe-output queue, best-effort: the in-run JSONL (`GH_AW_SAFE_OUTPUTS`)
 * when the env names a readable file, else the post-ingest
 * `agent_output.json` (present when this runs after ingest, e.g. in a
 * replay), else unreadable. Item types are normalized to underscores: the
 * MCP tool names and the ingested queue both use them, but a hyphenated
 * variant must not silently defeat corroboration.
 */
const readQueue = (
    fs: CacheRecordFs,
    queuePath: string | undefined,
): {items: Record<string, unknown>[]; readable: boolean} => {
    const normalize = (raw: Record<string, unknown>): Record<string, unknown> =>
        typeof raw["type"] === "string"
            ? {...raw, type: raw["type"].replace(/-/g, "_")}
            : raw;
    if (queuePath !== undefined && fs.existsSync(queuePath)) {
        try {
            const items = fs
                .readFileSync(queuePath, "utf8")
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as unknown)
                .filter(isRecord)
                .map(normalize);
            return {items, readable: true};
        } catch {
            // Fall through to the ingested queue.
        }
    }
    const ingested = readJson(fs, AGENT_OUTPUT_PATH) as
        | {items?: unknown}
        | undefined;
    if (Array.isArray(ingested?.items)) {
        return {
            items: ingested.items.filter(isRecord).map(normalize),
            readable: true,
        };
    }
    return {items: [], readable: false};
};

/* -------------------------------------------------------------------------- */
/* The canonical risks/patterns signature                                     */
/* -------------------------------------------------------------------------- */

/**
 * Step 7's canonical signature of the risks/patterns guidance, as code: for
 * each moderate/high-risk file its path and owning teams, for each common
 * pattern its identity and the sorted file set it covers, plus the sorted
 * excluded-file set, all sorted into one stable string. Both sides of the
 * repost decision, the compare (Step 7 reads the staged copy) and the
 * record (this writer), use THIS function, so "unchanged" can never be an
 * artifact of two composers wording the same guidance differently.
 *
 * Tolerant of the triage contract's looseness: a pattern may be a bare
 * string or an object naming its files; unknown shapes contribute their
 * JSON so a real change is never invisible.
 */
export const computeRisksPatternsKey = (input: {
    riskFiles?: unknown;
    patterns?: unknown;
    excludedFiles?: unknown;
    /** `routing.json` `teams.owners`: path -> owning team list. */
    owners?: unknown;
}): string => {
    const owners = isRecord(input.owners) ? input.owners : {};
    const entries: string[] = [];
    for (const file of Array.isArray(input.riskFiles) ? input.riskFiles : []) {
        if (!isRecord(file) || typeof file["path"] !== "string") {
            continue;
        }
        const risk =
            typeof file["risk"] === "string" ? file["risk"].toLowerCase() : "";
        if (risk !== "moderate" && risk !== "high") {
            continue;
        }
        const teams = Array.isArray(owners[file["path"]])
            ? (owners[file["path"]] as unknown[])
                  .filter((team): team is string => typeof team === "string")
                  .sort()
            : [];
        entries.push(`risk:${file["path"]}=${teams.join("+")}`);
    }
    for (const pattern of Array.isArray(input.patterns) ? input.patterns : []) {
        if (typeof pattern === "string") {
            entries.push(`pattern:${pattern}=`);
            continue;
        }
        if (isRecord(pattern)) {
            const name = ["pattern", "description", "name"]
                .map((key) => pattern[key])
                .find((value): value is string => typeof value === "string");
            const files = Array.isArray(pattern["files"])
                ? pattern["files"]
                      .filter(
                          (file): file is string => typeof file === "string",
                      )
                      .sort()
                : [];
            entries.push(
                `pattern:${name ?? JSON.stringify(pattern)}=${files.join(",")}`,
            );
            continue;
        }
        entries.push(`pattern:${JSON.stringify(pattern)}=`);
    }
    for (const excluded of Array.isArray(input.excludedFiles)
        ? input.excludedFiles
        : []) {
        if (typeof excluded === "string") {
            entries.push(`excluded:${excluded}`);
        }
    }
    return entries.sort().join("|");
};

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

export type CacheRecordResult = {
    written: boolean;
    reason: string;
    record?: Record<string, unknown>;
};

const skip = (reason: string): CacheRecordResult => ({written: false, reason});

/**
 * Write the Step 9 cache record from staged truth. `nowIso` is injected so
 * the builder stays a pure function of its inputs in tests; `queuePath` is
 * the in-run safe-output JSONL (`GH_AW_SAFE_OUTPUTS`).
 */
export const runCacheRecordCli = (
    fs: CacheRecordFs,
    nowIso: string,
    queuePath?: string,
): CacheRecordResult => {
    const plan = readJson(fs, `${REVIEW_DIR}/submission-plan.json`) as
        | {event?: unknown; comments?: unknown}
        | undefined;
    if (plan === undefined) {
        return skip(
            "no submission plan staged (task mode, or the run ended before the plan): the cache write stays with the orchestrator",
        );
    }
    if (fs.existsSync(BLOCKED_SENTINEL_PATH)) {
        return skip(
            "the dispatch-conformance gate blocked this run: nothing posted, the prior record stands",
        );
    }
    if (plan.event !== "APPROVE" && plan.event !== "REQUEST_CHANGES") {
        return skip("the staged plan carries no submittable event");
    }

    // When the queue is readable, the queued submission must corroborate
    // the plan (the gate enforces the full match; this is the writer's own
    // refusal to record a review that never queued). The one legitimate
    // no-submission shape is the Step 6 redundant-approval skip: an APPROVE
    // plan with zero comments. An unreadable queue trusts the plan alone
    // (the gate reds any run whose emission diverges from it).
    const {items, readable} = readQueue(fs, queuePath);
    if (readable) {
        const submit = items.find(
            (item) => item["type"] === "submit_pull_request_review",
        );
        if (submit === undefined) {
            const planComments = Array.isArray(plan.comments)
                ? plan.comments
                : [];
            if (plan.event !== "APPROVE" || planComments.length > 0) {
                return skip(
                    "no review submission queued and the plan is not the redundant-approval shape: the prior record stands",
                );
            }
        } else if (submit["event"] !== plan.event) {
            return skip(
                "the queued submission does not match the staged plan: the prior record stands",
            );
        }
    }

    const prContext = readJson(fs, `${REVIEW_DIR}/pr-context.json`) as
        | {number?: unknown; headSha?: unknown; isDraft?: unknown}
        | undefined;
    if (typeof prContext?.number !== "number") {
        return skip("pr-context.json is not staged: no record path to write");
    }
    const diffFacts = readJson(fs, `${REVIEW_DIR}/diff-facts.json`) as
        | {diffFingerprint?: unknown; hunkSignature?: unknown}
        | undefined;
    if (
        !isRecord(diffFacts?.diffFingerprint) ||
        !isRecord(diffFacts?.hunkSignature)
    ) {
        return skip(
            "diff-facts.json is missing or unparseable: a record without trustworthy fingerprints would poison the next run's scoping",
        );
    }

    const rereviewPlan = readJson(fs, `${REVIEW_DIR}/rereview-plan.json`) as
        | {stampHunks?: unknown}
        | undefined;
    const dispatch = readJson(fs, `${REVIEW_DIR}/dispatch-result.json`) as
        | {claims?: unknown; riskFiles?: unknown}
        | undefined;
    const issuesFlagged = (
        Array.isArray(dispatch?.claims) ? dispatch.claims : []
    )
        .filter(isRecord)
        .map((claim) => ({
            ...(typeof claim["path"] === "string" ? {path: claim["path"]} : {}),
            ...(typeof claim["line"] === "number" ? {line: claim["line"]} : {}),
            label: claim["label"],
            subject: claim["subject"],
        }));

    // Carried fields: the two Step 7/8 supplements, from the record as it
    // stands (the restored prior record). Nothing else survives:
    // the mechanical fields below are re-derived from staged truth every run.
    const recordPath = `${CACHE_MEMORY_DIR}/pr-${prContext.number}.json`;
    const prior = readJson(fs, recordPath);
    const carried = isRecord(prior) ? prior : {};

    // risksPatternsKey: adopt the staged code-computed signature when the
    // guidance comment was actually queued this run; otherwise the guidance
    // on the PR is unchanged and the prior key carries forward.
    const commentQueued = items.some((item) => item["type"] === "add_comment");
    const stagedKey = fs.existsSync(RISKS_PATTERNS_KEY_PATH)
        ? fs.readFileSync(RISKS_PATTERNS_KEY_PATH, "utf8").trim()
        : undefined;
    const risksPatternsKey =
        commentQueued && stagedKey !== undefined
            ? stagedKey
            : typeof carried["risksPatternsKey"] === "string"
            ? carried["risksPatternsKey"]
            : undefined;

    // requestedTeams: the cumulative union of the prior record and the
    // team reviewers queued this run (`add_reviewer` `team_reviewers`).
    const requestedTeams = new Set<string>(
        Array.isArray(carried["requestedTeams"])
            ? carried["requestedTeams"].filter(
                  (team): team is string => typeof team === "string",
              )
            : [],
    );
    for (const item of items) {
        if (item["type"] !== "add_reviewer") {
            continue;
        }
        for (const team of Array.isArray(item["team_reviewers"])
            ? item["team_reviewers"]
            : []) {
            if (typeof team === "string" && team !== "") {
                requestedTeams.add(team);
            }
        }
    }

    const record: Record<string, unknown> = {
        timestamp: nowIso,
        ...(typeof prContext.headSha === "string"
            ? {commitSha: prContext.headSha}
            : {}),
        verdict: plan.event,
        filesReviewed: Array.isArray(dispatch?.riskFiles)
            ? dispatch.riskFiles
            : [],
        issuesFlagged,
        diffFingerprint: diffFacts.diffFingerprint,
        reviewedHunks: diffFacts.hunkSignature,
        ...(isRecord(rereviewPlan?.stampHunks)
            ? {stampHunks: rereviewPlan.stampHunks}
            : {}),
        wasDraft: prContext.isDraft === true,
        ...(risksPatternsKey !== undefined ? {risksPatternsKey} : {}),
        ...(requestedTeams.size > 0
            ? {requestedTeams: [...requestedTeams].sort()}
            : {}),
    };
    fs.mkdirSync(CACHE_MEMORY_DIR, {recursive: true});
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    return {
        written: true,
        reason: readable
            ? `wrote ${recordPath}`
            : `wrote ${recordPath} (safe-output queue unreadable: plan trusted, supplements carried forward)`,
        record,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                  */
/* -------------------------------------------------------------------------- */

// Run only when executed directly (review.md Step 9, scripted dispatch
// mode), never on import (tests). Never exits non-zero: on any doubt the
// prior record simply stands, and a crash here must not derail a run whose
// review already queued.
if (typeof require !== "undefined" && require.main === module) {
    const nodeFs = require("node:fs") as CacheRecordFs;
    try {
        const result = runCacheRecordCli(
            nodeFs,
            new Date().toISOString(),
            process.env.GH_AW_SAFE_OUTPUTS,
        );
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify(
                {written: result.written, reason: result.reason},
                null,
                2,
            ),
        );
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
            `::warning title=review cache record::${
                error instanceof Error ? error.message : String(error)
            } (cache record unchanged)`,
        );
    }
}
