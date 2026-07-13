/**
 * The change-provenance gate, enforced in code.
 *
 * A review finding must trace to the change under review: it is either
 * introduced by the diff, or it is a pre-existing observation the diff merely
 * sits near. The gate makes that distinction mechanical: a finding whose
 * anchor is not an added or modified line of the diff cannot carry a blocking
 * label and does not post to the PR at all — the set-asides are recorded in
 * the run artifact (for tuning the gate), never as comments. This is what
 * stops a bug fix inside legacy code from drawing blocking reviews of the
 * surrounding known problems the author cannot be asked to fix in that PR.
 * (A pre-existing defect the diff materially *amplifies* passes the gate
 * naturally: the amplifying lines are added or modified lines, so the finding
 * anchors on them.)
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
 * Anchor-snap fallback (the "anchor-snap" rule): reviewers sometimes produce
 * a right-file, right-mechanism finding at a slightly wrong line — observed
 * live as anchors counted against the unified-diff TEXT instead of the file
 * (line 24 of an 18-line file; line 8 of a 3-line file), each one dropped
 * here and occasionally flipping a verdict. Before setting a line-anchored
 * finding aside, the gate tries to snap it to the nearest changed line in
 * the same file, under two windows:
 *
 *   - Near-miss window (`ANCHOR_SNAP_WINDOW`, ±3): the anchor sits within
 *     three lines of a changed line. Three is the unified diff's context
 *     width — a reviewer describing a change it just read anchors at most
 *     one context block away from it.
 *   - Overflow window: the anchor points past the END OF THE FILE (a line
 *     number that does not exist, per the caller-supplied file line count),
 *     past every line the diff showed (`lastShownLine`), and by no more than
 *     the file's diff-text overhead (`textOverhead`: headers + hunk headers +
 *     removed lines). That is exactly the amount by which counting diff text
 *     lines overshoots real file lines, so such an anchor can only be the
 *     counting mis-anchor; it snaps to the last changed line. The
 *     past-the-end condition is load-bearing: an anchor past `lastShownLine`
 *     but still inside the file may be a genuine observation about unshown
 *     code below a hunk (which must keep demoting to advisory, never post as
 *     blocking), so a file whose real line count is unknown gets no overflow
 *     window at all.
 *
 * Snapping is RIGHT-side only (the observed pathology); a LEFT-side anchor
 * never snaps, matching the RIGHT-side-only `snap` table review.md's gate
 * step reads.
 *
 * A snapped finding keeps its severity and continues through the pipeline at
 * the snapped anchor; every snap is reported ({@link ProvenanceGateResult}
 * `snapped`) so the run artifact records the rewrite for audit. Snapping is
 * deliberately narrow: a finding in an untouched region (outside both
 * windows) still demotes to advisory and never posts — the gate's purpose
 * (no blocking reviews of code the PR did not touch) is unchanged; only
 * near-miss anchors are repaired.
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

import {
    annotateDiffLineNumbers,
    computeChangedLines,
    countOrphanHunkLines,
    stripDiffFiles,
} from "./diff";
import type {DiffChangedLines, FileChangedLines} from "./diff";
import type {Anchor, Finding, LineAnchor, Side} from "./finding-schema";

/**
 * The near-miss snap window, in lines: a mis-anchored finding snaps to a
 * changed line at most this far away. Three is the unified diff's context
 * width, so the window never reaches past the context block the reviewer was
 * actually reading when it anchored.
 */
export const ANCHOR_SNAP_WINDOW = 3;

/**
 * The literal token review.md's gate step carries once it documents the
 * anchor-snap rule. The live A/B keys each arm's deterministic gate
 * emulation on {@link reviewMdHasAnchorSnap} over the arm's own review.md,
 * so a baseline arm built from a pre-snap prompt replays the pre-snap gate
 * and the A/B prices the change.
 */
export const ANCHOR_SNAP_MARKER = "anchor-snap";

/** Whether a review.md version documents the anchor-snap gate rule. */
export const reviewMdHasAnchorSnap = (markdown: string): boolean =>
    markdown.includes(ANCHOR_SNAP_MARKER);

/**
 * The changed-line map for a run's diff, plus any warnings from computing it.
 * A non-empty `warnings` means the map is unusable and the gate fails open.
 */
