/**
 * Deterministic unified-diff parsing for the review pipeline.
 *
 * Two consumers, both on the determinism boundary:
 *
 *   - the change-provenance gate (`provenance.ts`) needs, per file, exactly
 *     which lines the diff added, removed, or sits adjacent to a removal:
 *     the code-computed fact that decides whether a finding traces to the
 *     change or observes pre-existing code; and
 *   - the staged-diff artifacts: the whole-change reviewers read the full
 *     diff with generated files stripped ({@link stripDiffFiles}), so a
 *     lock-file-heavy PR does not balloon every reviewer's context.
 *
 * This module authors no human-read prose about the code under review: every
 * string it handles is a path, a line number, or the diff text itself.
 */

/** One file's section of a unified diff (header lines included in `text`). */
export type DiffFileSection = {
    /** The file's new-side path (`b/<path>`), or the old path for a deletion. */
    path: string;
    /** The old-side path, when the section names one (`a/<path>`). */
    oldPath?: string;
    /** The section's raw text, from its header line to the next section. */
    text: string;
};

/**
 * The lines a diff changes in one file, all 1-based:
 *
 *   - `added`: RIGHT-side (new file) line numbers of `+` lines.
 *   - `removed`: LEFT-side (old file) line numbers of `-` lines.
 *   - `removedAdjacent`: RIGHT-side line numbers bracketing each removal;
 *     the new-file line where the deleted code used to sit and the line just
 *     before it. A pure deletion leaves no `+` line to anchor on, so a
 *     finding about a dropped guard anchors on one of these; the provenance
 *     gate treats them as change-anchored.
 */
export type FileChangedLines = {
    added: number[];
    removed: number[];
    removedAdjacent: number[];
};

/** Per-file changed-line map for a whole diff, keyed by new-side path. */
export type DiffChangedLines = Record<string, FileChangedLines>;

/** Strip the `a/` / `b/` prefix a git diff puts on header paths. */
const stripGitPrefix = (path: string): string =>
    path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;

/** Parse the two paths off a `diff --git a/<old> b/<new>` line. */
const parseDiffGitLine = (
    line: string,
): {oldPath: string; newPath: string} | null => {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    const oldPath = match?.[1];
    const newPath = match?.[2];
    if (oldPath === undefined || newPath === undefined) {
        return null;
    }
    return {oldPath, newPath};
};

/**
 * Split a unified diff into per-file sections. Sections are recognised by
 * `diff --git` header lines; a diff staged without them (bare per-file
 * patches) is also accepted, using `--- ` / `+++ ` header pairs outside hunk
 * content as the file boundary. `/dev/null` sides (added/deleted files) are
 * handled; the section `path` prefers the new-side name.
 */
