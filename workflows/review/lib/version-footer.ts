/**
 * The version/config footer: release version, finding-schema version,
 * executed re-review depth, the repo's re-review mode line, and the ROUTING
 * enable list, rendered as one `<sub>` line inside the shared collapsed
 * `<details>` block (attribution.ts) appended to every submitted review
 * body and to the risks/patterns guidance comment. Collapsed by default:
 * the footer is run metadata, not review content, so it renders as one
 * small summary chip until expanded.
 *
 * Why posted-and-visible-on-expand, and why code-rendered: the original
 * attribution surface was a hidden HTML marker
 * (`<!-- pr-reviewer:version ... -->`) the orchestrator was prompted to
 * compose, but gh-aw's safe-output ingest sanitizer deletes ALL XML/HTML
 * comments (`removeXmlComments` in `sanitize_content_core.cjs`; the same
 * strip that already killed the fingerprint stamp, see rereview-mode.ts),
 * so the marker never reached a single posted comment: verified on all 9
 * guidance comments and 13 review bodies posted to Khan/webapp on
 * 2026-08-11/12. `sub`, `details`, and `summary` are all on the sanitizer's
 * allowed-tag list (GFM-safe tags, sanitize_content_core.cjs v0.83.4), so
 * this footer survives ingest byte-for-byte; rendering it in code (from
 * package.json and the staged run files, never from the model's memory)
 * keeps the attribution trustworthy for rollback decisions.
 *
 * The hidden version marker instruction is retired from review.md Step 7;
 * the fingerprint stamp emission stays (rereview-mode.ts explains why).
 */

import {canarySegment, renderCollapsedFooter} from "./attribution";
import {FINDING_SCHEMA_VERSION} from "./finding-schema";
import {DEFAULT_NON_BLOCKING_INLINE_BUDGET} from "./routing-config";

const REVIEW_DIR = "/tmp/gh-aw/review";

/** Where the CLI stages the rendered footer for review.md Step 7 to paste. */
export const FOOTER_OUT = `${REVIEW_DIR}/version-footer.txt`;

export type VersionFooterFs = {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
};

/** Everything the footer carries. Null/empty fields drop their segment. */
export type VersionFooterInputs = {
    /** The `version` field of workflows/review/package.json (the pinned release). */
    version: string | null;
    /** FINDING_SCHEMA_VERSION the run executed. */
    schemaVersion: number;
    /** The EXECUTED re-review depth (dispatch result, not the configured mode). */
    depth: string | null;
    /** The repo's `re-review` mode line from ROUTING (routing.json). */
    reReviewMode: string | null;
    /** The ROUTING `blocking-only` modifier. */
    blockingOnly: boolean;
    /** The ROUTING `blocking-medium` modifier. */
    blockingMedium: boolean;
    /** The ROUTING `enable` list (canonical order, from routing.json). */
    enabledReviewers: string[];
    /** The ROUTING `non-blocking-budget` value; null drops the segment, and
     * the default value is omitted too (the footer states configuration,
     * not defaults). */
    nonBlockingInlineBudget: number | null;
    /**
     * The PR head sha a canary run executed (REVIEW_CANARY_SHA, set only by
     * the canary workflow). The version segment alone would lie on a canary
     * run: package.json still carries the last released version while the
     * code is the PR head, so the footer names the sha that actually ran.
     * Absent or empty drops the segment (every production run).
     */
    canarySha?: string | null;
};

/** The ` | `-joined segment text both footer forms wrap. */
const footerSegments = (inputs: VersionFooterInputs): string => {
    const segments: string[] = [];
    if (inputs.version !== null && inputs.version !== "") {
        segments.push(`review-v${inputs.version}`);
    }
    if (typeof inputs.canarySha === "string" && inputs.canarySha !== "") {
        segments.push(canarySegment(inputs.canarySha));
    }
    segments.push(`schema ${inputs.schemaVersion}`);
    if (inputs.depth !== null && inputs.depth !== "") {
        segments.push(`depth ${inputs.depth}`);
    }
    if (inputs.reReviewMode !== null && inputs.reReviewMode !== "") {
        segments.push(
            `re-review ${inputs.reReviewMode}${
                inputs.blockingOnly
                    ? " blocking-only"
                    : inputs.blockingMedium
                    ? " blocking-medium"
                    : ""
            }`,
        );
    }
    if (inputs.enabledReviewers.length > 0) {
        segments.push(`enable ${inputs.enabledReviewers.join(",")}`);
    }
    if (
        typeof inputs.nonBlockingInlineBudget === "number" &&
        inputs.nonBlockingInlineBudget !== DEFAULT_NON_BLOCKING_INLINE_BUDGET
    ) {
        segments.push(`non-blocking-budget ${inputs.nonBlockingInlineBudget}`);
    }
    return segments.join(" | ");
};

/**
 * Render the bare footer LINE (one `<sub>` span, no `<details>` wrapper).
 * Pure; every segment that cannot be stated is omitted rather than guessed,
 * so a degraded staging yields a shorter footer, never a wrong one. Contains
 * no HTML comment by construction (the sanitizer would delete one).
 *
 * This is the form the review body carries since KORE-2632: the body's tail
 * has ONE fold (attribution.ts's renderReviewDetailsFold) holding the
 * collapsed observations, this line, and the fingerprint line, rather than
 * three stacked expandos.
 */
export const renderVersionFooterLine = (inputs: VersionFooterInputs): string =>
    `<sub>${footerSegments(inputs)}</sub>`;

