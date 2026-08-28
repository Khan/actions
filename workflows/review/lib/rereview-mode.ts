/**
 * The re-review mode dial: deterministic depth selection for repeat reviews
 * of the same PR.
 *
 * Measured lifecycles of one seeded PR paid the full 11-agent fan-out on
 * every push, with per-run cost rising as threads accumulate ($7.19 → $9.14
 * across three runs of v1.3.1; $8.31 → $11.29 on v1.4.0), and the approval
 * run (the one that emits the least) was the most expensive. This module is
 * the runs-per-PR cost lever: a per-repo `re-review` mode in the ROUTING file
 * (`full` | `scoped` | `flip-gated` | `fast`, default `full`) decides how
 * much of the roster a repeat review runs. See {@link ReReviewMode} in
 * `routing-config.ts` for what each mode does.
 *
 * Three guards keep the cheaper modes honest:
 *
 *   1. **Ready-for-review anchor.** The one full review the cheaper modes
 *      lean on must have reviewed the PR *ready*, never a draft skeleton: a
 *      fingerprint stamped on a draft forces one more full review when the
 *      PR leaves draft.
 *   2. **Flip gate.** `flip-gated` dispatches the correctness pass alongside
 *      reconciliation, and any validated blocking finding from that pass
 *      still forces REQUEST_CHANGES; the findings gate the outcome instead
 *      of being discarded. Neither reduced depth can approve at all
 *      (submission.ts's full-roster approval rule): a block the
 *      round earned back is cleared by dismissing the standing review.
 *   3. **Divergence tripwire.** Every full-depth review records a
 *      content-hashed hunk signature. Each later push compares its current
 *      signature against that last fully-reviewed fingerprint; when the
 *      unreviewed share crosses {@link DEFAULT_TRIPWIRE_THRESHOLD},
 *      full-review mode re-arms and the divergent push gets the whole
 *      roster.
 *
 * **Fingerprint carriers.** The signature is written to two places and read
 * back in priority order:
 *
 *   1. The stamp in the review body, a collapsed `<details>` block
 *      ({@link renderRereviewStamp}). This is the durable carrier: it
 *      survives cache eviction and branch protection's
 *      dismiss-stale-approvals. It was originally an HTML comment, which
 *      gh-aw's safe-output ingest sanitizer strips (`removeXmlComments` in
 *      gh-aw-actions `sanitize_content_core.cjs`), so no posted review ever
 *      carried a stamp and every production re-review planned
 *      `no-prior-fingerprint` (measured 2026-07-21 on Khan/webapp#40996,
 *      and again on webapp#41742). `details`/`summary`/`sub` are on the
 *      sanitizer's allowed-tags list, so the block form posts intact.
 *   2. The cache-memory record (`/tmp/gh-aw/cache-memory/pr-<n>.json`),
 *      whose Step 9 fields (`verdict`, `stampHunks` — falling back to
 *      `reviewedHunks` where a consumer's Step 9 wrote the code-computed
 *      signature there — and `wasDraft`) carry the same information. This
 *      is the fallback for bodies posted before the block form existed,
 *      and it cannot be the primary: GitHub's 2026-06-30 cache policy
 *      denies cache writes from issue_comment-triggered runs regardless of
 *      job permissions, which is exactly the /review trigger. Missing both
 *      degrades to `full` (more review, never less).
 *
 * Two interactions are handled by construction:
 *
 *   - **dismiss-stale-approvals**: the prior verdict is read from the stamp,
 *     not the review's `state`, so a dismissed approval still anchors the
 *     fingerprint and still reads as an approval to flip logic.
 *   - **COMMENTED-only history**: the marker of "a full review happened" is
 *     the stamp itself, whatever the review state, so a PR whose only prior
 *     bot review is COMMENTED (e.g. a comment-only A/B arm) reduces normally
 *     after its first stamped run instead of re-running full forever.
 *
 * The hunk signature hashes each hunk's added AND removed lines (markers
 * kept, trailing whitespace trimmed), so it is stable across rebases,
 * squashes, and base merges (which rewrite SHAs and shift line numbers but
 * not the change's content), while a deletion-only payload still moves the
 * fingerprint. (Step 1's older added-lines-only prompt definition is
 * superseded by this CLI; the one-time mismatch on upgrade degrades to a
 * full review, never a skipped one.)
 *
 * Every failure degrades toward `full`: toward more review, never less.
 *
 * Determinism boundary: pure functions of the diff text, the ROUTING mode,
 * and the stamped fingerprint; no model call, no clock, no prose about the
 * code under review.
 */

import {createHash} from "node:crypto";

import {splitPatchHunks, splitUnifiedDiff} from "./diff";
import {commentAuthorFromEvent, isManualReviewRequest} from "./manual-request";
import {DEFAULT_RE_REVIEW_MODE, RE_REVIEW_MODES} from "./routing-config";
import type {ReReviewMode} from "./routing-config";