export const splitUnifiedDiff = (diff: string): DiffFileSection[] => {
    const lines = diff.split("\n");
    const sections: DiffFileSection[] = [];

    let current: {path?: string; oldPath?: string; lines: string[]} | null =
        null;
    /** Whether the current section began with a `diff --git` header. */
    let currentIsGit = false;
    /** Remaining old/new line counts of the hunk being consumed. */
    let hunkOld = 0;
    let hunkNew = 0;

    const flush = (): void => {
        if (current !== null && current.path !== undefined) {
            sections.push({
                path: current.path,
                ...(current.oldPath !== undefined &&
                current.oldPath !== current.path
                    ? {oldPath: current.oldPath}
                    : {}),
                text: current.lines.join("\n"),
            });
        }
        current = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const inHunk = hunkOld > 0 || hunkNew > 0;

        const gitHeader = parseDiffGitLine(line);
        if (gitHeader !== null) {
            flush();
            hunkOld = 0;
            hunkNew = 0;
            currentIsGit = true;
            current = {
                path: gitHeader.newPath,
                oldPath: gitHeader.oldPath,
                lines: [line],
            };
            continue;
        }

        // Bare-patch boundary: a `--- ` line immediately followed by `+++ `,
        // outside hunk content (a removed line can also start with `--`, so
        // the pairing check is what disambiguates). Inside a `diff --git`
        // section these lines are detail, not a new section; without one they
        // start a section of their own.
        if (
            !inHunk &&
            !currentIsGit &&
            line.startsWith("--- ") &&
            (lines[i + 1] ?? "").startsWith("+++ ")
        ) {
            flush();
            hunkOld = 0;
            hunkNew = 0;
            const oldName = line.slice(4).trim();
            const newName = (lines[i + 1] ?? "").slice(4).trim();
            const oldPath =
                oldName === "/dev/null" ? undefined : stripGitPrefix(oldName);
            const newPath =
                newName === "/dev/null" ? undefined : stripGitPrefix(newName);
            const path = newPath ?? oldPath;
            current = {
                ...(path !== undefined ? {path} : {}),
                ...(oldPath !== undefined ? {oldPath} : {}),
                lines: [],
            };
        }

        if (current === null) {
            // Preamble before any recognisable section: ignored.
            continue;
        }

        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
        if (hunk !== null) {
            hunkOld = Number(hunk[1] ?? "1");
            hunkNew = Number(hunk[2] ?? "1");
        } else if (inHunk) {
            if (line.startsWith("+")) {
                hunkNew = Math.max(0, hunkNew - 1);
            } else if (line.startsWith("-")) {
                hunkOld = Math.max(0, hunkOld - 1);
            } else if (!line.startsWith("\\")) {
                hunkOld = Math.max(0, hunkOld - 1);
                hunkNew = Math.max(0, hunkNew - 1);
            }
        }

        current.lines.push(line);
    }
    flush();

    return sections;
};

/**
 * Compute the per-file changed-line map for a unified diff. Pure: same diff
 * text, same map. Line arrays are sorted ascending and deduplicated.
 */
export const computeChangedLines = (diff: string): DiffChangedLines => {
    const result: DiffChangedLines = {};

    for (const section of splitUnifiedDiff(diff)) {
        const added = new Set<number>();
        const removed = new Set<number>();
        const removedAdjacent = new Set<number>();

        const lines = section.text.split("\n");
        let oldLine = 0;
        let newLine = 0;
        let inHunk = false;

        for (const line of lines) {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (hunk !== null) {
                oldLine = Number(hunk[1] ?? "1");
                newLine = Number(hunk[2] ?? "1");
                inHunk = true;
                continue;
            }
            if (!inHunk) {
                // File headers (`diff --git`, `index`, `---`/`+++`) precede
                // the first hunk; nothing before an `@@` is content.
                continue;
            }
            if (line.startsWith("+")) {
                added.add(newLine);
                newLine++;
            } else if (line.startsWith("-")) {
                removed.add(oldLine);
                oldLine++;
                // The deletion sits between new-file lines newLine-1 and
                // newLine; both bracket lines are change-adjacent anchors.
                if (newLine > 1) {
                    removedAdjacent.add(newLine - 1);
                }
                removedAdjacent.add(newLine);
            } else if (line.startsWith("\\")) {
                // "\ No newline at end of file" consumes nothing.
            } else {
                oldLine++;
                newLine++;
            }
        }

        result[section.path] = {
            added: [...added].sort((a, b) => a - b),
            removed: [...removed].sort((a, b) => a - b),
            removedAdjacent: [...removedAdjacent].sort((a, b) => a - b),
        };
    }

    return result;
};

/**
 * Return the diff with the sections of the given paths removed: the
 * generated-stripped diff the whole-change reviewers read. Section order and
 * text are preserved verbatim for every kept file; a path not present in the
 * diff is ignored. Stripping every file yields an empty string.
 */
export const stripDiffFiles = (
    diff: string,
    pathsToStrip: ReadonlySet<string>,
): string => {
    const kept = splitUnifiedDiff(diff)
        .filter((section) => !pathsToStrip.has(section.path))
        .map((section) => section.text);
    return kept.join("\n");
};