/**
 * The footer wrapped in its own collapsed `<details>` block. Still the shape
 * review.md Step 7 pastes into the risks/patterns guidance comment: that
 * comment has no review body around it to fold into, so the footer carries
 * its own chip there.
 */
export const renderVersionFooter = (inputs: VersionFooterInputs): string =>
    renderCollapsedFooter(footerSegments(inputs));

/**
 * Whether a posted body carries the canary footer segment. The production
 * staging (stage-pr.ts) drops such reviews from prior-reviews.json before
 * anything downstream reads them: both workflows post as the same bot
 * identity, and a canary review admitted as reviewer history would anchor
 * the production re-review plan on a stamp unreleased code produced (and
 * make its clearance treat a canary verdict as its own standing state).
 * Matched inside a `<sub>` line so a review that merely QUOTES the segment
 * in prose is not misfiled; the emission side (renderVersionFooter above)
 * and this predicate live in one module so they cannot drift.
 */
export const hasCanaryFooter = (body: string): boolean =>
    /<sub>[^<]*\bcanary [0-9a-f]{7,40}\b[^<]*<\/sub>/.test(body);

const readJson = (fs: VersionFooterFs, path: string): unknown => {
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
 * Compose the footer from the staged run files and stage it at
 * {@link FOOTER_OUT} (review.md Step 7 pastes the staged block verbatim into
 * the guidance comment; the submission CLI appends the returned string to
 * the review body). Reads:
 *
 *   - `libDir/../package.json` for the release version (in the pinned
 *     checkout that is `gh-aw-review-lib/workflows/review/package.json`);
 *   - `dispatch-result.json` for the executed depth (no fallback: a
 *     planned depth is a guess about what executed, so an unusable
 *     dispatch result drops the segment like every other unstateable
 *     field). The submission CLI passes its canonical executed depth in
 *     `overrides` so the footer and the depth Note cannot contradict;
 *   - `routing.json` for the re-review mode, the blocking-only modifier,
 *     and the enable list;
 *   - the env (injectable; production reads `process.env`) for
 *     `REVIEW_CANARY_SHA`, the canary workflow's head-sha stamp.
 *
 * Every read fails toward omission: a missing or malformed file drops its
 * segments and the footer still renders (schema is a compile-time constant,
 * so the footer is never empty).
 */
export const runVersionFooterCli = (
    fs: VersionFooterFs,
    libDir: string = __dirname,
    overrides: {depth?: string | null} = {},
    env: {REVIEW_CANARY_SHA?: string} = process.env,
): string => {
    const footer = renderVersionFooter(
        readVersionFooterInputs(fs, libDir, overrides, env),
    );
    fs.writeFileSync(FOOTER_OUT, footer);
    return footer;
};

/**
 * The same staging, returning the BARE `<sub>` line instead of the wrapped
 * block. A sibling entrypoint rather than an options flag on
 * {@link runVersionFooterCli} because the two callers want different things
 * and neither wants a branch: review.md Step 7 reads the staged file and
 * needs the self-contained block, while submission.ts folds the line into
 * the review body's single `review details` fold (KORE-2632) and must not
 * nest a second `<details>` inside it. Both stage the WRAPPED form at
 * {@link FOOTER_OUT}, so Step 7 is unaffected by which one the run called.
 */
export const runVersionFooterLineCli = (
    fs: VersionFooterFs,
    libDir: string = __dirname,
    overrides: {depth?: string | null} = {},
    env: {REVIEW_CANARY_SHA?: string} = process.env,
): string => {
    const inputs = readVersionFooterInputs(fs, libDir, overrides, env);
    fs.writeFileSync(FOOTER_OUT, renderVersionFooter(inputs));
    return renderVersionFooterLine(inputs);
};

/** The staged-file reads both entrypoints share. */
const readVersionFooterInputs = (
    fs: VersionFooterFs,
    libDir: string,
    overrides: {depth?: string | null},
    env: {REVIEW_CANARY_SHA?: string},
): VersionFooterInputs => {
    const pkg = readJson(fs, `${libDir}/../package.json`) as
        | {version?: unknown}
        | undefined;
    const dispatch = readJson(fs, `${REVIEW_DIR}/dispatch-result.json`) as
        | {depth?: unknown}
        | undefined;
    const routing = readJson(fs, `${REVIEW_DIR}/routing.json`) as
        | {
              reReviewMode?: unknown;
              reReviewBlockingOnly?: unknown;
              reReviewBlockingMedium?: unknown;
              enabledReviewers?: unknown;
              nonBlockingInlineBudget?: unknown;
          }
        | undefined;
    return {
        version: typeof pkg?.version === "string" ? pkg.version : null,
        schemaVersion: FINDING_SCHEMA_VERSION,
        depth:
            overrides.depth !== undefined
                ? overrides.depth
                : typeof dispatch?.depth === "string"
                ? dispatch.depth
                : null,
        reReviewMode:
            typeof routing?.reReviewMode === "string"
                ? routing.reReviewMode
                : null,
        blockingOnly: routing?.reReviewBlockingOnly === true,
        blockingMedium: routing?.reReviewBlockingMedium === true,
        enabledReviewers: Array.isArray(routing?.enabledReviewers)
            ? routing.enabledReviewers.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [],
        nonBlockingInlineBudget:
            typeof routing?.nonBlockingInlineBudget === "number"
                ? routing.nonBlockingInlineBudget
                : null,
        canarySha: env.REVIEW_CANARY_SHA ?? null,
    };
};

// Run only when executed directly (review.md Step 7 can re-stage the
// footer), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as VersionFooterFs;
    // eslint-disable-next-line no-console
    console.log(runVersionFooterCli(fs));
}