/* -------------------------------------------------------------------------- */
/* Hunk signatures                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-file content-hashed hunk signature: `path → [hunkHash, …]`, one
 * truncated SHA-256 per hunk over its `+`/`-` lines (markers kept, trailing
 * whitespace trimmed). Content-based, so force-pushes and rebases that do not
 * change what the diff adds or removes do not move the signature.
 */
export type HunkSignature = Record<string, string[]>;

/** Truncation keeps the stamp compact; 16 hex chars ≈ 64 bits per hunk. */
const HUNK_HASH_CHARS = 16;

const hashHunk = (hunkText: string): string => {
    const content = hunkText
        .split("\n")
        .filter((line) => line.startsWith("+") || line.startsWith("-"))
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n");
    return createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, HUNK_HASH_CHARS);
};

/**
 * Compute the hunk signature of a unified diff. Pure: same diff text, same
 * signature. Files whose section carries no hunks (e.g. a binary file's
 * header-only section) get an empty list.
 */
export const computeHunkSignature = (diffText: string): HunkSignature => {
    const signature: HunkSignature = {};
    for (const section of splitUnifiedDiff(diffText)) {
        signature[section.path] = splitPatchHunks(section.text).map(hashHunk);
    }
    return signature;
};

/* -------------------------------------------------------------------------- */
/* Divergence                                                                 */
/* -------------------------------------------------------------------------- */

/** How far the current diff has drifted from the anchoring fingerprint. */
export type Divergence = {
    /** Hunks in the current diff. */
    totalHunks: number;
    /** Current hunks whose hash the fingerprint does not contain. */
    unreviewedHunks: number;
    /** `unreviewedHunks / totalHunks` (0 when the diff has no hunks). */
    unreviewedShare: number;
};

/**
 * Unreviewed share at or above which the tripwire re-arms a full review.
 * Sized so a routine fix push on a reviewed PR (a small fraction of its
 * hunks) stays cheap while a rewrite-after-approval (share 1.0) or a payload
 * pushed onto a sparse PR (share near 1.0) always re-arms. Exported so the
 * eval suite and the live A/B can price other settings.
 */
export const DEFAULT_TRIPWIRE_THRESHOLD = 0.4;

/**
 * Compare the current signature against the last fully-reviewed fingerprint.
 * A hunk is unreviewed when its hash is absent from the fingerprint's set
 * for that path (a path absent from the fingerprint is entirely unreviewed).
 * Hunks that existed at the last full review and are gone now do not count:
 * share measures what the current diff contains that no full review saw.
 */
export const computeDivergence = (
    current: HunkSignature,
    reviewed: HunkSignature,
): Divergence => {
    let totalHunks = 0;
    let unreviewedHunks = 0;
    for (const [path, hashes] of Object.entries(current)) {
        const seen = new Set(reviewed[path] ?? []);
        for (const hash of hashes) {
            totalHunks++;
            if (!seen.has(hash)) {
                unreviewedHunks++;
            }
        }
    }
    return {
        totalHunks,
        unreviewedHunks,
        unreviewedShare: totalHunks === 0 ? 0 : unreviewedHunks / totalHunks,
    };
};

/* -------------------------------------------------------------------------- */
/* The review-body stamp                                                      */
/* -------------------------------------------------------------------------- */

/** The depth a run actually executed (a mode may be overridden by a guard). */
export type ReReviewDepth = ReReviewMode;

/**
 * The stamp a review body carries (a collapsed `<details>` block; see
 * {@link renderRereviewStamp}). `anchorHunks` is the last
 * fully-reviewed fingerprint (refreshed by a `full`/`scoped` run, carried
 * forward verbatim by `flip-gated`/`fast`), or `"overflow"` when the
 * signature was too large to stamp; `anchorDraft` is whether the PR was a
 * draft when that fingerprint was taken. `verdict` is the submitted event of
 * THIS review; kept in the stamp because branch protection's
 * dismiss-stale-approvals rewrites the review's `state` to DISMISSED and the
 * original verdict becomes unreadable from the API listing.
 */
export type ReReviewStamp = {
    schemaVersion: number;
    depth: ReReviewDepth;
    verdict: string;
    anchorDraft: boolean;
    anchorHunks: HunkSignature | "overflow";
};

export const STAMP_SCHEMA_VERSION = 1;

const STAMP_MARKER = "pr-reviewer:rereview";

/**
 * Cap on the base64 fingerprint payload. A review body holds 65536 chars and
 * must also carry the verdict text, note lines, and any accountability
 * rendering; past the cap the stamp records `hunks=overflow`, which readers
 * treat as "fingerprint unavailable" and answer with a full review.
 */
export const MAX_STAMP_HUNKS_B64_CHARS = 20000;

