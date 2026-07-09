import {describe, it, expect} from "vitest";

import {renderReviewBody} from "./render-comment";
import {
    excerptOpeningComment,
    parseLeadingLabel,
    renderRereviewSection,
    runRereviewCli,
    type RereviewCliFs,
    type StagedThread,
} from "./rereview";

/**
 * Re-review accountability tests.
 *
 * The production failure this module exists for (the review-v1.4.0 re-run
 * lifecycle on Khan/webapp#40730): run 2 resolved fixed threads and said
 * nothing about the three blocking threads it kept open, under a bare
 * "Changes requested" body; run 3 approved with an empty body while resolving
 * 11 threads. The section must therefore (a) enumerate every kept thread as a
 * link to its prior comment, blocking first, and (b) state the resolution
 * count, including the all-resolved case an approval rides on.
 */

const thread = (overrides: Partial<StagedThread>): StagedThread => ({
    thread_id: "PRRT_x",
    path: "services/foo/foo.go",
    line: 12,
    url: "https://github.com/o/r/pull/1#discussion_r100",
    comments: [
        {
            author: "github-actions",
            body: "**issue (blocking):** The guard was removed.",
        },
    ],
    ...overrides,
});

describe("parseLeadingLabel", () => {
    it("extracts the label from the workflow's own comment template", () => {
        expect(parseLeadingLabel("**issue (blocking):** Broken.")).toBe(
            "issue (blocking)",
        );
        expect(
            parseLeadingLabel(
                "**suggestion (non-blocking, best-practice):** Consider X.",
            ),
        ).toBe("suggestion (non-blocking, best-practice)");
        expect(parseLeadingLabel("**todo (blocking):** Add the field.")).toBe(
            "todo (blocking)",
        );
    });

    it("returns null for a body that does not start with the template", () => {
        expect(parseLeadingLabel("Plain reply text.")).toBeNull();
        expect(parseLeadingLabel("prefix **issue (blocking):** x")).toBeNull();
    });
});

describe("excerptOpeningComment", () => {
    it("strips the label prefix and keeps the first line", () => {
        expect(
            excerptOpeningComment(
                "**issue (blocking):** First line.\nSecond line.",
            ),
        ).toBe("First line.");
    });

    it("truncates deterministically past the cap", () => {
        const long = `**issue (blocking):** ${"a".repeat(300)}`;
        const excerpt = excerptOpeningComment(long);
        expect(excerpt.endsWith("...")).toBe(true);
        expect(excerpt.length).toBeLessThanOrEqual(123);
    });

    it("passes a label-less body through verbatim", () => {
        expect(excerptOpeningComment("No label here.")).toBe("No label here.");
    });
});

describe("renderRereviewSection", () => {
    it("renders nothing when the run started with no prior threads", () => {
        const result = renderRereviewSection({
            threads: [],
            reconciler: {resolve: [], keep: []},
        });
        expect(result.section).toBe("");
        expect(result.keptCount).toBe(0);
        expect(result.resolvedCount).toBe(0);
    });

    it("states the all-resolved case an approval rides on", () => {
        const result = renderRereviewSection({
            threads: [thread({thread_id: "a"}), thread({thread_id: "b"})],
            reconciler: {resolve: ["a", "b"], keep: []},
        });
        expect(result.section).toBe("All 2 prior review threads are resolved.");
    });

    it("uses singular wording for one resolved thread", () => {
        const result = renderRereviewSection({
            threads: [thread({thread_id: "a"})],
            reconciler: {resolve: ["a"], keep: []},
        });
        expect(result.section).toBe("The 1 prior review thread is resolved.");
    });

    it("enumerates kept threads as links, blocking first", () => {
        const threads = [
            thread({
                thread_id: "nb",
                path: "a/a.go",
                line: 1,
                url: "https://github.com/o/r/pull/1#discussion_r1",
                comments: [
                    {
                        author: "github-actions",
                        body: "**suggestion (non-blocking):** Nicer name.",
                    },
                ],
            }),
            thread({
                thread_id: "blk",
                path: "z/z.go",
                line: 9,
                url: "https://github.com/o/r/pull/1#discussion_r2",
            }),
        ];
        const result = renderRereviewSection({
            threads,
            reconciler: {resolve: ["other"], keep: ["nb", "blk"]},
            headSha: "abcdef1234567890",
        });
        const lines = result.section.split("\n");
        expect(lines[0]).toBe(
            "1 of 3 prior review threads resolved; 2 still unaddressed as of abcdef1:",
        );
        // Blocking thread sorts first even though it was listed second.
        expect(lines[1]).toBe(
            "- **issue (blocking)** [`z/z.go:9`](https://github.com/o/r/pull/1#discussion_r2): The guard was removed.",
        );
        expect(lines[2]).toBe(
            "- **suggestion (non-blocking)** [`a/a.go:1`](https://github.com/o/r/pull/1#discussion_r1): Nicer name.",
        );
        expect(result.keptCount).toBe(2);
        expect(result.resolvedCount).toBe(1);
    });

    it("renders the zero-resolved header without a resolved clause", () => {
        const result = renderRereviewSection({
            threads: [thread({thread_id: "a"})],
            reconciler: {resolve: [], keep: ["a"]},
        });
        expect(result.section.split("\n")[0]).toBe(
            "1 of 1 prior review thread is still unaddressed:",
        );
    });

    it("falls back to a plain token when the thread has no url", () => {
        const result = renderRereviewSection({
            threads: [thread({thread_id: "a", url: undefined})],
            reconciler: {resolve: [], keep: ["a"]},
        });
        expect(result.section).toContain(
            "- **issue (blocking)** `services/foo/foo.go:12`:",
        );
        expect(result.section).not.toContain("](");
    });

    it("anchors a null-line thread on the bare path", () => {
        const result = renderRereviewSection({
            threads: [thread({thread_id: "a", line: null, url: undefined})],
            reconciler: {resolve: [], keep: ["a"]},
        });
        expect(result.section).toContain("`services/foo/foo.go`:");
    });

    it("still accounts for a keep id missing from the staging", () => {
        const result = renderRereviewSection({
            threads: [],
            reconciler: {resolve: [], keep: ["ghost"]},
        });
        expect(result.section).toContain("thread ghost");
        expect(result.keptCount).toBe(1);
    });
});