export type DiffProvenance = {
    /** Per-file changed lines, keyed by new-side path. */
    files: DiffChangedLines;
    /**
     * Per-file RIGHT-side anchor-snap lookup, keyed by new-side path: for
     * every line that is NOT change-anchored but sits inside a snap window
     * (see the module doc), the changed line a mis-anchored finding snaps
     * to. Precomputed so the orchestrator's gate (review.md Step 3) applies
     * anchor-snap as a pure dictionary lookup on `provenance.json` — no
     * model-side line arithmetic. Files with nothing to snap are omitted.
     */
    snap: Record<string, Record<number, number>>;
    /**
     * Per-file real line counts (post-change), for the files the caller
     * could read. Feeds the overflow window's past-the-end condition; a file
     * absent here gets near-miss snapping only. Omitted when no counts were
     * supplied.
     */
    fileLineCounts?: Record<string, number>;
    /** Fixed-format staging problems (never prose about the code). */
    warnings: string[];
};

/**
 * Count the lines of a file's content the way editors number them: a
 * trailing newline does not start a final empty line.
 */
export const countFileLines = (content: string): number => {
    if (content === "") {
        return 0;
    }
    const parts = content.split("\n");
    return content.endsWith("\n") ? parts.length - 1 : parts.length;
};

/** The RIGHT-side change-anchored lines of one file, sorted ascending. */
const rightTargets = (entry: FileChangedLines): number[] =>
    [...new Set([...entry.added, ...entry.removedAdjacent])].sort(
        (a, b) => a - b,
    );

/**
 * Snap one line to the nearest changed line of its file, or `null` when no
 * window admits it. Ties (equidistant changed lines above and below) break
 * toward the LOWER line: the observed mis-anchor pathology overshoots (diff
 * text counts past the file line), so the intended line is the earlier one.
 * RIGHT side only: a LEFT-side anchor never snaps (module doc), matching the
 * RIGHT-side-only precomputed table.
 */
export const snapLineToChanged = (
    line: number,
    entry: FileChangedLines,
    side: Side = "RIGHT",
    fileLineCount?: number,
): number | null => {
    if (side === "LEFT") {
        return null;
    }
    const targets = rightTargets(entry);
    if (targets.length === 0) {
        return null;
    }
    let best: number | null = null;
    for (const target of targets) {
        const distance = Math.abs(line - target);
        if (distance > ANCHOR_SNAP_WINDOW) {
            continue;
        }
        if (best === null || distance < Math.abs(line - best)) {
            best = target;
        }
    }
    if (best !== null) {
        return best;
    }
    // Overflow: an anchor past the end of the file AND past every shown
    // line, by no more than the diff-text overhead, is the counting
    // mis-anchor (module doc); its nearest changed line is the file's last
    // one. Without a real line count the past-the-end condition cannot be
    // established, so no overflow window exists (an in-file anchor below the
    // last hunk may be a genuine unshown-code observation).
    const last = targets[targets.length - 1];
    if (
        last !== undefined &&
        fileLineCount !== undefined &&
        line > fileLineCount &&
        line > entry.lastShownLine &&
        line - last <= entry.textOverhead
    ) {
        return last;
    }
    return null;
};

/**
 * Anchor-snap an out-of-provenance line anchor: the snapped single-line
 * anchor, or `null` when the anchor is not a near-miss (kept out of
 * provenance). A range anchor scans its lines ascending and snaps on the
 * first line any window admits — the same order review.md's gate walks the
 * `snap` lookup. Only `line` anchors snap; `file`/`pr` anchors have no line
 * to repair.
 */
export const snapAnchorToProvenance = (
    anchor: Anchor,
    provenance: DiffProvenance,
): LineAnchor | null => {
    if (anchor.type !== "line") {
        return null;
    }
    const entry = provenance.files[anchor.path];
    if (entry === undefined) {
        return null;
    }
    const side = anchor.side ?? "RIGHT";
    if (side === "LEFT") {
        return null;
    }
    const fileLineCount = provenance.fileLineCounts?.[anchor.path];
    const start = anchor.start_line ?? anchor.line;
    for (let line = start; line <= anchor.line; line++) {
        const target = snapLineToChanged(line, entry, side, fileLineCount);
        if (target !== null) {
            return {
                type: "line",
                path: anchor.path,
                line: target,
                ...(anchor.side !== undefined ? {side: anchor.side} : {}),
            };
        }
    }
    return null;
};