/**
 * Stable serialization: sorted paths, so equal signatures encode equally.
 * base64url, not base64: the payload posts as visible body text, and the
 * ingest sanitizer redacts anything that looks like a protocol-relative URL,
 * which a standard-alphabet payload can produce (`//` is a legal base64
 * bigram). The url-safe alphabet has no slashes. Node's base64 decoder
 * accepts both alphabets, so decode is unchanged.
 */
const encodeSignature = (signature: HunkSignature): string => {
    const sorted: HunkSignature = {};
    for (const path of Object.keys(signature).sort()) {
        sorted[path] = signature[path];
    }
    return Buffer.from(JSON.stringify(sorted), "utf8").toString("base64url");
};

/** Shape check shared by the payload decoder and the stamp CLI's guard. */
const isHunkSignature = (value: unknown): value is HunkSignature =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
        (hashes) =>
            Array.isArray(hashes) &&
            hashes.every((hash) => typeof hash === "string"),
    );

const decodeSignature = (encoded: string): HunkSignature | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
        return null;
    }
    return isHunkSignature(parsed) ? parsed : null;
};

/** The summary chip the stamp's collapsed block renders under. */
const STAMP_SUMMARY = "review fingerprint";

/**
 * Render the stamp as a collapsed `<details>` block appended to the review
 * body; this is the primary carrier (the module header's "Fingerprint
 * carriers" section has the full sanitizer and cache-policy rationale).
 * `anchorDraft` is coerced to a strict boolean: the stamp CLI reads it off
 * the agent-writable plan file, and interpolating a forged string like
 * `false hunks=<payload>` verbatim would hand the delimiter-free parser a
 * spliced fingerprint (the same boundary `runRereviewStampCli` holds
 * `depth` to).
 */
export const renderRereviewStamp = (stamp: ReReviewStamp): string => {
    let hunksField: string;
    if (stamp.anchorHunks === "overflow") {
        hunksField = "overflow";
    } else {
        const encoded = encodeSignature(stamp.anchorHunks);
        hunksField =
            encoded.length > MAX_STAMP_HUNKS_B64_CHARS ? "overflow" : encoded;
    }
    const payload =
        `${STAMP_MARKER} v=${stamp.schemaVersion} ` +
        `depth=${stamp.depth} verdict=${stamp.verdict} ` +
        `anchor-draft=${stamp.anchorDraft === true} hunks=${hunksField}`;
    return [
        `<details><summary><sub>${STAMP_SUMMARY}</sub></summary>`,
        `<sub>${payload}</sub>`,
        "</details>",
    ].join("\n");
};

/**
 * Delimiter-free on purpose: the payload is matched wherever it appears, so
 * the reader accepts both this block form and the legacy `<!-- ... -->`
 * comment form (staged plans, cache fixtures, and any pre-fix body that
 * never went through the sanitizer). The hunks charset is the base64url
 * alphabet plus the legacy base64 characters, and it cannot match past the
 * closing `</sub>` or ` -->` because neither `<` nor a space is in it.
 * Delimiter-free also means a body QUOTING a stamp (a review discussing
 * this format, say) can match; last-wins plus the schema, depth, and
 * decode checks bound that to adopting a well-formed quoted fingerprint,
 * which the divergence tripwire then treats like any stale anchor. The
 * depth and verdict charsets are exact by construction (`[a-z-]+` covers
 * every RE_REVIEW_MODES value, `[A-Z_]+` every review event), and both
 * stop at the space before the next field, so a mangled field ends the
 * match instead of bleeding into the payload.
 */
const STAMP_RE = new RegExp(
    `${STAMP_MARKER} v=(\\d+) depth=([a-z-]+) verdict=([A-Z_]+) ` +
        `anchor-draft=(true|false) hunks=([A-Za-z0-9+/=_-]+)`,
    "g",
);

/**
 * Parse the LAST stamp in a review body (a body carries at most one, but
 * last-wins keeps the reader deterministic if a future writer appends).
 * Returns null when there is no stamp, the schema version is unknown, the
 * depth is not a known mode, or the fingerprint payload does not decode;
 * all of which the caller must treat as "no usable fingerprint" (→ full).
 */
export const parseRereviewStamp = (body: string): ReReviewStamp | null => {
    let match: RegExpExecArray | null = null;
    STAMP_RE.lastIndex = 0;
    for (let m = STAMP_RE.exec(body); m !== null; m = STAMP_RE.exec(body)) {
        match = m;
    }
    if (match === null) {
        return null;
    }
    const [, version, depth, verdict, anchorDraft, hunksField] = match;
    if (Number(version) !== STAMP_SCHEMA_VERSION) {
        return null;
    }
    if (!(RE_REVIEW_MODES as readonly string[]).includes(depth)) {
        return null;
    }
    let anchorHunks: HunkSignature | "overflow";
    if (hunksField === "overflow") {
        anchorHunks = "overflow";
    } else {
        const decoded = decodeSignature(hunksField);
        if (decoded === null) {
            return null;
        }
        anchorHunks = decoded;
    }
    return {
        schemaVersion: STAMP_SCHEMA_VERSION,
        depth: depth as ReReviewDepth,
        verdict,
        anchorDraft: anchorDraft === "true",
        anchorHunks,
    };
};

