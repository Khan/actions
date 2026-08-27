/**
 * Content-hashed hunk signatures: the fingerprint primitive the re-review
 * dial compares pushes with (rereview-mode.ts) and the respond-to-review
 * predicate filters hunks by (rereview-respond.ts). Split from
 * rereview-mode.ts, which sits at the shared eslint config's 1000-line file
 * cap; rereview-mode re-exports everything here, so its callers are
 * unaffected.
 */

import {createHash} from "node:crypto";

import {splitPatchHunks, splitUnifiedDiff} from "./diff";

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
