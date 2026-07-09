/**
 * The change-provenance gate, enforced in code.
 *
 * A review finding must trace to the change under review: it is either
 * introduced by the diff, or it is a pre-existing observation the diff merely
 * sits near. The gate makes that distinction mechanical: a finding whose
 * anchor is not an added or modified line of the diff cannot carry a blocking
 * label, and pre-existing observations collapse into at most one non-blocking
 * note (`renderPreExistingNote` in `render-comment.ts`) instead of posting as
 * individual comments. This is what stops a bug fix inside legacy code from
 * drawing blocking reviews of the surrounding known problems the author cannot
 * be asked to fix in that PR. (A pre-existing defect the diff materially
 * *amplifies* passes the gate naturally: the amplifying lines are added or
 * modified lines, so the finding anchors on them.)
 *
 * The line-level facts come from `diff.ts` ({@link computeChangedLines});
 * anchors are judged as follows:
 *
 *   - `pr` anchors are change-anchored by definition (they describe the
 *     change as a whole).
 *   - `file` anchors are change-anchored when the file appears in the diff.
 *   - RIGHT-side `line` anchors are change-anchored when the line (or any
 *     line of the range) is an added line or brackets a removal (a pure
 *     deletion leaves no `+` line, so deletion findings anchor adjacent).
 *   - LEFT-side `line` anchors are change-anchored when the line is a
 *     removed line.
 *
 * Fail-open guarantee: when the diff cannot be parsed into file sections at
 * all (a staging-format problem, not a property of the findings), the gate
 * keeps everything and reports the warning; a broken artifact must degrade
 * to the pre-gate behavior, never demote every finding on the run.
 *
 * The CLI at the bottom stages the two derived diff artifacts for a run:
 * `provenance.json` (this module's changed-line map) and `full-stripped.diff`
 * (the full diff minus generated files, which the whole-change reviewers read
 * so a lock-file-heavy PR does not balloon their context).
 *
 * Determinism boundary: every decision here is a pure function of the diff
 * text and the finding anchors; no string emitted is a sentence about the
 * code under review.
 */

import {computeChangedLines, stripDiffFiles} from "./diff";
import type {DiffChangedLines} from "./diff";
import type {Anchor, Finding} from "./finding-schema";

/**
 * The changed-line map for a run's diff, plus any warnings from computing it.
 * A non-empty `warnings` means the map is unusable and the gate fails open.
 */
export type DiffProvenance = {
    /** Per-file changed lines, keyed by new-side path. */
    files: DiffChangedLines;
    /** Fixed-format staging problems (never prose about the code). */
    warnings: string[];
};

/**
 * Compute the provenance map for a diff. Pure. An empty diff produces an
 * empty (and valid) map; a non-empty diff that parses to zero file sections
 * is a staging-format failure and is flagged so consumers fail open.
 */
export const computeDiffProvenance = (diffText: string): DiffProvenance => {
    const files = computeChangedLines(diffText);
    const warnings: string[] = [];
    if (diffText.trim() !== "" && Object.keys(files).length === 0) {
        warnings.push(
            "diff parsed to zero file sections (staging format?): " +
                "provenance unusable, gate must fail open",
        );
    }
    return {files, warnings};
};

/**
 * Whether a finding anchor traces to the change (see the module doc for the
 * per-anchor-type rules). Pure.
 */
export const isAnchorInProvenance = (
    anchor: Anchor,
    provenance: DiffProvenance,
): boolean => {
    if (anchor.type === "pr") {
        return true;
    }
    const entry = provenance.files[anchor.path];
    if (entry === undefined) {
        return false;
    }
    if (anchor.type === "file") {
        return true;
    }
    const changeAnchored =
        anchor.side === "LEFT"
            ? new Set(entry.removed)
            : new Set([...entry.added, ...entry.removedAdjacent]);
    const start = anchor.start_line ?? anchor.line;
    for (let line = start; line <= anchor.line; line++) {
        if (changeAnchored.has(line)) {
            return true;
        }
    }
    return false;
};