/**
 * The stamp's collapsed block. The wrapper is transcription-tolerant (the
 * `<sub>` tags and whitespace are optional, and a block truncated at the
 * end of the body still strips, so a reflowed or clipped transcription
 * leaves no residue for rule 7 to read as a body splice), but the interior
 * must carry the stamp's full field skeleton: marker, `v=`, `depth=`,
 * `verdict=`, `anchor-draft=`, `hunks=`. Only the `hunks=` tail admits
 * whitespace, because the base64 payload is the field a transcription
 * plausibly garbles or wraps. Every field is a single space-free token
 * except the `hunks=` region, which admits NEWLINE-separated tokens (a
 * line-wrapped payload is the transcription failure worth tolerating); a
 * space anywhere in the region ends the match, so space-separated prose
 * leaves residue that trips rule 7's body comparison. Newline-separated
 * prose still fits the shape, so the gate bounds the region's length
 * against the plan's ({@link stampHunksChain}) and blocks extra blocks by
 * count ({@link countRereviewStampBlocks}). The floor that remains: a
 * replacement region no LONGER than the plan's own payload, which costs
 * the orchestrator the fingerprint (the next run plans full) and renders
 * inside the collapsed chip. A looser interior (the marker alone, or a
 * wildcard) would let the fold delete arbitrary prose hidden inside a
 * fingerprint-labeled block, the splice (#244) the gate exists to catch.
 */
const STAMP_BLOCK_RE = new RegExp(
    `<details>\\s*<summary>\\s*(?:<sub>\\s*)?${STAMP_SUMMARY}` +
        `\\s*(?:</sub>\\s*)?</summary>\\s*(?:<sub>\\s*)?${STAMP_MARKER}` +
        ` v=\\d+ depth=[^<\\s]* verdict=[^<\\s]* anchor-draft=[^<\\s]* ` +
        `hunks=[^<\\s]*(?:\\n[^<\\s]*)*\\s*(?:</sub>\\s*)?(?:</details>|$)`,
    "gi",
);

/**
 * Strip the stamp (block form and bare payload) from a review body. For the
 * dispatch gate's rule 7: it compares the queued body against the staged
 * plan under `normalizeBody`, which dropped the legacy comment-form stamp
 * from both sides, so the orchestrator's transcription of the payload was
 * never load-tested. The block form survives that fold, and the payload is
 * the largest opaque high-entropy string in the body; requiring it byte-
 * exact would withhold the whole review over one garbled base64 character.
 * The gate folds the stamp out of both sides instead, so a corrupted or
 * dropped payload posts and degrades the NEXT run to `no-prior-fingerprint`
 * (full depth), the same steady state as before the block form existed.
 */
export const stripRereviewStamp = (body: string): string =>
    body.replace(STAMP_BLOCK_RE, "").replace(STAMP_RE, "");

/**
 * How many stamp-shaped blocks a body carries. Rule 7 pairs this with the
 * fold: stripping tolerates variation inside a matched block's payload
 * region, so a body carrying MORE skeleton-shaped blocks than its plan is
 * smuggling text through the fold (a forged block's newline-token tail
 * would strip before the comparison); fewer is the ordinary degrade path
 * (a dropped stamp).
 */
export const countRereviewStampBlocks = (body: string): number =>
    body.match(STAMP_BLOCK_RE)?.length ?? 0;

/**
 * The first stamp block's `hunks=` region with whitespace removed, or null
 * when the body carries no stamp-shaped block. The region is the one part
 * of a matched block the fold cannot pin to the plan byte-for-byte (that
 * byte-exactness is what the fold exists to avoid), so rule 7 bounds its
 * LENGTH instead: a transcription garble may mangle or shorten the region,
 * but prose smuggled after an intact payload can only grow it.
 */
export const stampHunksChain = (body: string): string | null => {
    STAMP_BLOCK_RE.lastIndex = 0;
    const match = STAMP_BLOCK_RE.exec(body);
    STAMP_BLOCK_RE.lastIndex = 0;
    if (match === null) {
        return null;
    }
    const region = /hunks=([^<]*)/.exec(match[0]);
    return (region?.[1] ?? "").replace(/\s+/g, "");
};

/** A prior review of the PR, as the orchestrator stages it. */
export type PriorReview = {
    body: string;
    /** ISO timestamp when known; entries without one keep their input order. */
    submittedAt?: string;
};

/**
 * Find the most recent stamped review. The stamp (not the review `state`)
 * is the marker that a review carrying a fingerprint happened, so a
 * DISMISSED or COMMENTED review counts the same as an APPROVED one.
 */
