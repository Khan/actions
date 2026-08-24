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
 * What it refuses to write: anything it cannot corroborate. The record is
 * only written when the staged plan and the in-run safe-output queue
 * (`GH_AW_SAFE_OUTPUTS`, the JSONL the safeoutputs MCP appends as the
 * orchestrator emits) agree and the staged diff facts are present; on any
 * doubt the previous run's record survives untouched, which degrades the next
 * run toward a fuller review, never a cheaper one. An UNREADABLE queue is
 * doubt too, and refuses: the dispatch-conformance gate that would red a
 * divergent emission runs on the post-ingest `agent_output.json`, after
 * cache-memory has been committed, so it cannot vouch for this record. The
 * single exception is the shape that legitimately queues nothing at all (the
 * Step 6 redundant-approval skip: an APPROVE plan with zero comments), where
 * the two queue-derived supplements (risksPatternsKey adoption,
 * requestedTeams growth) degrade to carry-forward. Note the same seam the
 * model-written record always had: the cache is committed before the gate
 * runs, so a gate-blocked run's record can persist either way; the divergence
 * tripwire's full-review re-arm is the backstop.
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
            // Parse per line: one malformed entry (a truncated tail from a
            // crash mid-append) must not discard the whole queue. A skipped
            // line can only remove corroborating evidence, so the failure
            // direction stays a refusal to write, never a false write.
            const items = fs
                .readFileSync(queuePath, "utf8")
                .split("\n")
                .filter((line) => line.trim() !== "")
                .flatMap((line) => {
                    try {
                        return [JSON.parse(line) as unknown];
                    } catch {
                        return [];
                    }
                })
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
 * each medium/high-risk file its path and owning teams, for each common
 * pattern its identity and the sorted file set it covers, the sorted
 * excluded-file set, plus `notified.json`'s own signature, all sorted into
 * one stable string. Both sides of the repost decision, the compare (Step 7
 * reads the staged copy) and the record (this writer), use THIS function, so
 * "unchanged" can never be an artifact of two composers wording the same
 * guidance differently.
 *
 * The NOTIFIED match set is a component because Step 7 posts ONE Review
 * Guidance comment covering risks, patterns, and notifications: a run where
 * only the NOTIFIED matches changed still has to re-post, and a key that
 * omitted them would read as unchanged and silently swallow the new
 * mentions.
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
    /** `notified.json` `signature`: the canonical NOTIFIED match set. */
    notifiedSignature?: unknown;
}): string => {
    const owners = isRecord(input.owners) ? input.owners : {};
    const entries: string[] = [];
    for (const file of Array.isArray(input.riskFiles) ? input.riskFiles : []) {
        if (!isRecord(file) || typeof file["path"] !== "string") {
            continue;
        }
        const risk =
            typeof file["risk"] === "string" ? file["risk"].toLowerCase() : "";
        // The triage contract's tier vocabulary is Trivial/Low/Medium/High
        // (review.md `files[]`, RISK_TIERS); "moderate" is tolerated because
        // the surrounding prose uses it and a drifted emitter must fail
        // toward a fuller signature, not a silently narrower one.
        if (risk !== "medium" && risk !== "moderate" && risk !== "high") {
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
    if (
        typeof input.notifiedSignature === "string" &&
        input.notifiedSignature !== ""
    ) {
        entries.push(`notified:${input.notifiedSignature}`);
    }
    return entries.sort().join("|");
};

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

export type CacheRecordResult = {
    written: boolean;
    reason: string;
    /**
     * Set on refusals that indicate something WRONG (a corroboration
     * mismatch, missing staged facts), as opposed to the benign no-ops
     * (a gate-blocked run, a run that ended before the plan). The CLI
     * surfaces these as `::warning`:
     * a systematic refusal permanently stales the fingerprint and forces
     * full-depth reviews indefinitely, which must not stay invisible.
     */
    warn?: boolean;
    record?: Record<string, unknown>;
};

const skip = (reason: string): CacheRecordResult => ({written: false, reason});

const refuse = (reason: string): CacheRecordResult => ({
    written: false,
    reason,
    warn: true,
});

/**
 * Shared compensation for a run whose only post was a standalone PR comment
 * (the hold disclosure, or the dispatcher-death notice): `hide-older-comments`
 * makes that comment collapse the standing risks/patterns guidance comment,
 * and the next approving run would read the unchanged `risksPatternsKey` as
 * "guidance already posted" and never restore it. Dropping the key makes
 * that run repost the guidance; everything else in the prior record carries
 * verbatim (fingerprints untouched, so the next run reviews in full).
 */
const dropRisksPatternsKey = (
    fs: CacheRecordFs,
    cause: "hold" | "dispatcher-death",
): CacheRecordResult => {
    const pr = readJson(fs, `${REVIEW_DIR}/pr-context.json`) as
        | {number?: unknown}
        | undefined;
    if (typeof pr?.number !== "number") {
        return skip(`${cause}: no pr-context, nothing to update`);
    }
    const recordPath = `${CACHE_MEMORY_DIR}/pr-${pr.number}.json`;
    const prior = readJson(fs, recordPath);
    if (!isRecord(prior) || !("risksPatternsKey" in prior)) {
        return skip(
            `${cause}: no prior record or no risksPatternsKey to drop; the prior record stands`,
        );
    }
    const {risksPatternsKey: _, ...kept} = prior;
    fs.mkdirSync(CACHE_MEMORY_DIR, {recursive: true});
    fs.writeFileSync(recordPath, JSON.stringify(kept, null, 2));
    return {
        written: true,
        reason: `${cause}: dropped risksPatternsKey from ${recordPath} (the ${cause} comment collapsed the standing guidance comment); fingerprints untouched`,
        record: kept,
    };
};

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
        // Almost every no-plan shape is a run that died before posting
        // anything, and the benign skip below is right for those. ONE
        // no-plan shape posts: the dispatcher-death notice (review.md Step
        // 3, `dispatch-result.json` missing after the dispatcher call) is a
        // standalone add-comment queued with no plan staged at all, and it
        // collapses the standing guidance comment exactly like a hold
        // comment does, so the same compensation must run. Corroboration is
        // the full death shape, not just the queued add_comment: the branch
        // also requires `dispatch-result.json` absent and no queued review
        // submission, so a run that reviewed normally but lost its plan
        // cannot be misread as a death. With no plan asserting a comment
        // SHOULD have queued, an unreadable queue is indistinguishable from
        // an ordinary early death, so that stays the benign skip rather
        // than the hold branch's loud refusal.
        if (!fs.existsSync(BLOCKED_SENTINEL_PATH)) {
            const {items: deathItems, readable: deathReadable} = readQueue(
                fs,
                queuePath,
            );
            if (
                deathReadable &&
                !fs.existsSync(`${REVIEW_DIR}/dispatch-result.json`) &&
                !deathItems.some(
                    (item) => item["type"] === "submit_pull_request_review",
                ) &&
                deathItems.some((item) => item["type"] === "add_comment")
            ) {
                return dropRisksPatternsKey(fs, "dispatcher-death");
            }
        }
        return skip(
            "no submission plan staged (the run ended before the plan): the cache write stays with the orchestrator",
        );
    }
    if (fs.existsSync(BLOCKED_SENTINEL_PATH)) {
        return skip(
            "the dispatch-conformance gate blocked this run: nothing posted, the prior record stands",
        );
    }
    if (plan.event === "HOLD_FOR_HUMAN") {
        // A hold reviewed nothing (its core lenses produced no output), so
        // the fingerprints/verdict of the prior record stand untouched and
        // the next run reviews in full. ONE field does change:
        // `risksPatternsKey`, dropped by the shared helper below (see
        // `dropRisksPatternsKey`'s doc for why). Everything else carries
        // verbatim.
        const {items: holdItems, readable: holdReadable} = readQueue(
            fs,
            queuePath,
        );
        if (!holdReadable) {
            // Mirror the review-event path's corroboration refusal: an
            // unreadable queue means nothing proves the hold comment
            // posted, and a silent skip here would leave a stale
            // risksPatternsKey failure invisible.
            return refuse(
                "hold plan but no readable safe-output queue, so nothing corroborates the hold comment: the prior record stands",
            );
        }
        const holdCommentQueued = holdItems.some(
            (item) => item["type"] === "add_comment",
        );
        if (!holdCommentQueued) {
            return skip(
                "hold plan with no queued hold comment: the prior record stands untouched",
            );
        }
        return dropRisksPatternsKey(fs, "hold");
    }
    if (plan.event !== "APPROVE" && plan.event !== "REQUEST_CHANGES") {
        return refuse("the staged plan carries no submittable event");
    }

    // The queued submission must corroborate the plan (the gate enforces the
    // full match; this is the writer's own refusal to record a review that
    // never queued). The one legitimate no-submission shape is the Step 6
    // redundant-approval skip: an APPROVE plan with zero comments, which
    // queues nothing at all, and so leaves no queue file to read in the
    // agent step.
    //
    // Every other shape needs a readable queue. The gate that would red a
    // divergent emission runs on the post-ingest agent_output.json, AFTER
    // cache-memory has been committed and uploaded, so it cannot protect this
    // record: writing on an unreadable queue would let a run whose emission
    // silently failed record "review posted" with the current fingerprints,
    // and the next run would then stamp against an unreviewed diff. Refusing
    // keeps the failure pointed at a fuller next review, the only direction
    // this module fails in.
    const {items, readable} = readQueue(fs, queuePath);
    const redundantApproval =
        plan.event === "APPROVE" &&
        (Array.isArray(plan.comments) ? plan.comments : []).length === 0;
    if (readable) {
        const submit = items.find(
            (item) => item["type"] === "submit_pull_request_review",
        );
        if (submit === undefined) {
            if (!redundantApproval) {
                return refuse(
                    "no review submission queued and the plan is not the redundant-approval shape: the prior record stands",
                );
            }
        } else if (submit["event"] !== plan.event) {
            return refuse(
                "the queued submission does not match the staged plan: the prior record stands",
            );
        }
    } else if (!redundantApproval) {
        return refuse(
            "no readable safe-output queue, so nothing corroborates that the review posted: the prior record stands",
        );
    }

    const prContext = readJson(fs, `${REVIEW_DIR}/pr-context.json`) as
        | {number?: unknown; headSha?: unknown; isDraft?: unknown}
        | undefined;
    if (typeof prContext?.number !== "number") {
        return refuse("pr-context.json is not staged: no record path to write");
    }
    const diffFacts = readJson(fs, `${REVIEW_DIR}/diff-facts.json`) as
        | {diffFingerprint?: unknown; hunkSignature?: unknown}
        | undefined;
    if (
        !isRecord(diffFacts?.diffFingerprint) ||
        !isRecord(diffFacts?.hunkSignature)
    ) {
        return refuse(
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
            : `wrote ${recordPath} (redundant-approval skip: nothing queued, supplements carried forward)`,
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
        if (result.warn === true) {
            // A refusal that is not one of the benign no-ops must reach the
            // workflow UI: a systematic corroboration mismatch would stale
            // the fingerprint on every run (permanent full-depth reviews)
            // with nothing visible in the logs summary otherwise.
            // eslint-disable-next-line no-console
            console.error(
                `::warning title=review cache record::refused to write: ${result.reason}`,
            );
        }
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
            `::warning title=review cache record::${
                error instanceof Error ? error.message : String(error)
            } (cache record unchanged)`,
        );
    }
}