/**
 * Precompute one file's RIGHT-side snap lookup: every candidate line either
 * window admits (near-miss lines around each changed line, overflow lines
 * past `lastShownLine`), minus the lines that are already change-anchored.
 * The table and {@link snapLineToChanged} agree by construction — the table
 * is built by calling it.
 */
const buildFileSnapTable = (
    entry: FileChangedLines,
    fileLineCount?: number,
): Record<number, number> => {
    const targets = rightTargets(entry);
    const table: Record<number, number> = {};
    if (targets.length === 0) {
        return table;
    }
    const candidates = new Set<number>();
    for (const target of targets) {
        for (
            let line = target - ANCHOR_SNAP_WINDOW;
            line <= target + ANCHOR_SNAP_WINDOW;
            line++
        ) {
            if (line >= 1) {
                candidates.add(line);
            }
        }
    }
    if (fileLineCount !== undefined) {
        const last = targets[targets.length - 1] ?? 0;
        for (
            let line = entry.lastShownLine + 1;
            line <= last + entry.textOverhead;
            line++
        ) {
            candidates.add(line);
        }
    }
    const anchored = new Set(targets);
    for (const line of [...candidates].sort((a, b) => a - b)) {
        if (anchored.has(line)) {
            continue;
        }
        const target = snapLineToChanged(line, entry, "RIGHT", fileLineCount);
        if (target !== null) {
            table[line] = target;
        }
    }
    return table;
};

/**
 * Compute the provenance map for a diff. Pure. An empty diff produces an
 * empty (and valid) map. Two staging-format failures are flagged so
 * consumers fail open: a non-empty diff that parses to zero file sections,
 * and a diff with hunk headers the splitter could not attribute to any file
 * section (a partially garbled staging — the map would silently miss that
 * file's lines and wrongly demote its findings).
 */