export const findLatestStamp = (
    reviews: readonly PriorReview[],
): ReReviewStamp | null => {
    const ordered = [...reviews].sort((a, b) => {
        if (a.submittedAt === undefined || b.submittedAt === undefined) {
            return 0;
        }
        return a.submittedAt < b.submittedAt ? -1 : 1;
    });
    for (let i = ordered.length - 1; i >= 0; i--) {
        const stamp = parseRereviewStamp(ordered[i].body);
        if (stamp !== null) {
            return stamp;
        }
    }
    return null;
};

/**
 * Reconstruct a stamp from the Step 9 cache-memory record (the fallback
 * fingerprint carrier; see the module header). Records written before the
 * cache-record CLI landed are model-written, so every field is validated and
 * any gap returns null: a
 * fingerprint we cannot trust anchors nothing, and the depth decision
 * degrades to `full`. The executed depth is not recorded there, so the
 * reconstructed stamp carries `full` (the field is informational; no
 * consumer branches on it).
 */
export const stampFromCacheMemory = (raw: unknown): ReReviewStamp | null => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return null;
    }
    const record = raw as {
        verdict?: unknown;
        stampHunks?: unknown;
        reviewedHunks?: unknown;
        wasDraft?: unknown;
    };
    if (
        record.verdict !== "APPROVE" &&
        record.verdict !== "COMMENT" &&
        record.verdict !== "REQUEST_CHANGES"
    ) {
        return null;
    }
    if (typeof record.wasDraft !== "boolean") {
        return null;
    }
    const validSignature = (hunks: unknown): HunkSignature | null => {
        if (
            typeof hunks !== "object" ||
            hunks === null ||
            Array.isArray(hunks)
        ) {
            return null;
        }
        const signature: HunkSignature = {};
        for (const [path, hashes] of Object.entries(hunks)) {
            if (
                !Array.isArray(hashes) ||
                hashes.some((hash) => typeof hash !== "string" || hash === "")
            ) {
                return null;
            }
            signature[path] = hashes as string[];
        }
        return Object.keys(signature).length === 0 ? null : signature;
    };
    // `stampHunks` is the field Step 9 copies verbatim from the plan CLI's
    // own computation; `reviewedHunks` is accepted for consumers whose
    // Step 9 wrote the code-computed signature there (the scripted-mode
    // staging layer does). A hash-regime mismatch inside either one cannot
    // be detected here; it surfaces as full divergence, i.e. a full review.
    const signature =
        validSignature(record.stampHunks) ??
        validSignature(record.reviewedHunks);
    if (signature === null) {
        return null;
    }
    return {
        schemaVersion: STAMP_SCHEMA_VERSION,
        depth: "full",
        verdict: record.verdict,
        anchorDraft: record.wasDraft,
        anchorHunks: signature,
    };
};

/* -------------------------------------------------------------------------- */
/* The depth decision                                                         */
/* -------------------------------------------------------------------------- */

export type ReReviewDecisionInput = {
    /** The repo's configured mode (`routing.json` `reReviewMode`). */
    mode: ReReviewMode;
    /** Whether the PR is currently a draft. */
    isDraft: boolean;
    /** The most recent stamped fingerprint, or null when none is readable. */
    priorStamp: ReReviewStamp | null;
    /** The hunk signature of the diff under review now. */
    currentSignature: HunkSignature;
    /** Tripwire re-arm threshold; {@link DEFAULT_TRIPWIRE_THRESHOLD}. */
    tripwireThreshold?: number;
    /**
     * An explicit human ask for a review (a `/review` comment posted by a
     * person, `manual-request.ts`'s isManualReviewRequest). Manual requests plan full
     * depth regardless of the configured mode; the point of keeping a
     * comment trigger on an auto-on-push consumer is "give me a real
     * review now", and under `fast` the modes would otherwise answer it
     * with a reconcile-only round. Automation-posted `/review` comments
     * (webapp's shim fires one on every push) are NOT manual: they follow
     * the mode dial like the push they stand in for.
     */
    manualRequest?: boolean;
};

/** Which sub-agents a depth dispatches (the prompt maps this to the roster). */
export type ReReviewDispatch =
    | "all"
    | "reconcile+correctness"
    | "reconcile-only";

/** Which diff the finding-producing reviewers are staged. */
export type ReReviewStaging = "whole-diff" | "new-hunks" | "none";

export type ReReviewPlan = {
    mode: ReReviewMode;
    depth: ReReviewDepth;
    dispatch: ReReviewDispatch;
    staging: ReReviewStaging;
    /**
     * When true, a REQUEST_CHANGES→APPROVE flip requires zero validated
     * blocking findings from the dispatched correctness pass (`flip-gated`).
     */
    flipGate: boolean;
    /** Fixed-format decision codes, most significant first (never prose). */
    reasons: string[];
    /** Divergence vs. the anchor; null when no anchor fingerprint exists. */
    divergence: Divergence | null;
    /** True when the divergence tripwire re-armed a full review. */
    tripwireRearmed: boolean;
    /**
     * The fingerprint this run's stamp must carry: the current signature
     * after a full-depth (`full`/`scoped`) run, the anchor carried forward
     * verbatim otherwise.
     */
    stampHunks: HunkSignature | "overflow";
    /** Draft flag for the stamp (see {@link ReReviewStamp.anchorDraft}). */
    stampAnchorDraft: boolean;
};