describe("renderReviewBody with a re-review section", () => {
    it("splices the section between the head and the notes", () => {
        const body = renderReviewBody({
            event: "REQUEST_CHANGES",
            hasInlineComments: false,
            rereviewSection:
                "1 of 1 prior review thread is still unaddressed:\n- **issue (blocking)** `a.go:1`: x",
            skippedDimensions: [
                {dimension: "patterns", subAgent: "pattern-triage"},
            ],
        });
        expect(body.split("\n")).toEqual([
            "Changes requested — see inline comments.",
            "1 of 1 prior review thread is still unaddressed:",
            "- **issue (blocking)** `a.go:1`: x",
            "Note: patterns not assessed this run (pattern-triage output unavailable).",
        ]);
    });

    it("leaves the body untouched when the section is empty or absent", () => {
        const withEmpty = renderReviewBody({
            event: "APPROVE",
            hasInlineComments: false,
            rereviewSection: "",
        });
        const without = renderReviewBody({
            event: "APPROVE",
            hasInlineComments: false,
        });
        expect(withEmpty).toBe("Approved — no blocking issues found.");
        expect(withEmpty).toBe(without);
    });

    it("makes an otherwise-empty body carry the accounting", () => {
        // Run 3 of the lifecycle approved with an empty body while resolving
        // 11 threads; with the section, that approval says so.
        const body = renderReviewBody({
            event: "APPROVE",
            hasInlineComments: true,
            rereviewSection: "All 11 prior review threads are resolved.",
        });
        expect(body).toBe("All 11 prior review threads are resolved.");
    });
});

describe("runRereviewCli", () => {
    const makeFs = (files: Record<string, string>) => {
        const written: Record<string, string> = {};
        const fs: RereviewCliFs = {
            existsSync: (p) => p in files,
            readFileSync: (p) => files[p],
            writeFileSync: (p, data) => {
                written[p] = data;
            },
            mkdirSync: () => {},
        };
        return {fs, written};
    };

    const THREADS = "/tmp/gh-aw/review/threads.json";
    const RECONCILER = "/tmp/gh-aw/review/out/thread-reconciler.json";
    const PR_CONTEXT = "/tmp/gh-aw/review/pr-context.json";
    const RESULT = "/tmp/gh-aw/review/rereview.json";

    it("renders and writes the section from the staged inputs", () => {
        const {fs, written} = makeFs({
            [THREADS]: JSON.stringify([
                {
                    thread_id: "a",
                    path: "x.go",
                    line: 3,
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                    comments: [
                        {
                            author: "github-actions",
                            body: "**todo (blocking):** Missing field.",
                        },
                    ],
                },
            ]),
            [RECONCILER]: JSON.stringify({
                resolve: [],
                keep: ["a"],
                skipLines: [],
            }),
            [PR_CONTEXT]: JSON.stringify({headSha: "1234567890abcdef"}),
        });
        const result = runRereviewCli(fs);
        expect(result.keptCount).toBe(1);
        expect(result.section).toContain("still unaddressed as of 1234567");
        expect(result.section).toContain(
            "- **todo (blocking)** [`x.go:3`](https://github.com/o/r/pull/1#discussion_r1): Missing field.",
        );
        expect(JSON.parse(written[RESULT])).toEqual(result);
    });

    it("fails open to an empty section when the reconciler output is missing", () => {
        const {fs, written} = makeFs({
            [THREADS]: JSON.stringify([]),
        });
        const result = runRereviewCli(fs);
        expect(result).toEqual({section: "", keptCount: 0, resolvedCount: 0});
        expect(JSON.parse(written[RESULT])).toEqual(result);
    });

    it("fails open when the reconciler output is unparseable", () => {
        const {fs} = makeFs({
            [RECONCILER]: "not json",
        });
        expect(runRereviewCli(fs).section).toBe("");
    });

    it("tolerates threads.json entries with unexpected shapes", () => {
        const {fs} = makeFs({
            [THREADS]: JSON.stringify([
                {thread_id: "a"},
                {no_id: true},
                "junk",
            ]),
            [RECONCILER]: JSON.stringify({resolve: [], keep: ["a"]}),
        });
        const result = runRereviewCli(fs);
        expect(result.keptCount).toBe(1);
        expect(result.section).toContain("still unaddressed");
    });
});
