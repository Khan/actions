/**
 * The submission plan (deterministic-orchestrator slice 4, the probe): Steps
 * 4-6 as code. Given the dispatcher's validated claims (slice 2), this CLI
 * computes the verdict, renders every inline comment and the full review
 * body (accountability section, note lines, fingerprint stamp), and stages
 * `submission-plan.json`; the orchestrator's remaining job is to emit safe
 * outputs that match the plan verbatim, and the dispatch-conformance gate
 * blocks a submission that does not (the #244 accountability-splice check,
 * as code).
 *
 * This is the end-state shape the migration plan names (the no-post runner's
 * pipeline in production): staging (slice 1) → dispatch/validation (slice 2)
 * → verdict/render/plan (here) → emit → gate. What remains model work is the
 * sub-agents themselves plus the safe-output EMISSION, and the reason is a
 * filesystem permission, not a credential: queueing a safe output is an
 * append to `$GH_AW_SAFE_OUTPUTS`
 * (`${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl`) and needs no token at
 * queue time (the credentialed posting is the later `safe_outputs` job).
 * What this CLI cannot do is write that file: the agent sandbox mounts
 * `${RUNNER_TEMP}/gh-aw` read-only (`awf --mount ...:ro` in the compiled
 * lock; only `safeoutputs/upload-artifacts` is rw), while the safeoutputs
 * MCP container gets `safeoutputs/` read-write. So the seam is real today
 * but likely cheaper to delete than the plan doc's Q1 note recorded: it
 * wants a writable path into the queue: an upstream mount/ingest change,
 * or a repo-controlled post-agent step writing the ingested queue on the
 * host the way this workflow's gate already rewrites it. Untested either
 * way; until one is proven the orchestrator is a typist for MCP calls, and
 * the gate makes mis-typing a red run.
 *
 * Verdict rules encoded (review.md Step 4, mechanically):
 *   - Claims anchored on a line in the reconciler's `skipLines` are dropped
 *     first (Step 5's defer-to-open-human-threads rule), so they neither
 *     post nor count toward the verdict.
 *   - REQUEST_CHANGES iff at least one posted claim carries a blocking label
 *     (via computeVerdict, threshold 1).
 *   - HOLD_FOR_HUMAN when a core review pass (`correctness-reviewer` or
 *     `skill-auditor`) produced no output this run and the run would
 *     otherwise have auto-approved (computeVerdict's core-dimension gate,
 *     fed from the dispatcher's `skippedDimensions`). A hold is not a
 *     review event: the plan's body posts as one standalone PR comment,
 *     nothing else queues, and no fingerprint stamp is written, so the
 *     next run reviews in full. The production shape this closes:
 *     Khan/actions#328's re-run (31124365377 attempt 2), where every core
 *     lens died on an API auth error and the run still submitted
 *     "Approved — no blocking issues found" over seven "not assessed"
 *     note lines.
 *   - The reduced-depth flip rule: at flip-gated/fast depth over a prior
 *     REQUEST_CHANGES stamp, `rereview.json`'s keptBlockingCount floors the
 *     verdict at REQUEST_CHANGES.
 *
 * Body rules encoded (review.md Step 6): the verdict head (empty-body
 * APPROVE with comments; the fixed REQUEST_CHANGES line), the code-rendered
 * accountability section spliced verbatim, one note line per shed / skipped
 * dimension / depth reduction (the dispatcher already rendered those), any
 * PR-level claims folded into the body (the inline-comment safe output needs
 * a path and line), and the collapsed fingerprint stamp as the final block
 * (a `<details>` wrapper, sanitizer-surviving; see renderRereviewStamp).
 *
 * Determinism boundary: pure composition of staged files through the same
 * lib functions the eval runner uses; no model call, no prose about the code
 * under review.
 */

import {escapeHtml, renderAttributionFooter} from "./attribution";
import {computeRisksPatternsKey, RISKS_PATTERNS_KEY_PATH} from "./cache-record";
import type {Claim} from "./dispatch-contracts";
import {applyMediumVeto} from "./dispatch-contracts";
import {computeChangedLines} from "./diff";
import {DEFAULT_FINDERS, TRIAGE_DIMENSION} from "./dispatch-roster";
import {runCli as runNotifiedCli} from "./notified";
import {
    HOLD_HEAD,
    HOLD_UNSTUCK_LINES,
    isBlockingLabel,
    NITPICK_LABEL,
    renderReviewBody,
} from "./render-comment";
import {DEFAULT_NON_BLOCKING_INLINE_BUDGET} from "./routing-config";
import {runRereviewCli, type RereviewCliFs} from "./rereview";
import {
    labelToken,
    renderClaimComment,
    renderCollapsedLine,
    renderPrLevelFold,
} from "./submission-render";
import {normalizeBody} from "./sanitizer-normalize";
import {
    findLatestStamp,
    runRereviewStampCli,
    stampFromCacheMemory,
    type PriorReview,
} from "./rereview-mode";
import {computeVerdict} from "./verdict";
import type {DimensionStatus, VerdictReason} from "./verdict";
import {runVersionFooterCli} from "./version-footer";

/* -------------------------------------------------------------------------- */
/* Types and paths                                                            */
/* -------------------------------------------------------------------------- */

const REVIEW_DIR = "/tmp/gh-aw/review";
const CACHE_MEMORY_DIR = "/tmp/gh-aw/cache-memory";

