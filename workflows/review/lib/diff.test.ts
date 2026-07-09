import {describe, it, expect} from "vitest";

import {
    computeChangedLines,
    countOrphanHunkLines,
    splitUnifiedDiff,
    stripDiffFiles,
} from "./diff.ts";

/**
 * Unit tests for the unified-diff parser feeding the change-provenance gate
 * and the generated-stripped whole-change diff. The fixtures cover the two
 * staging formats review.md allows (git-style headers and bare `---`/`+++`
 * patches), multi-hunk files, pure deletions, and file adds/deletes.
 */

const GIT_DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 111..222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ function handler() {",
    " const a = 1;",
    "-const b = legacy(a);",
    "+const b = modern(a);",
    "+const c = b + 1;",
    " return c;",
    " }",
    "@@ -40,4 +41,3 @@ function teardown() {",
    " cleanup();",
    "-releaseLock();",
    " done();",
    " }",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const x = 1;",
    "+export const y = 2;",
].join("\n");

describe("splitUnifiedDiff", () => {
    it("splits a git-style diff into per-file sections", () => {
        const sections = splitUnifiedDiff(GIT_DIFF);
        expect(sections.map((s) => s.path)).toEqual([
            "src/app.ts",
            "src/new.ts",
        ]);
        expect(sections[0].text).toContain("diff --git a/src/app.ts");
        expect(sections[0].text).toContain("releaseLock");
        expect(sections[0].text).not.toContain("export const x");
    });

    it("splits bare ---/+++ patch sections without git headers", () => {
        const bare = [
            "--- a/one.ts",
            "+++ b/one.ts",
            "@@ -1,2 +1,2 @@",
            "-old",
            "+new",
            " keep",
            "--- a/two.ts",
            "+++ b/two.ts",
            "@@ -1 +1 @@",
            "-x",
            "+y",
        ].join("\n");
        const sections = splitUnifiedDiff(bare);
        expect(sections.map((s) => s.path)).toEqual(["one.ts", "two.ts"]);
    });

    it("does not treat a removed line starting with `--` as a file boundary", () => {
        const tricky = [
            "--- a/sql.ts",
            "+++ b/sql.ts",
            "@@ -1,3 +1,2 @@",
            " const q = `",
            "--- comment inside SQL",
            " `;",
        ].join("\n");
        const sections = splitUnifiedDiff(tricky);
        expect(sections).toHaveLength(1);
        expect(sections[0].path).toBe("sql.ts");
    });

    it("returns no sections for an empty diff", () => {
        expect(splitUnifiedDiff("")).toEqual([]);
    });
});

describe("computeChangedLines", () => {
    it("computes added lines with correct RIGHT-side numbering across hunks", () => {
        const lines = computeChangedLines(GIT_DIFF);
        // Hunk 1: new side starts at 10; ` const a` is 10, the two + lines
        // are 11 and 12.
        expect(lines["src/app.ts"].added).toEqual([11, 12]);
        // New file: both lines added.
        expect(lines["src/new.ts"].added).toEqual([1, 2]);
    });

    it("computes removed lines with LEFT-side numbering", () => {
        const lines = computeChangedLines(GIT_DIFF);
        // Hunk 1 removes old line 11 (`const b = legacy(a)`), hunk 2 removes
        // old line 41 (`releaseLock()`).
        expect(lines["src/app.ts"].removed).toEqual([11, 41]);
    });

    it("brackets a pure deletion with removedAdjacent RIGHT-side lines", () => {
        const lines = computeChangedLines(GIT_DIFF);
        // `releaseLock()` was deleted between new lines 41 (`cleanup();`) and
        // 42 (`done();`); both bracket lines anchor a deletion finding. The
        // modification hunk contributes its own brackets at 10/11.
        expect(lines["src/app.ts"].removedAdjacent).toContain(41);
        expect(lines["src/app.ts"].removedAdjacent).toContain(42);
    });

    it("handles a hunk header without an explicit count", () => {
        const single = [
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1 +1 @@",
            "-x",
            "+y",
        ].join("\n");
        const lines = computeChangedLines(single);
        expect(lines["a.ts"].added).toEqual([1]);
        expect(lines["a.ts"].removed).toEqual([1]);
    });

    it("ignores the no-newline marker", () => {
        const diff = [
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1 +1 @@",
            "-x",
            "\\ No newline at end of file",
            "+y",
            "\\ No newline at end of file",
        ].join("\n");
        expect(computeChangedLines(diff)["a.ts"].added).toEqual([1]);
    });
});

describe("countOrphanHunkLines", () => {
    it("is zero for a fully attributable diff", () => {
        expect(countOrphanHunkLines(GIT_DIFF)).toBe(0);
        expect(countOrphanHunkLines("")).toBe(0);
    });

    it("counts hunk headers stranded before the first file section", () => {
        const partiallyGarbled = [
            // First file's headers were mangled, so its hunk is preamble.
            "dfif --git a/src/lost.ts b/src/lost.ts",
            "@@ -1,2 +1,2 @@",
            "-old",
            "+new",
            " keep",
            "diff --git a/src/kept.ts b/src/kept.ts",
            "--- a/src/kept.ts",
            "+++ b/src/kept.ts",
            "@@ -1 +1 @@",
            "-x",
            "+y",
        ].join("\n");
        expect(countOrphanHunkLines(partiallyGarbled)).toBe(1);
        // The garbled file never becomes a section, which is exactly why the
        // orphan count must be surfaced.
        expect(splitUnifiedDiff(partiallyGarbled).map((s) => s.path)).toEqual([
            "src/kept.ts",
        ]);
    });
});

describe("stripDiffFiles", () => {
    it("removes the named files' sections and keeps the rest verbatim", () => {
        const stripped = stripDiffFiles(GIT_DIFF, new Set(["src/new.ts"]));
        expect(stripped).toContain("diff --git a/src/app.ts");
        expect(stripped).not.toContain("src/new.ts");
        // The kept section's text survives byte-for-byte.
        expect(stripped).toContain("-const b = legacy(a);");
    });

    it("is a no-op for paths not present in the diff", () => {
        const stripped = stripDiffFiles(GIT_DIFF, new Set(["not/there.lock"]));
        expect(computeChangedLines(stripped)).toEqual(
            computeChangedLines(GIT_DIFF),
        );
    });

    it("yields an empty diff when every file is stripped", () => {
        expect(
            stripDiffFiles(GIT_DIFF, new Set(["src/app.ts", "src/new.ts"])),
        ).toBe("");
    });
});