const DEPTH_SHAPE: Record<
    ReReviewDepth,
    {dispatch: ReReviewDispatch; staging: ReReviewStaging; flipGate: boolean}
> = {
    full: {dispatch: "all", staging: "whole-diff", flipGate: false},
    scoped: {dispatch: "all", staging: "new-hunks", flipGate: false},
    "flip-gated": {
        dispatch: "reconcile+correctness",
        staging: "new-hunks",
        flipGate: true,
    },
    fast: {dispatch: "reconcile-only", staging: "none", flipGate: false},
};

const fullPlan = (
    input: ReReviewDecisionInput,
    reasons: string[],
    divergence: Divergence | null,
    tripwireRearmed: boolean,
): ReReviewPlan => ({
    mode: input.mode,
    depth: "full",
    ...DEPTH_SHAPE.full,
    reasons,
    divergence,
    tripwireRearmed,
    stampHunks: input.currentSignature,
    stampAnchorDraft: input.isDraft,
});

/**
 * Decide how deep this run reviews. Pure. Every guard resolves toward
 * `full`; a cheaper depth requires a configured mode AND a usable, ready
 * anchor fingerprint AND divergence under the tripwire threshold.
 */
export const decideReReviewDepth = (
    input: ReReviewDecisionInput,
): ReReviewPlan => {
    const threshold = input.tripwireThreshold ?? DEFAULT_TRIPWIRE_THRESHOLD;

    if (input.manualRequest === true) {
        return fullPlan(input, ["manual-review-request"], null, false);
    }
    if (input.mode === "full") {
        return fullPlan(input, ["mode-full"], null, false);
    }
    if (input.priorStamp === null) {
        return fullPlan(input, ["no-prior-fingerprint"], null, false);
    }
    // Ready-for-review anchor: a fingerprint taken on a draft skeleton must
    // not anchor cheap re-reviews of the ready PR; the ready PR gets the
    // one full review the cheaper modes lean on.
    if (!input.isDraft && input.priorStamp.anchorDraft) {
        return fullPlan(input, ["ready-for-review-anchor"], null, false);
    }
    if (input.priorStamp.anchorHunks === "overflow") {
        return fullPlan(input, ["fingerprint-overflow"], null, false);
    }

    const divergence = computeDivergence(
        input.currentSignature,
        input.priorStamp.anchorHunks,
    );
    if (divergence.unreviewedShare >= threshold) {
        return fullPlan(input, ["tripwire-divergence"], divergence, true);
    }

    const depth = input.mode;
    return {
        mode: input.mode,
        depth,
        ...DEPTH_SHAPE[depth],
        reasons: [`mode-${depth}`],
        divergence,
        tripwireRearmed: false,
        stampHunks:
            depth === "scoped"
                ? input.currentSignature
                : input.priorStamp.anchorHunks,
        stampAnchorDraft:
            depth === "scoped" ? input.isDraft : input.priorStamp.anchorDraft,
    };
};

/* -------------------------------------------------------------------------- */
/* Scoped-diff staging                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the diff keeping only the hunks whose hash the fingerprint does
 * not contain; the diff a `scoped`/`flip-gated` run stages to its
 * finding-producing reviewers. Each kept file keeps its section header lines
 * and its in-scope hunks verbatim (original hunk headers included); files
 * with no in-scope hunk are dropped entirely.
 */
export const buildScopedDiff = (
    diffText: string,
    reviewed: HunkSignature,
): string => {
    const kept: string[] = [];
    for (const section of splitUnifiedDiff(diffText)) {
        const seen = new Set(reviewed[section.path] ?? []);
        const hunks = splitPatchHunks(section.text);
        const inScope = hunks.filter((hunk) => !seen.has(hashHunk(hunk)));
        if (inScope.length === 0) {
            continue;
        }
        const firstHunkAt = section.text.search(/^@@ /m);
        const header =
            firstHunkAt === -1
                ? section.text
                : section.text.slice(0, firstHunkAt).replace(/\n$/, "");
        kept.push([header, ...inScope].join("\n"));
    }
    return kept.join("\n");
};

/* -------------------------------------------------------------------------- */
/* CLI entrypoint (review.md invokes this after the router)                   */
/* -------------------------------------------------------------------------- */