export type PlannedComment = {path: string; line: number; body: string};

/**
 * Size accounting for what this plan posts, staged with the plan so a
 * render-path change that moves body sizes is visible in the first runs'
 * artifacts. The motivating gap is PRA-46: the v1.8.0 task-mode removal
 * shipped a +60% median-body step (557 -> 889 chars across webapp's
 * v1.7.0 -> v1.11.0 bump) with no changelog entry, and the detection
 * mechanism was a by-version audit four versions later. Measured over the
 * final comment bodies (footer and collapsed-section rides included), so
 * it counts what the author actually sees.
 */
export type PlanBodyStats = {
    /** Inline comments in the plan. */
    comments: number;
    /** Median rendered comment body length, chars (0 when none post). */
    medianChars: number;
    /** 90th-percentile comment body length, chars (nearest-rank). */
    p90Chars: number;
    /** Longest comment body, chars. */
    maxChars: number;
    /** Sum over all comment bodies, chars. */
    totalChars: number;
    /** The review (or hold) body's length, chars. */
    bodyChars: number;
};

export type SubmissionPlan = {
    /**
     * The outcome: a review event to submit (Step 4's mechanical rule), or
     * HOLD_FOR_HUMAN, which submits NO review — the orchestrator posts
     * `body` as one standalone PR comment instead (Step 6's hold branch).
     */
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES" | "HOLD_FOR_HUMAN";
    /**
     * The full text to post verbatim: the review body (stamp included) for
     * a review event, or the hold comment (never stamped) for a hold.
     */
    body: string;
    /**
     * Whether the orchestrator may emit NO submission at all (the
     * redundant-approval skip). Code-owned so review.md's Step 6 and the
     * dispatch-conformance gate read one predicate rather than each
     * describing it: true only for an APPROVE plan with no inline comments
     * whose body is the bare approve line (modulo the ingest sanitizer) on a
     * PR whose last stamped verdict was already APPROVE.
     */
    skipSubmission: boolean;
    /** The inline comments to post, one safe output each, verbatim. */
    comments: PlannedComment[];
    /** Thread ids to resolve (the reconciler's decision, passed through). */
    resolve: string[];
    /** Why the event is what it is (fixed-format, for the artifact). */
    reasons: VerdictReason[];
    /** Non-blocking composition observations. */
    notes: string[];
    /** Posted-size accounting (artifact-only; nothing gates on it). */
    bodyStats: PlanBodyStats;
};

export type SubmissionFs = RereviewCliFs;

/**
 * The reconciler's open-human-thread lines as `path:line` keys (review.md
 * Step 5's "defer to open human threads"). Anything unparseable is dropped:
 * the filter degrades to posting, never to a crash.
 */
const parseSkipLines = (raw: unknown): Set<string> => {
    const keys = new Set<string>();
    if (!Array.isArray(raw)) {
        return keys;
    }
    for (const entry of raw) {
        const {path, line} = (entry ?? {}) as {path?: unknown; line?: unknown};
        if (typeof path === "string" && typeof line === "number") {
            keys.add(`${path}:${line}`);
        }
    }
    return keys;
};

/** Nearest-rank percentile of an ascending-sorted list (0 when empty). */
const percentile = (sorted: number[], p: number): number =>
    sorted.length === 0
        ? 0
        : sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

/** Compute {@link PlanBodyStats} from the plan's final rendered text. */
export const computeBodyStats = (
    comments: PlannedComment[],
    body: string,
): PlanBodyStats => {
    const lengths = comments
        .map((comment) => comment.body.length)
        .sort((a, b) => a - b);
    return {
        comments: lengths.length,
        medianChars: percentile(lengths, 50),
        p90Chars: percentile(lengths, 90),
        maxChars: lengths.length === 0 ? 0 : lengths[lengths.length - 1] ?? 0,
        totalChars: lengths.reduce((sum, length) => sum + length, 0),
        bodyChars: body.length,
    };
};

/**
 * Write the staged plan (`submission-plan.json`) and hand it back. A second
 * copy lands under `out/` because that is the only directory the run
 * uploads (review.md Step 9's `upload-artifact` matches the
 * staging-relative `out/**`; the absolute `/tmp/gh-aw/review/out/**`
 * pattern alongside it matches nothing under gh-aw v0.81.6 and is kept
 * only as future-proofing): the copy is what makes
 * `bodyStats` readable from a run's artifact without a runner. The
 * `REVIEW_DIR` original stays the read path for the dispatch gate and the
 * cache-record writer.
 */
const stagePlan = (
    fs: SubmissionFs,
    plan: Omit<SubmissionPlan, "bodyStats">,
): SubmissionPlan => {
    const staged: SubmissionPlan = {
        ...plan,
        bodyStats: computeBodyStats(plan.comments, plan.body),
    };
    const json = JSON.stringify(staged, null, 2);
    fs.writeFileSync(`${REVIEW_DIR}/submission-plan.json`, json);
    fs.mkdirSync(`${REVIEW_DIR}/out`, {recursive: true});
    fs.writeFileSync(`${REVIEW_DIR}/out/submission-plan.json`, json);
    return staged;
};