export const computeDiffProvenance = (
    diffText: string,
    fileLineCounts?: Record<string, number>,
): DiffProvenance => {
    const files = computeChangedLines(diffText);
    const warnings: string[] = [];
    if (diffText.trim() !== "" && Object.keys(files).length === 0) {
        warnings.push(
            "diff parsed to zero file sections (staging format?): " +
                "provenance unusable, gate must fail open",
        );
    }
    const orphans = countOrphanHunkLines(diffText);
    if (orphans > 0 && Object.keys(files).length > 0) {
        warnings.push(
            `${orphans} hunk header(s) not attributable to any file section ` +
                "(staging format?): provenance incomplete, gate must fail open",
        );
    }
    // Keep only the counts for files the diff actually touches, so the
    // serialized map never grows beyond the changed-file set.
    const counts: Record<string, number> = {};
    for (const [path, count] of Object.entries(fileLineCounts ?? {})) {
        if (files[path] !== undefined && Number.isInteger(count) && count > 0) {
            counts[path] = count;
        }
    }
    const snap: Record<string, Record<number, number>> = {};
    for (const [path, entry] of Object.entries(files)) {
        const table = buildFileSnapTable(entry, counts[path]);
        if (Object.keys(table).length > 0) {
            snap[path] = table;
        }
    }
    const provenance: DiffProvenance = {files, snap, warnings};
    if (Object.keys(counts).length > 0) {
        provenance.fileLineCounts = counts;
    }
    return provenance;
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

/** One anchor-snap the gate performed, recorded for the run artifact. */
export type SnappedFinding = {
    /** The finding as kept: anchor rewritten to the snapped line. */
    finding: Finding;
    /** The anchor the finding arrived with, before the snap. */
    originalAnchor: Anchor;
};

export type ProvenanceGateResult = {
    /**
     * Change-anchored findings: the set the pipeline posts. Snapped findings
     * appear here with their rewritten anchor (and again in `snapped`).
     */
    kept: Finding[];
    /**
     * Pre-existing observations: out-of-provenance findings with `severity`
     * coerced to `advisory`, so no downstream label computation can render
     * them blocking. They never post to the PR — they are recorded in the run
     * artifact only, so the gate stays inspectable without adding comments.
     */
    preExisting: Finding[];
    /**
     * The anchor-snaps performed (module doc): near-miss mis-anchors kept at
     * a rewritten anchor. Every entry is also in `kept`; this list is the
     * audit trail the run artifact records.
     */
    snapped: SnappedFinding[];
};

export type ProvenanceGateOptions = {
    /**
     * Whether the anchor-snap fallback runs before a finding is set aside.
     * Defaults to true (production behavior). The live A/B's baseline arm
     * passes false when its review.md predates the anchor-snap rule, so the
     * deterministic gate emulates each arm's own prompt version.
     */
    anchorSnap?: boolean;
};

/**
 * Partition findings by change provenance. Pure. When the provenance map is
 * unusable (`warnings` non-empty), every finding is kept (fail open). A
 * line-anchored finding that is out of provenance but inside a snap window
 * is kept at the snapped anchor instead of set aside (module doc), unless
 * `anchorSnap: false`.
 */
export const applyProvenanceGate = (
    findings: readonly Finding[],
    provenance: DiffProvenance,
    options: ProvenanceGateOptions = {},
): ProvenanceGateResult => {
    const anchorSnap = options.anchorSnap ?? true;
    if (provenance.warnings.length > 0) {
        return {kept: [...findings], preExisting: [], snapped: []};
    }
    const kept: Finding[] = [];
    const preExisting: Finding[] = [];
    const snapped: SnappedFinding[] = [];
    for (const finding of findings) {
        if (isAnchorInProvenance(finding.anchor, provenance)) {
            kept.push(finding);
            continue;
        }
        const snappedAnchor = anchorSnap
            ? snapAnchorToProvenance(finding.anchor, provenance)
            : null;
        if (snappedAnchor !== null) {
            const rewritten = {...finding, anchor: snappedAnchor};
            kept.push(rewritten);
            snapped.push({finding: rewritten, originalAnchor: finding.anchor});
        } else {
            preExisting.push({...finding, severity: "advisory"});
        }
    }
    return {kept, preExisting, snapped};
};

/* -------------------------------------------------------------------------- */
/* CLI entrypoint (review.md Step 3 invokes this after the router)            */
/* -------------------------------------------------------------------------- */

/**
 * On-disk contract, extending the run's staging convention: reads the staged
 * `full.diff`, `files.json` (whose `hasPatch` flags feed the completeness
 * cross-check), and the router's `routing.json` (for its `generatedFiles`
 * list); writes `provenance.json` (the {@link DiffProvenance} map the
 * orchestrator's blocking-label gate reads) and `full-stripped.diff` (the
 * full diff minus generated-file sections, for the whole-change reviewers).
 * When `routing.json` is missing or carries no `generatedFiles`, the stripped
 * diff equals the full diff; stripping degrades to a no-op, never a crash.
 */
const REVIEW_DIR = "/tmp/gh-aw/review";
const FULL_DIFF_PATH = `${REVIEW_DIR}/full.diff`;
const FILES_PATH = `${REVIEW_DIR}/files.json`;
const ROUTING_PATH = `${REVIEW_DIR}/routing.json`;
const PROVENANCE_OUT = `${REVIEW_DIR}/provenance.json`;
const STRIPPED_DIFF_OUT = `${REVIEW_DIR}/full-stripped.diff`;
const ANNOTATED_DIFF_OUT = `${REVIEW_DIR}/full-stripped-annotated.diff`;

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
 *
 * `workspaceRoot` is the PR checkout (production: `$GITHUB_WORKSPACE`); the
 * changed files are read from it to establish real line counts, which the
 * overflow snap window's past-the-end condition requires. When the root is
 * absent or a file is unreadable, that file simply gets no overflow window
 * (near-miss snapping still applies) — never a crash.
 */
export const runProvenanceCli = (
    fs: ProvenanceCliFs,
    workspaceRoot?: string,
): ProvenanceCliResult => {
    const diffText = fs.existsSync(FULL_DIFF_PATH)
        ? fs.readFileSync(FULL_DIFF_PATH, "utf8")
        : "";

    const fileLineCounts: Record<string, number> = {};
    if (workspaceRoot !== undefined && workspaceRoot !== "") {
        for (const path of Object.keys(computeChangedLines(diffText))) {
            const onDisk = `${workspaceRoot}/${path}`;
            if (!fs.existsSync(onDisk)) {
                continue;
            }
            try {
                fileLineCounts[path] = countFileLines(
                    fs.readFileSync(onDisk, "utf8"),
                );
            } catch {
                // Unreadable file: no overflow window for it (fail narrow).
            }
        }
    }

    const provenance = computeDiffProvenance(diffText, fileLineCounts);
    if (!fs.existsSync(FULL_DIFF_PATH)) {
        provenance.warnings.push(
            `full diff not staged (${FULL_DIFF_PATH}): provenance unusable, ` +
                "gate must fail open",
        );
    }

    // Completeness cross-check: every changed file `get_files` returned a
    // patch for (`hasPatch` in files.json) must appear in the parsed map. A
    // file that is missing means its section was garbled or absorbed into a
    // neighbor, and working from the incomplete map would wrongly demote
    // that file's findings — so this too is a fail-open warning. Entries
    // without a `hasPatch` field (older staging) are not checked.
    if (fs.existsSync(FILES_PATH)) {
        const raw: unknown = JSON.parse(fs.readFileSync(FILES_PATH, "utf8"));
        const entries: unknown[] = Array.isArray(raw)
            ? raw
            : (raw as {files?: unknown[]})?.files ?? [];
        const missing: string[] = [];
        for (const entry of entries) {
            const rec = entry as {path?: unknown; hasPatch?: unknown};
            if (
                rec.hasPatch === true &&
                typeof rec.path === "string" &&
                provenance.files[rec.path] === undefined
            ) {
                missing.push(rec.path);
            }
        }
        if (missing.length > 0) {
            const shown = missing.slice(0, 5).join(", ");
            const more =
                missing.length > 5 ? ` and ${missing.length - 5} more` : "";
            provenance.warnings.push(
                `changed files with patches missing from the parsed diff ` +
                    `(${shown}${more}): provenance incomplete, gate must ` +
                    "fail open",
            );
        }
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
    const stripped = stripDiffFiles(diffText, strip);
    fs.writeFileSync(STRIPPED_DIFF_OUT, stripped);
    // The line-number-annotated sibling the finding-producing reviewers
    // read. Prompt-facing only: everything that PARSES a diff (this module,
    // re-review fingerprints, scoped staging) keeps reading the raw files,
    // so hunk signatures and the changed-line map never see annotations.
    fs.writeFileSync(ANNOTATED_DIFF_OUT, annotateDiffLineNumbers(stripped));

    return {provenance, strippedFiles};
};

/**
 * `annotate <in> <out>` subcommand: write a line-number-annotated copy of a
 * staged diff (review.md Phase 1 runs it on `pr.diff`, and the scoped depth
 * re-runs it after overwriting the stripped diff). Factored for tests.
 */
export const runAnnotateCli = (
    fs: Pick<ProvenanceCliFs, "readFileSync" | "writeFileSync">,
    inPath: string,
    outPath: string,
): void => {
    fs.writeFileSync(
        outPath,
        annotateDiffLineNumbers(fs.readFileSync(inPath, "utf8")),
    );
};

// Run only when executed directly (review.md Step 3), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as ProvenanceCliFs;
    if (process.argv[2] === "annotate") {
        const [inPath, outPath] = process.argv.slice(3);
        if (inPath === undefined || outPath === undefined) {
            throw new Error("usage: provenance.ts annotate <in> <out>");
        }
        runAnnotateCli(fs, inPath, outPath);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({annotated: outPath}));
        process.exit(0);
    }
    const result = runProvenanceCli(fs, process.env.GITHUB_WORKSPACE);
    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify({
            files: Object.keys(result.provenance.files).length,
            snapLines: Object.values(result.provenance.snap).reduce(
                (count, table) => count + Object.keys(table).length,
                0,
            ),
            strippedFiles: result.strippedFiles,
            warnings: result.provenance.warnings,
        }),
    );
}