/**
 * On-disk contract, extending the run's staging convention.
 *
 * `plan` (the default subcommand) reads the staged diff, preferring
 * `full-stripped.diff` (the provenance CLI's generated-stripped diff) over
 * `full.diff`, so generated churn (a lockfile push) neither enters the
 * fingerprint nor counts as divergence. It also reads `routing.json` (for
 * `reReviewMode`), `pr-context.json` (for `isDraft` and `number`), and
 * `prior-reviews.json` (the bot's prior reviews of this PR, each
 * `{body, submittedAt?}`, every state included, DISMISSED and COMMENTED
 * too). When no prior-review body carries a stamp (in production none ever
 * does; the ingest sanitizer strips it, see the module header), the anchor
 * falls back to `/tmp/gh-aw/cache-memory/pr-<number>.json` via
 * {@link stampFromCacheMemory}. It writes `rereview-plan.json` (the
 * {@link ReReviewPlan}, plus `stampSource`:
 * `"review-body" | "cache-memory" | null`, recording which carrier
 * anchored the plan). When the
 * plan stages `new-hunks` it also writes `scoped.diff` (generated-stripped
 * whenever the stripped diff was the input). A missing or unreadable input
 * degrades the plan to `full` with a fixed-format reason, never to a crash
 * and never to a cheaper depth.
 *
 * `stamp --verdict <EVENT>` runs after the verdict is decided: it reads
 * `rereview-plan.json` back and prints the collapsed-details stamp block
 * the orchestrator appends to the review body it submits.
 */
const REVIEW_DIR = "/tmp/gh-aw/review";
const FULL_DIFF_PATH = `${REVIEW_DIR}/full.diff`;
const STRIPPED_DIFF_PATH = `${REVIEW_DIR}/full-stripped.diff`;
const ROUTING_PATH = `${REVIEW_DIR}/routing.json`;
const PR_CONTEXT_PATH = `${REVIEW_DIR}/pr-context.json`;
const PRIOR_REVIEWS_PATH = `${REVIEW_DIR}/prior-reviews.json`;
const CACHE_MEMORY_DIR = "/tmp/gh-aw/cache-memory";
const PLAN_OUT = `${REVIEW_DIR}/rereview-plan.json`;
const SCOPED_DIFF_OUT = `${REVIEW_DIR}/scoped.diff`;

type RereviewCliFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

