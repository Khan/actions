/**
 * Hunk signatures, divergence, and scoped-diff staging: the content-hashed
 * fingerprint a full review stamps, the drift measure the tripwire reads,
 * and the diff rebuilt from the hunks no fingerprint has seen. Split from
 * `rereview-mode.ts` by the max-lines budget; that module re-exports the
 * names callers imported from it before the split (every export here;
 * `hashHunk` stays module-private as it was), so those imports do not
 * change.
 */

import {createHash} from "node:crypto";

import {splitPatchHunks, splitUnifiedDiff} from "./diff";

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