export type ProvenanceGateResult = {
    /** Change-anchored findings, unchanged: the set the pipeline posts. */
    kept: Finding[];
    /**
     * Pre-existing observations: out-of-provenance findings with `severity`
     * coerced to `advisory`, so no downstream label computation can render
     * them blocking. They post as at most one collapsed note
     * (`renderPreExistingNote`), never as individual comments.
     */
    preExisting: Finding[];
};

/**
 * Partition findings by change provenance. Pure. When the provenance map is
 * unusable (`warnings` non-empty), every finding is kept (fail open).
 */
export const applyProvenanceGate = (
    findings: readonly Finding[],
    provenance: DiffProvenance,
): ProvenanceGateResult => {
    if (provenance.warnings.length > 0) {
        return {kept: [...findings], preExisting: []};
    }
    const kept: Finding[] = [];
    const preExisting: Finding[] = [];
    for (const finding of findings) {
        if (isAnchorInProvenance(finding.anchor, provenance)) {
            kept.push(finding);
        } else {
            preExisting.push({...finding, severity: "advisory"});
        }
    }
    return {kept, preExisting};
};

/* -------------------------------------------------------------------------- */
/* CLI entrypoint (review.md Step 3 invokes this after the router)            */
/* -------------------------------------------------------------------------- */

/**
 * On-disk contract, extending the run's staging convention: reads the staged
 * `full.diff` and the router's `routing.json` (for its `generatedFiles`
 * list); writes `provenance.json` (the {@link DiffProvenance} map the
 * orchestrator's blocking-label gate reads) and `full-stripped.diff` (the
 * full diff minus generated-file sections, for the whole-change reviewers).
 * When `routing.json` is missing or carries no `generatedFiles`, the stripped
 * diff equals the full diff; stripping degrades to a no-op, never a crash.
 */
const REVIEW_DIR = "/tmp/gh-aw/review";
const FULL_DIFF_PATH = `${REVIEW_DIR}/full.diff`;
const ROUTING_PATH = `${REVIEW_DIR}/routing.json`;
const PROVENANCE_OUT = `${REVIEW_DIR}/provenance.json`;
const STRIPPED_DIFF_OUT = `${REVIEW_DIR}/full-stripped.diff`;

type ProvenanceCliFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

export type ProvenanceCliResult = {
    provenance: DiffProvenance;
    /** Generated-file paths stripped from the whole-change diff. */
    strippedFiles: string[];
};

/**
 * Stage the derived diff artifacts. Factored out (fs injected) so it is
 * testable without touching the real filesystem. Returns what was written.
 */
export const runProvenanceCli = (fs: ProvenanceCliFs): ProvenanceCliResult => {
    const diffText = fs.existsSync(FULL_DIFF_PATH)
        ? fs.readFileSync(FULL_DIFF_PATH, "utf8")
        : "";

    const provenance = computeDiffProvenance(diffText);
    if (!fs.existsSync(FULL_DIFF_PATH)) {
        provenance.warnings.push(
            `full diff not staged (${FULL_DIFF_PATH}): provenance unusable, ` +
                "gate must fail open",
        );
    }

    let generatedFiles: string[] = [];
    if (fs.existsSync(ROUTING_PATH)) {
        const routing = JSON.parse(fs.readFileSync(ROUTING_PATH, "utf8")) as {
            generatedFiles?: unknown;
        };
        if (
            Array.isArray(routing.generatedFiles) &&
            routing.generatedFiles.every((p) => typeof p === "string")
        ) {
            generatedFiles = routing.generatedFiles as string[];
        }
    }
    const strip = new Set(generatedFiles);
    const strippedFiles = generatedFiles.filter(
        (path) => provenance.files[path] !== undefined,
    );

    fs.mkdirSync(REVIEW_DIR, {recursive: true});
    fs.writeFileSync(PROVENANCE_OUT, JSON.stringify(provenance, null, 2));
    fs.writeFileSync(STRIPPED_DIFF_OUT, stripDiffFiles(diffText, strip));

    return {provenance, strippedFiles};
};

// Run only when executed directly (review.md Step 3), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as ProvenanceCliFs;
    const result = runProvenanceCli(fs);
    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify({
            files: Object.keys(result.provenance.files).length,
            strippedFiles: result.strippedFiles,
            warnings: result.provenance.warnings,
        }),
    );
}