const readJsonIfPresent = (fs: RereviewCliFs, path: string): unknown => {
    if (!fs.existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

/** Which carrier anchored the plan's prior fingerprint. */
export type StampSource = "review-body" | "cache-memory" | null;

export type RereviewPlanCliResult = {
    plan: ReReviewPlan;
    /** Fixed-format staging problems (each also forced the plan to full). */
    warnings: string[];
    stampSource: StampSource;
};

/**
 * Stage the re-review plan. Factored out (fs injected, the trigger event
 * name and event-payload path likewise) so it is testable without touching
 * the real filesystem or process env. A comment-triggered run whose comment
 * a human posted ({@link isManualReviewRequest}) is an explicit ask and
 * plans full depth whatever the configured mode says; automation-posted
 * `/review` comments (Khan/webapp's shim fires one per push) follow the
 * mode dial like any push.
 */
export const runRereviewPlanCli = (
    fs: RereviewCliFs,
    eventName: string | undefined = process.env.GITHUB_EVENT_NAME,
    eventPath: string | undefined = process.env.GITHUB_EVENT_PATH,
): RereviewPlanCliResult => {
    const warnings: string[] = [];

    const routing = readJsonIfPresent(fs, ROUTING_PATH) as
        | {reReviewMode?: unknown}
        | undefined;
    let mode = DEFAULT_RE_REVIEW_MODE;
    if (
        routing !== undefined &&
        typeof routing.reReviewMode === "string" &&
        (RE_REVIEW_MODES as readonly string[]).includes(routing.reReviewMode)
    ) {
        mode = routing.reReviewMode as ReReviewMode;
    } else if (routing === undefined) {
        warnings.push(`routing not staged (${ROUTING_PATH}): mode is full`);
    }

    const prContext = readJsonIfPresent(fs, PR_CONTEXT_PATH) as
        | {isDraft?: unknown; number?: unknown}
        | undefined;
    let isDraft = false;
    if (prContext !== undefined && typeof prContext.isDraft === "boolean") {
        isDraft = prContext.isDraft;
    } else {
        warnings.push(
            `pr context not staged (${PR_CONTEXT_PATH}): mode is full`,
        );
        mode = "full";
    }

    // Prefer the generated-stripped diff: reviewers never review generated
    // content, so it belongs in neither the fingerprint nor the divergence
    // share (a lockfile push must not trip the wire).
    const diffPath = fs.existsSync(STRIPPED_DIFF_PATH)
        ? STRIPPED_DIFF_PATH
        : FULL_DIFF_PATH;
    let diffText: string | null = null;
    let currentSignature: HunkSignature = {};
    if (fs.existsSync(diffPath)) {
        diffText = fs.readFileSync(diffPath, "utf8");
        currentSignature = computeHunkSignature(diffText);
    } else {
        warnings.push(`no diff staged (${diffPath}): mode is full`);
        mode = "full";
    }

    const rawReviews = readJsonIfPresent(fs, PRIOR_REVIEWS_PATH);
    const priorReviews: PriorReview[] = Array.isArray(rawReviews)
        ? rawReviews
              .filter(
                  (entry): entry is {body: string; submittedAt?: string} =>
                      typeof (entry as {body?: unknown}).body === "string",
              )
              .map((entry) => ({
                  body: entry.body,
                  ...(typeof entry.submittedAt === "string"
                      ? {submittedAt: entry.submittedAt}
                      : {}),
              }))
        : [];

    let priorStamp = findLatestStamp(priorReviews);
    let stampSource: StampSource = priorStamp === null ? null : "review-body";
    if (priorStamp === null && typeof prContext?.number === "number") {
        priorStamp = stampFromCacheMemory(
            readJsonIfPresent(
                fs,
                `${CACHE_MEMORY_DIR}/pr-${prContext.number}.json`,
            ),
        );
        if (priorStamp !== null) {
            stampSource = "cache-memory";
        }
    }
    const plan = decideReReviewDepth({
        mode,
        isDraft,
        priorStamp,
        currentSignature,
        // GITHUB_EVENT_NAME/GITHUB_EVENT_PATH are the runner's own event
        // env; the CLI runs in pre-agent staging on the runner, never in
        // the agent sandbox.
        manualRequest: isManualReviewRequest(
            eventName,
            commentAuthorFromEvent(fs, eventPath),
        ),
    });

    fs.mkdirSync(REVIEW_DIR, {recursive: true});
    fs.writeFileSync(PLAN_OUT, JSON.stringify({...plan, stampSource}, null, 2));
    // A `new-hunks` plan implies a usable anchor (every guard that loses the
    // anchor resolves to full, whose staging is the whole diff).
    if (
        plan.staging === "new-hunks" &&
        priorStamp !== null &&
        priorStamp.anchorHunks !== "overflow" &&
        diffText !== null
    ) {
        fs.writeFileSync(
            SCOPED_DIFF_OUT,
            buildScopedDiff(diffText, priorStamp.anchorHunks),
        );
    }

    return {plan, warnings, stampSource};
};

/**
 * Render this run's stamp from the staged plan and the decided verdict.
 * Returns null when the plan is not staged (the caller then omits the stamp;
 * the next run degrades to full, never crashes).
 */
export const runRereviewStampCli = (
    fs: RereviewCliFs,
    verdict: string,
): string | null => {
    const plan = readJsonIfPresent(fs, PLAN_OUT) as ReReviewPlan | undefined;
    if (plan === undefined) {
        return null;
    }
    // The verdict is validated at the CLI boundary; hold depth to the same
    // bar. The plan file is code-written but lives in an agent-writable
    // directory, and an unknown depth would render a stamp the parser
    // rejects anyway, so omit the stamp and let the next run plan full.
    if (!(RE_REVIEW_MODES as readonly string[]).includes(plan.depth)) {
        return null;
    }
    // Same bar for anchorDraft: omitting the stamp degrades the NEXT run to
    // full (more review), where the render coercion alone would read
    // non-boolean garbage as `false`, the less-review direction.
    if (typeof plan.stampAnchorDraft !== "boolean") {
        return null;
    }
    // And for stampHunks, the field that drives the next run's scoping: a
    // shape that is neither "overflow" nor a hunk signature omits the stamp
    // rather than encoding garbage the next run would anchor on.
    if (plan.stampHunks !== "overflow" && !isHunkSignature(plan.stampHunks)) {
        return null;
    }
    return renderRereviewStamp({
        schemaVersion: STAMP_SCHEMA_VERSION,
        depth: plan.depth,
        verdict,
        anchorDraft: plan.stampAnchorDraft,
        anchorHunks: plan.stampHunks,
    });
};

// Run only when executed directly (review.md), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as RereviewCliFs;
    const [subcommand = "plan", ...rest] = process.argv.slice(2);
    if (subcommand === "stamp") {
        const flagIndex = rest.indexOf("--verdict");
        const verdict = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
        if (verdict === undefined || !/^[A-Z_]+$/.test(verdict)) {
            // eslint-disable-next-line no-console
            console.error("usage: rereview-mode.ts stamp --verdict <EVENT>");
            process.exit(2);
        }
        const stamp = runRereviewStampCli(fs, verdict);
        if (stamp === null) {
            // eslint-disable-next-line no-console
            console.error(`plan not staged (${PLAN_OUT})`);
            process.exit(1);
        }
        // eslint-disable-next-line no-console
        console.log(stamp);
    } else {
        const result = runRereviewPlanCli(fs);
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify({
                depth: result.plan.depth,
                dispatch: result.plan.dispatch,
                staging: result.plan.staging,
                reasons: result.plan.reasons,
                tripwireRearmed: result.plan.tripwireRearmed,
                unreviewedShare:
                    result.plan.divergence?.unreviewedShare ?? null,
                stampSource: result.stampSource,
                warnings: result.warnings,
            }),
        );
    }
}
