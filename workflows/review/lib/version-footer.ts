/**
 * The visible attribution footer: release version, finding-schema version,
 * executed re-review depth, the repo's re-review mode line, and the ROUTING
 * enable list, rendered as one `<sub>` line appended to every submitted
 * review body and to the risks/patterns guidance comment.
 *
 * Why visible and why code-rendered: the original attribution surface was a
 * hidden HTML marker (`<!-- pr-reviewer:version ... -->`) the orchestrator
 * was prompted to compose, but gh-aw's safe-output ingest sanitizer deletes
 * ALL XML/HTML comments (`removeXmlComments` in `sanitize_content_core.cjs`;
 * the same strip that already killed the fingerprint stamp, see
 * rereview-mode.ts), so the marker never reached a single posted comment:
 * verified on all 9 guidance comments and 13 review bodies posted to
 * Khan/webapp on 2026-08-11/12. `<sub>` is on the sanitizer's allowed-tag
 * list (GFM-safe tags, sanitize_content_core.cjs v0.83.4), so this footer
 * survives ingest byte-for-byte; rendering it in code (from package.json and
 * the staged run files, never from the model's memory) keeps the attribution
 * trustworthy for rollback decisions.
 *
 * The hidden version marker instruction is retired from review.md Step 7;
 * the fingerprint stamp emission stays (rereview-mode.ts explains why).
 */

import {FINDING_SCHEMA_VERSION} from "./finding-schema";

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
    /** The ROUTING `enable` list (canonical order, from routing.json). */
    enabledReviewers: string[];
};

/**
 * Render the footer line. Pure; every segment that cannot be stated is
 * omitted rather than guessed, so a degraded staging yields a shorter
 * footer, never a wrong one. Contains no HTML comment by construction (the
 * sanitizer would delete one).
 */
export const renderVersionFooter = (inputs: VersionFooterInputs): string => {
    const segments: string[] = [];
    if (inputs.version !== null && inputs.version !== "") {
        segments.push(`review-v${inputs.version}`);
    }
    segments.push(`schema ${inputs.schemaVersion}`);
    if (inputs.depth !== null && inputs.depth !== "") {
        segments.push(`depth ${inputs.depth}`);
    }
    if (inputs.reReviewMode !== null && inputs.reReviewMode !== "") {
        segments.push(
            `re-review ${inputs.reReviewMode}${
                inputs.blockingOnly ? " blocking-only" : ""
            }`,
        );
    }
    if (inputs.enabledReviewers.length > 0) {
        segments.push(`enable ${inputs.enabledReviewers.join(",")}`);
    }
    return `<sub>${segments.join(" | ")}</sub>`;
};

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
 * {@link FOOTER_OUT} (review.md Step 7 pastes the staged line verbatim into
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
 *     and the enable list.
 *
 * Every read fails toward omission: a missing or malformed file drops its
 * segments and the footer still renders (schema is a compile-time constant,
 * so the footer is never empty).
 */
export const runVersionFooterCli = (
    fs: VersionFooterFs,
    libDir: string = __dirname,
    overrides: {depth?: string | null} = {},
): string => {
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
              enabledReviewers?: unknown;
          }
        | undefined;
    const footer = renderVersionFooter({
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
        enabledReviewers: Array.isArray(routing?.enabledReviewers)
            ? routing.enabledReviewers.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [],
    });
    fs.writeFileSync(FOOTER_OUT, footer);
    return footer;
};

// Run only when executed directly (review.md Step 7 can re-stage the
// footer), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as VersionFooterFs;
    // eslint-disable-next-line no-console
    console.log(runVersionFooterCli(fs));
}