const readJson = (fs: SubmissionFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/** The Step 9 cache record for this PR (pr number from pr-context.json). */
const readCacheMemoryRecord = (fs: SubmissionFs): unknown => {
    const prContext = readJson(fs, `${REVIEW_DIR}/pr-context.json`) as
        | {number?: unknown}
        | undefined;
    if (typeof prContext?.number !== "number") {
        return undefined;
    }
    return readJson(fs, `${CACHE_MEMORY_DIR}/pr-${prContext.number}.json`);
};

/* -------------------------------------------------------------------------- */
/* Rendering (submission-render.ts; re-exported for the existing consumers)    */
/* -------------------------------------------------------------------------- */

export {
    isDropInSuggestion,
    labelAdmitsSketch,
    MAX_VERBATIM_FOLD_CHARS,
    renderClaimComment,
    renderPrLevelFold,
} from "./submission-render";

/**
 * At most this many inline comments post; the rest collapse (the Step 5 cap,
 * as code). MUST match the frontmatter's
 * `create-pull-request-review-comment: max:` in review.md: the engine
 * rejects safe outputs past that number, and a plan the engine cannot fully
 * emit is a conformance-gate red after full spend.
 */
export const MAX_INLINE_COMMENTS = 20;

/** The medium-confidence inline floor (the Step 5 posting bar). */
const MIN_INLINE_CONFIDENCE = 0.5;

/** The collapsed summary's named-top subject cap: one line, not a wall. */
const TOP_SUBJECT_MAX_CHARS = 120;

/* -------------------------------------------------------------------------- */
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compose the submission plan from the staged dispatch result. Factored out
 * (fs injected) so it is testable without touching the real filesystem.
 * Writes `submission-plan.json` (and, via the rereview CLI it invokes,
 * `rereview.json`). Returns what was written.
 */
/**
 * `repoRoot` is the reviewed repo's root, which the NOTIFIED computation
 * below reads `.github/NOTIFIED` from. It is a parameter rather than an
 * environment read inside the function so a test can pin it: under Actions
 * `GITHUB_WORKSPACE` is always set, so an env-derived default silently sends
 * a fake-filesystem test looking under the runner's real workspace path, and
 * the case passes locally while failing in CI.
 */
export const runSubmissionCli = (
    fs: SubmissionFs,
    repoRoot: string = process.env.REVIEW_REPO_ROOT ??
        process.env.GITHUB_WORKSPACE ??
        ".",
): SubmissionPlan => {
    const notes: string[] = [];
    const dispatch = readJson(fs, `${REVIEW_DIR}/dispatch-result.json`) as
        | {
              claims?: unknown;
              noteLines?: unknown;
              reconciliation?: {resolve?: unknown; skipLines?: unknown};
              depth?: unknown;
              threadSuppressions?: unknown;
              riskFiles?: unknown;
              patterns?: unknown;
              excludedFiles?: unknown;
              skippedDimensions?: unknown;
          }
        | undefined;
    if (dispatch === undefined) {
        throw new Error(
            `dispatch-result.json not staged under ${REVIEW_DIR}: run the dispatcher first`,
        );
    }
    const validated = (
        Array.isArray(dispatch.claims) ? dispatch.claims : []
    ) as Claim[];
    // Defer to open human threads (review.md Step 5): drop any claim anchored
    // on a line the reconciler flagged, silently; a human conversation is
    // already open there and a bot comment would talk over it. This runs
    // BEFORE the verdict, because Step 4 counts only the labels on comments
    // that actually post; rule 7 then forbids the orchestrator from dropping
    // anything itself, so the filter has to live here or not at all.
    const skipLines = parseSkipLines(dispatch.reconciliation?.skipLines);
    const claims = validated.filter((claim) => {
        const skipped =
            claim.path !== undefined &&
            claim.line !== undefined &&
            skipLines.has(`${claim.path}:${claim.line}`);
        if (skipped) {
            notes.push(
                `claim ${claim.id} dropped: open human thread at ${claim.path}:${claim.line}`,
            );
        }
        return !skipped;
    });
    const noteLines = Array.isArray(dispatch.noteLines)
        ? dispatch.noteLines.filter(
              (line): line is string => typeof line === "string",
          )
        : [];
    const depth = typeof dispatch.depth === "string" ? dispatch.depth : "full";
    const routing = readJson(fs, `${REVIEW_DIR}/routing.json`) as
        | {
              teams?: {owners?: unknown};
              reReviewBlockingOnly?: unknown;
              reReviewBlockingMedium?: unknown;
              nonBlockingInlineBudget?: unknown;
          }
        | undefined;
    // The ROUTING `re-review <mode> blocking-only` modifier: a repeat review
    // at a reduced depth posts only blocking findings inline; validated
    // non-blocking findings collapse into the review body below. Keyed on
    // the EXECUTED depth, not the configured mode, so the first full review,
    // a tripwire re-arm, and every guard that resolves to full depth still
    // post everything. The verdict counts every claim either way.
    //
    // Executed depth is a DELIBERATE key, not a proxy for "is a repeat
    // review" (rereview-plan.json is staged and could key that directly): a
    // guard degrades to full exactly when the pipeline could not trust the
    // reduced-depth state — a divergence re-arm, an unparseable plan, a
    // missing staging — and a run whose premise is "start over, trust
    // nothing" should not inherit a posting filter from the state it just
    // declined to trust. Guard-degraded repeats therefore stay loud BY
    // DESIGN, priced as: guards are rare, and when one fires the review is
    // effectively a first review of the current tree. If the live A/B shows
    // degrade-to-full repeats still generating the chatter complaint, the
    // revisit is to key on plan presence, not to widen this condition
    // quietly — that trade (filtering a run built on distrusted state)
    // deserves its own change and its own eval.
    const blockingOnly =
        depth !== "full" && routing?.reReviewBlockingOnly === true;
    // The `blocking-medium` sibling modifier: same reduced surface, but
    // medium-importance claims keep posting inline (spending the
    // non-blocking budget) while minor claims collapse. Same executed-depth
    // key, same reasoning.
    const blockingMedium =
        depth !== "full" && routing?.reReviewBlockingMedium === true;
    // The reduced posting surface either modifier arms; `blockingMedium`
    // then decides whether medium claims punch through it.
    const reducedSurface = blockingOnly || blockingMedium;

    // The deterministic changed-lines veto on the medium tier (PRA-7):
    // medium is defined over code this PR adds, so the tier is stripped
    // (never the claim) from anything not anchored on an added line of the
    // staged diff. Applied at the posting surface, after validation, so
    // code has the last word over both the reviewer's proposal and a
    // validator grant. The scoped diff wins when it exists for the same
    // reason the dispatcher stages it: it is what this run's reviewers saw.
    const vetoDiffPath =
        depth === "scoped" && fs.existsSync(`${REVIEW_DIR}/scoped.diff`)
            ? `${REVIEW_DIR}/scoped.diff`
            : `${REVIEW_DIR}/full.diff`;
    const vetoDiffText = fs.existsSync(vetoDiffPath)
        ? fs.readFileSync(vetoDiffPath, "utf8")
        : "";
    const vetoed = applyMediumVeto(claims, computeChangedLines(vetoDiffText));
    if (
        vetoDiffText === "" &&
        claims.some((claim) => claim.importance === "medium")
    ) {
        // A missing diff demotes every medium for a reason unrelated to
        // reviewer behavior; without this line the calibration count below
        // reads as roster under-use.
        notes.push(
            "medium veto ran with no staged diff (all medium claims demoted)",
        );
    }
    // The day-one calibration instrument (artifact-only): whether the
    // roster uses the tier at all is unobservable from posted output alone
    // (under-use looks exactly like the pre-tier surface), so every plan
    // records its post-veto medium count, zero included.
    const mediumCount = vetoed.filter(
        (claim) => claim.importance === "medium",
    ).length;
    notes.push(`medium-importance claims this run: ${mediumCount}`);

    // Stage the code-computed risks/patterns signature (trial suggestion b):
    // Step 7 compares THIS string against cache memory's `risksPatternsKey`
    // instead of composing its own, and the deterministic cache writer
    // (cache-record.ts) records the same string when the guidance comment
    // queues, so one code-owned format sits on both sides of the repost
    // decision.
    // Full depth only: Step 7 skips every reduced depth (`scoped` included),
    // so the existing comment stands and the key carries forward. A scoped
    // run DOES compute triage, but against the scoped subset; staging that
    // narrower signature could collapse the standing full-run guidance the
    // next time any comment queues.
    if (depth === "full") {
        // The NOTIFIED match set rides the same key: Step 7 posts one Review
        // Guidance comment for risks, patterns, AND notifications, so a run
        // that changed only the notified set must still re-post.
        //
        // COMPUTED HERE, not read from notified.json. The notified CLI does
        // not run until Step 7, long after this one, so reading the file
        // would find nothing on every real run: `signature` would always be
        // undefined, the `notified:` component would always drop out, and a
        // `.github/NOTIFIED`-only change would stage a key identical to the
        // prior run's — leaving Step 7 to read the guidance as unchanged and
        // never mention a newly-subscribed team. That is precisely the bug
        // this fold exists to fix, so the fold has to own the computation.
        //
        // `runCli` is pure over staged inputs that the pre-agent step writes
        // as hard prerequisites (`files.json`, `full.diff`), so it is safe to
        // call this early; it also stages `notified.json`, which makes Step
        // 7's own invocation idempotent rather than first-of-its-kind. A repo
        // with no `.github/NOTIFIED` yields an empty signature, the same key
        // this produced before the feature.
        const notified = runNotifiedCli(fs, repoRoot);
        fs.writeFileSync(
            RISKS_PATTERNS_KEY_PATH,
            computeRisksPatternsKey({
                riskFiles: dispatch.riskFiles,
                patterns: dispatch.patterns,
                excludedFiles: dispatch.excludedFiles,
                owners: routing?.teams?.owners,
                notifiedSignature: notified.signature,
            }),
        );
    }

    // The accountability section (renders and stages rereview.json too).
    const rereview = runRereviewCli(fs);

    // The prior verdict, read once: the reduced-depth flip floor needs a
    // prior REQUEST_CHANGES, the redundant-approval skip needs a prior
    // APPROVE. Posted bodies carry the stamp since the collapsed details
    // form (webapp#41742); cache-memory stays as the pre-move fallback.
    const priorRaw = readJson(fs, `${REVIEW_DIR}/prior-reviews.json`);
    const priors: PriorReview[] = Array.isArray(priorRaw)
        ? priorRaw.filter(
              (entry): entry is PriorReview =>
                  typeof (entry as {body?: unknown}).body === "string",
          )
        : [];
    const priorStamp =
        findLatestStamp(priors) ??
        stampFromCacheMemory(readCacheMemoryRecord(fs));

    // The reduced-depth flip floor (Step 4): only over a prior
    // REQUEST_CHANGES stamp at flip-gated/fast depth.
    let keptBlockingFloor = 0;
    if (depth === "flip-gated" || depth === "fast") {
        if (priorStamp !== null && priorStamp.verdict === "REQUEST_CHANGES") {
            keptBlockingFloor = rereview.keptBlockingCount;
        }
    }

    // Inline comments need a path and a line; a PR-level claim folds into
    // the body instead (rare: a pr-anchored finding). Under a reduced
    // surface a non-blocking pr-level claim joins the collapsed section
    // instead (a pr-level claim can never carry medium: the changed-lines
    // veto requires a line anchor, so no blocking-medium carve-out exists
    // here by construction).
    const anchored: Claim[] = [];
    const prLevelLines: string[] = [];
    const prLevelCollapsed: Claim[] = [];
    for (const claim of vetoed) {
        if (claim.path !== undefined && claim.line !== undefined) {
            anchored.push(claim);
        } else if (reducedSurface && !isBlockingLabel(claim.label)) {
            prLevelCollapsed.push(claim);
        } else {
            // The fold carries the same collapsed attribution footer an
            // inline comment gets: a pr-level finding names its reviewer too.
            prLevelLines.push(
                `${renderPrLevelFold(claim)}\n${renderAttributionFooter(
                    claim.source,
                    claim.also_flagged_by,
                )}`,
            );
            notes.push(
                `pr-level claim ${claim.id} folded into the review body`,
            );
        }
    }

    // A blocking candidate the dispatcher suppressed as a duplicate of a
    // still-open BLOCKING bot thread (trial suggestion g) blocks like a
    // fresh one: the reviewer re-confirmed the defect, and the open thread
    // is the actionable feedback. Without this floor, suppression could
    // flip the verdict to APPROVE over an unfixed blocking objection. Both
    // sides must be blocking: suppression happens before validation, so the
    // candidate's own label is unvalidated; the matched thread's opener
    // label is the severity that DID survive a prior run's validation. A
    // blocking candidate matching a non-blocking open thread therefore
    // never floors (it would force REQUEST_CHANGES with no validation and
    // no visible blocking comment). (A thread the reduced-depth floor above
    // already counted may add one more here; the verdict is the same either
    // way, only the reason count differs.)
    const suppressedBlocking = (
        Array.isArray(dispatch.threadSuppressions)
            ? dispatch.threadSuppressions
            : []
    ).filter(
        (entry) =>
            typeof (entry as {label?: unknown}).label === "string" &&
            isBlockingLabel((entry as {label: string}).label) &&
            (entry as {threadBlocking?: unknown}).threadBlocking === true,
    ).length;

    // Real dimension availability (the hold rule's input): a core lens
    // recorded in the dispatcher's `skippedDimensions` (either cause)
    // produced no usable output this run and must not be reported
    // "assessed", or a crashed run auto-approves. The dimension names are
    // imported from the modules that write them (`DEFAULT_FINDERS`,
    // `TRIAGE_DIMENSION`), so a rename cannot silently decouple the hold
    // from the dispatcher. The production dispatcher always writes
    // `skippedDimensions` (an empty array on a clean run); an absent field
    // (hand-staged eval fixtures) reads as all-assessed rather than
    // guessing at a hold.
    const skippedDimensionNames = new Set(
        (Array.isArray(dispatch.skippedDimensions)
            ? dispatch.skippedDimensions
            : []
        )
            .map((entry) => (entry as {dimension?: unknown}).dimension)
            .filter((name): name is string => typeof name === "string"),
    );
    const dimensionStatus = (name: string): DimensionStatus =>
        skippedDimensionNames.has(name) ? "unavailable" : "assessed";

    const verdict = computeVerdict({
        postedLabels: claims.map((claim) => claim.label),
        dimensions: {
            correctness: dimensionStatus(DEFAULT_FINDERS[0]),
            skillSeverity: dimensionStatus(DEFAULT_FINDERS[1]),
            patternTriage: dimensionStatus(TRIAGE_DIMENSION),
        },
        keptBlockingCount: keptBlockingFloor + suppressedBlocking,
        // The middle verdict's signal (PRA-7): post-veto mediums, the same
        // count the notes line records. Collapsed mediums count too; the
        // verdict follows what the run FOUND, not which surface showed it
        // (the same invariant that keeps a 21st blocking claim blocking).
        mediumCount,
    });

    // The depth note (Step 3), when the run reduced.
    const plan = readJson(fs, `${REVIEW_DIR}/rereview-plan.json`) as
        | {mode?: unknown; tripwireRearmed?: unknown; divergence?: unknown}
        | undefined;
    const depthNotes: string[] = [];
    if (plan !== undefined && depth !== "full") {
        const mode = typeof plan.mode === "string" ? plan.mode : "full";
        depthNotes.push(
            `Note: re-review ran at ${depth} depth (re-review mode ${mode}${
                blockingOnly
                    ? ", blocking-only"
                    : blockingMedium
                    ? ", blocking-medium"
                    : ""
            }).`,
        );
    }
    if (plan?.tripwireRearmed === true) {
        const share = (
            plan.divergence as {unreviewedShare?: unknown} | undefined
        )?.unreviewedShare;
        depthNotes.push(
            `Note: divergence tripwire re-armed a full review (unreviewed share ${
                typeof share === "number" ? share.toFixed(2) : "unknown"
            }).`,
        );
    }

    // The hold path (computeVerdict's core-dimension gate): a run whose
    // correctness or skill/severity pass produced no output must not resolve
    // to an approval the automation cannot stand behind. A hold is not a
    // review event: the orchestrator posts this body as ONE standalone PR
    // comment (the add-comment safe output) and submits no review, so the
    // PR shows neither an approval nor a block. Claims that survived
    // validation fold into the comment as one line each (blocking claims
    // cannot exist here: they force REQUEST_CHANGES over the hold), the
    // reconciler's resolutions are withheld (a partial run leaves existing
    // threads standing), and no fingerprint stamp is written, so the cache
    // writer refuses the record and the next run reviews in full.
    if (verdict.event === "HOLD_FOR_HUMAN") {
        // Both post-fold buckets ride the hold comment: anchored claims (no
        // inline comments post on a hold) and the blocking-only collapsed
        // pr-level claims (their collapsed section renders only on the
        // normal path).
        const heldClaimLines = [...anchored, ...prLevelCollapsed].map(
            (claim) => {
                notes.push(
                    `claim ${claim.id} folded into the hold comment (a hold posts no inline comments)`,
                );
                return renderCollapsedLine(claim);
            },
        );
        return stagePlan(fs, {
            event: "HOLD_FOR_HUMAN",
            body: [
                HOLD_HEAD,
                rereview.section,
                ...prLevelLines,
                ...heldClaimLines,
                ...noteLines,
                ...depthNotes,
                ...HOLD_UNSTUCK_LINES,
            ]
                .filter((line) => line !== "")
                .join("\n"),
            skipSubmission: false,
            comments: [],
            resolve: [],
            reasons: verdict.reasons,
            notes,
        });
    }

    // The posting bar (the Step 5 ranked bar, as code): rank
    // blocking before non-blocking, then confidence descending (the sort is
    // stable, so dispatch order breaks ties). A claim below medium
    // confidence (< 0.5) never posts inline (a blocking claim always
    // qualifies: it is validator-confirmed by construction), and at most
    // MAX_INLINE_COMMENTS post inline: the frontmatter caps the
    // create-pull-request-review-comment safe output at the same number, so
    // a longer plan would have the engine reject the overflow and the
    // conformance gate red the run after full spend.
    //
    // Three further rules shape the non-blocking surface (the P1 comment
    // budget, quiet-the-human-surface lane):
    //   - `nitpick (non-blocking)` never posts inline: the label names the
    //     class the lane demotes wholesale (naming, doc-comment nits).
    //   - At most `nonBlockingInlineBudget` other non-blocking claims post
    //     inline (routing.json's `non-blocking-budget` line, default 3);
    //     the budget spends in ranked order, so what sheds is chosen.
    //     Documentation-label claims are budgeted like any other since the
    //     autofix learned to read the collapsed section (its selection used
    //     to be posted threads only, which made collapsing a doc finding
    //     silently shrink a shipped feature's scope).
    //
    // Everything else collapses to one terse line each in a single
    // <details> block in the review body (always the body: the autofix's
    // body-sourced work list reads the section back off posted reviews),
    // so it is surfaced without scattering noise. The verdict is computed from ALL claims, so a
    // collapsed blocking claim (a 21st blocking finding) still blocks.
    const budgetRaw = routing?.nonBlockingInlineBudget;
    const nonBlockingBudget =
        typeof budgetRaw === "number" &&
        Number.isInteger(budgetRaw) &&
        budgetRaw >= 0
            ? budgetRaw
            : DEFAULT_NON_BLOCKING_INLINE_BUDGET;
    const isNitpick = (claim: Claim): boolean =>
        labelToken(claim.label) === labelToken(NITPICK_LABEL);
    // Named so the collapsed list below can re-sort with the same rank
    // once the pr-level claims join it: the disclosure names the tail's
    // first entry, so the ordering IS the disclosure's selection rule.
    const rankClaims = (a: Claim, b: Claim): number => {
        const blocking =
            Number(isBlockingLabel(b.label)) - Number(isBlockingLabel(a.label));
        if (blocking !== 0) {
            return blocking;
        }
        // Medium outranks minor within the non-blocking population (the
        // PRA-7 tier), so the budget spends on the findings a reviewer
        // judged worth fixing before merge ahead of the rest.
        const medium =
            Number(b.importance === "medium") -
            Number(a.importance === "medium");
        if (medium !== 0) {
            return medium;
        }
        // Nitpicks rank last among non-blocking claims, whatever their
        // confidence: without the demotion the class this surface
        // deliberately never posts would routinely win the summary slot
        // built for the tail's best finding.
        const nitpick = Number(isNitpick(a)) - Number(isNitpick(b));
        return nitpick !== 0 ? nitpick : b.confidence - a.confidence;
    };
    const ranked = [...anchored].sort(rankClaims);
    let budgetLeft = nonBlockingBudget;
    let budgetShed = 0;
    let nitpickShed = 0;
    const inlineWorthy = ranked.filter((claim) => {
        if (isBlockingLabel(claim.label)) {
            return true;
        }
        if (blockingOnly || claim.confidence < MIN_INLINE_CONFIDENCE) {
            return false;
        }
        // Under blocking-medium only medium claims may punch through the
        // reduced surface; everything below still applies to them (the
        // nitpick ban wins over the tier: a medium nitpick is a labeling
        // contradiction, and the ban is the stricter rule; medium spends
        // the budget like any other non-blocking claim).
        if (blockingMedium && claim.importance !== "medium") {
            return false;
        }
        if (isNitpick(claim)) {
            nitpickShed++;
            return false;
        }
        if (budgetLeft > 0) {
            budgetLeft--;
            return true;
        }
        budgetShed++;
        return false;
    });
    const inlineClaims = new Set(inlineWorthy.slice(0, MAX_INLINE_COMMENTS));
    // Re-sorted rather than appended: a pr-level claim joins the tail at
    // its rank, so the disclosure's named top entry is the tail's best
    // claim, not merely its best ANCHORED claim.
    const collapsed = [
        ...ranked.filter((claim) => !inlineClaims.has(claim)),
        ...prLevelCollapsed,
    ].sort(rankClaims);
    const inlineList = [...inlineClaims];
    const inline: PlannedComment[] = inlineList.map((claim) => ({
        path: claim.path as string,
        line: claim.line as number,
        body: renderClaimComment(claim),
    }));
    if (collapsed.length > 0) {
        // Why collapsed one-liners still cost full validation: the modifier
        // filters at the POSTING surface, deliberately after validation.
        // The validator's product for a non-blocking claim is not the line
        // it posts but the lines that never post — false positives dropped
        // and wrong labels corrected — and a collapsed list of unvalidated
        // claims would re-import exactly the wrong-claim noise the pipeline
        // exists to keep off the PR (a one-liner in the body still asserts
        // the claim, links nothing to check it against, and is skimmed as
        // the bot's word). Validation spend on the non-blocking tail is
        // bounded by the investigation cap and the run budget; skipping it
        // per-label would fork the validation policy for a saving the A/B
        // has not shown to matter. If it ever does, the dial belongs at the
        // validation-dispatch gate as its own evaluated change, with the
        // unvalidated lines marked as such — not as a silent widening here.
        //
        // The cap can push a 21st+ blocking claim into the collapse; a
        // "Non-blocking" heading would mislabel it, so the blocking-only
        // wording applies only when every collapsed claim is non-blocking
        // (each line still carries its own label either way, and the
        // verdict already counted every claim above).
        const collapsedNonBlockingOnly = !collapsed.some((entry) =>
            isBlockingLabel(entry.label),
        );
        // The disclosure names the tail's top-ranked entry, subject and
        // all, not only the count: collapsed sections once hid "the reply
        // guard never fires" behind "Non-blocking observations (6)" on an
        // approving review (Khan/actions#367), and the subject is what
        // tells a reader whether the expando is worth opening. `collapsed`
        // re-sorts with rankClaims after the pr-level claims join it, so
        // entry 0 is the best of the whole tail. The subject is
        // model-authored text inside a <summary>, so it is HTML-escaped
        // (a literal </summary> would break the collapse) and truncated.
        // A one-entry tail: at N=1 the "preview" is the whole payload, so
        // a closed <details> shows the observation twice and reads as a
        // stray comment (Khan/actions#387). It renders <details open> with
        // a count-only summary, still a <details> block for the autofix's
        // section slicing (<summary> to </details>, collapsed.ts).
        const singleEntry = collapsed.length === 1;
        const top = collapsed[0];
        const topSubject = escapeHtml(
            top.subject.length > TOP_SUBJECT_MAX_CHARS
                ? `${top.subject.slice(0, TOP_SUBJECT_MAX_CHARS)}...`
                : top.subject,
        );
        const topTag = singleEntry
            ? ""
            : top.path !== undefined && top.line !== undefined
            ? `; top: \`${top.path}:${top.line}\` ${top.label}: ${topSubject}`
            : `; top: ${top.label}: ${topSubject}`;
        const summary =
            reducedSurface && collapsedNonBlockingOnly
                ? `Non-blocking observations (${collapsed.length}${topTag})`
                : `Lower-confidence observations (${collapsed.length}${topTag})`;
        const section = [
            singleEntry ? "<details open>" : "<details>",
            `<summary>${summary}</summary>`,
            "",
            ...collapsed.map(renderCollapsedLine),
            "",
            "</details>",
        ].join("\n");
        // The section ALWAYS lands in the review body, never riding an
        // inline comment. It used to ride the top-ranked comment at full
        // depth, but the body is the one surface that persists where the
        // autofix's body-sourced work list can read it (both stagers map
        // only `review.body` off /pulls/{n}/reviews), so the ride made that
        // work list blind exactly where the budget sheds; the review-side
        // README contract (the budget shrinks the notification surface,
        // never the autofix scope) only holds with the section here.
        prLevelLines.push(section);
        notes.push(
            reducedSurface && collapsedNonBlockingOnly
                ? `${
                      collapsed.length
                  } non-blocking claim(s) collapsed into the body (re-review ${
                      blockingOnly ? "blocking-only" : "blocking-medium"
                  })`
                : `${collapsed.length} claim(s) collapsed below the inline bar (cap ${MAX_INLINE_COMMENTS}, medium-confidence floor, non-blocking budget ${nonBlockingBudget})`,
        );
        if (budgetShed > 0) {
            notes.push(
                `${budgetShed} non-blocking claim(s) collapsed over the inline budget (non-blocking budget ${nonBlockingBudget})`,
            );
        }
        if (nitpickShed > 0) {
            // The no-silent-caps rule, per shed reason: the nitpick ban is
            // its own posting rule, so its shed gets its own line rather
            // than hiding inside the budget's.
            notes.push(
                `${nitpickShed} nitpick claim(s) collapsed (nitpick-class never posts inline)`,
            );
        }
    }

    // The per-comment attribution footer (attribution.ts): which reviewer
    // produced the finding, plus dedup's `also_flagged_by` record of every
    // other reviewer that flagged the same defect. Appended here, after the
    // collapsed-observations section ride, so the footer is each comment's
    // final block; appended at the plan surface rather than inside
    // renderClaimComment so the claim renderer stays byte-identical to
    // renderComment on the same finding (the layout parity the tests pin).
    inlineList.forEach((claim, index) => {
        inline[index] = {
            ...inline[index],
            body: `${inline[index].body}\n\n${renderAttributionFooter(
                claim.source,
                claim.also_flagged_by,
            )}`,
        };
    });

    // A COMMENT cannot clear this workflow's own prior REQUEST_CHANGES:
    // GitHub derives a reviewer's state only from its latest APPROVE or
    // REQUEST_CHANGES, and nothing here dismisses reviews. So when the
    // prior stamped verdict is REQUEST_CHANGES and this run's blocking
    // objections are all resolved (a COMMENT verdict implies exactly that:
    // zero blocking labels AND zero kept blocking threads), the run
    // approves instead, or the author stays blocked by a stale state their
    // fixes already earned back. The mediums still post; the note line
    // below says what happened.
    const commentWouldStrandPriorRc =
        verdict.event === "COMMENT" &&
        priorStamp !== null &&
        priorStamp.verdict === "REQUEST_CHANGES";
    if (commentWouldStrandPriorRc) {
        notes.push(
            "COMMENT verdict upgraded to APPROVE: a comment cannot clear the prior request-changes state, and every blocking objection is resolved",
        );
    }
    const event =
        verdict.event === "REQUEST_CHANGES"
            ? "REQUEST_CHANGES"
            : verdict.event === "COMMENT" && !commentWouldStrandPriorRc
            ? "COMMENT"
            : "APPROVE";

    const head = renderReviewBody({
        event,
        hasInlineComments: inline.length > 0,
        rereviewSection: rereview.section,
    });
    const stamp = runRereviewStampCli(fs, event);
    // The body minus the attribution footer: the redundant-approval skip
    // below compares THIS against the bare approve line, because the footer
    // rides every submitted body (a bare approve differs from the bare
    // render by exactly the footer, and that difference is not a reason to
    // post).
    const coreBody = [head, ...prLevelLines, ...noteLines, ...depthNotes]
        .filter((line) => line !== "")
        .join("\n");
    // The version/config footer (version-footer.ts): code-rendered,
    // collapsed by default (attribution.ts's shared <details> wrapper), and
    // sanitizer-surviving (details/summary/sub are all allowed tags; the old
    // hidden HTML marker never posted). The CLI also stages version-footer.txt for
    // Step 7's guidance comment. The depth override hands the footer this
    // run's executed depth from the SAME read that keys the depth Note and
    // blocking-only gating, so the two surfaces cannot contradict; null
    // (unreadable dispatch result) drops the segment rather than guessing.
    const footer = runVersionFooterCli(fs, undefined, {
        depth: typeof dispatch.depth === "string" ? dispatch.depth : null,
    });
    const body = [coreBody, footer]
        .filter((line) => line !== "")
        .join("\n")
        .concat(stamp === null ? "" : `\n${stamp}`)
        .replace(/^\n+/, "");

    // The redundant-approval skip, code-owned so the prompt (Step 6) and the
    // conformance gate share ONE predicate instead of two prose descriptions
    // that can drift: they diverged once already, when the collapsed
    // low-confidence `<details>` section started riding the body — it is
    // neither a `Note:` line nor an accountability section, so the prompt's
    // old wording let the orchestrator skip a submission the gate then
    // red-flagged, withholding the approval AND the observations on every
    // later run. Compared modulo the ingest sanitizer (`normalizeBody`),
    // the same way the gate compares; the stamp and footer never enter the
    // comparison at all, since both ride `body`, not `coreBody`.
    const skipSubmission =
        event === "APPROVE" &&
        inline.length === 0 &&
        normalizeBody(coreBody) ===
            normalizeBody(
                renderReviewBody({event: "APPROVE", hasInlineComments: false}),
            ) &&
        priorStamp !== null &&
        priorStamp.verdict === "APPROVE";

    return stagePlan(fs, {
        event,
        body,
        skipSubmission,
        comments: inline,
        resolve: Array.isArray(dispatch.reconciliation?.resolve)
            ? dispatch.reconciliation.resolve.filter(
                  (id): id is string => typeof id === "string",
              )
            : [],
        reasons: verdict.reasons,
        notes,
    });
};

// Run only when executed directly (review.md Steps 4-6, scripted dispatch
// mode), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as SubmissionFs;
    try {
        const plan = runSubmissionCli(fs);
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify(
                {
                    event: plan.event,
                    comments: plan.comments.length,
                    resolve: plan.resolve.length,
                    reasons: plan.reasons,
                    bodyStats: plan.bodyStats,
                },
                null,
                2,
            ),
        );
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
            `::error title=review submission plan::${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        process.exit(1);
    }
}
