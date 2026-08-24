import {describe, it, expect} from "vitest";

import {renderReviewBody} from "./render-comment";
import {
    excerptOpeningComment,
    parseLeadingLabel,
    renderRereviewSection,
    runRereviewCli,
    verifiedAcknowledgedIds,
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

    it("parses the markdown-stripped plain form the staging produces (webapp #40561)", () => {
        // Every staged opener on Khan/webapp#40561 arrived with the `**`
        // wrapping stripped; the recap then rendered `**unknown**` on every
        // line. The plain form must parse to the same label the bold form
        // would have.
        expect(
            parseLeadingLabel(
                "thought (non-blocking): The trim loop now counts len(...).",
            ),
        ).toBe("thought (non-blocking)");
        expect(
            parseLeadingLabel("issue (blocking): A gated spec goes silent."),
        ).toBe("issue (blocking)");
        expect(
            parseLeadingLabel(
                "suggestion (non-blocking, best-practice): Error handling.",
            ),
        ).toBe("suggestion (non-blocking, best-practice)");
    });

    it("keeps the plain form bound to the label vocabulary", () => {
        // Prose that merely starts with `word:` must not parse as a label.
        expect(parseLeadingLabel("Note: this only affects tests.")).toBeNull();
        expect(parseLeadingLabel("warning (non-blocking): x")).toBeNull();
        expect(parseLeadingLabel("note: no decoration either.")).toBeNull();
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

    it("strips the markdown-stripped plain label form too", () => {
        expect(
            excerptOpeningComment(
                "thought (non-blocking): The trim loop now counts.",
            ),
        ).toBe("The trim loop now counts.");
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

    it("lists blocking threads visibly and collapses non-blocking ones", () => {
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
        // The blocking thread is the only visible entry line.
        expect(lines[1]).toBe(
            "- **issue (blocking)** [`z/z.go:9`](https://github.com/o/r/pull/1#discussion_r2): The guard was removed.",
        );
        // The non-blocking thread renders inside the collapsed block.
        expect(lines[2]).toBe("");
        expect(lines[3]).toBe("<details>");
        expect(lines[4]).toBe(
            "<summary>1 non-blocking thread still open</summary>",
        );
        expect(result.section).toContain(
            "- **suggestion (non-blocking)** [`a/a.go:1`](https://github.com/o/r/pull/1#discussion_r1): Nicer name.",
        );
        expect(result.section.indexOf("<details>")).toBeLessThan(
            result.section.indexOf("suggestion (non-blocking)"),
        );
        expect(result.section.trimEnd().endsWith("</details>")).toBe(true);
        expect(result.keptCount).toBe(2);
        expect(result.resolvedCount).toBe(1);
    });

    it("damps a non-blocking thread a prior recap already quoted to label + link", () => {
        // First mention full, thereafter compact: re-quoting every open nit's
        // excerpt on every push is the recap-wall drumbeat (webapp#41290: the
        // same four threads re-quoted across 25 runs). The opener URL in a
        // prior review body is the marker the first recap plants.
        const nb = (id: string, url: string): StagedThread =>
            thread({
                thread_id: id,
                path: "a/a.go",
                line: id === "old" ? 1 : 2,
                url,
                comments: [
                    {
                        author: "github-actions",
                        body: `**note (non-blocking):** Concern ${id}.`,
                    },
                ],
            });
        const result = renderRereviewSection({
            threads: [
                nb("old", "https://github.com/o/r/pull/1#discussion_r1"),
                nb("new", "https://github.com/o/r/pull/1#discussion_r2"),
            ],
            reconciler: {resolve: [], keep: ["old", "new"]},
            priorReviewBodies: [
                "2 still unaddressed:\n- **note (non-blocking)** " +
                    "[`a/a.go:1`](https://github.com/o/r/pull/1#discussion_r1): Concern old.",
            ],
        });
        expect(result.section).toContain(
            "<summary>2 non-blocking threads still open (1 previously reported)</summary>",
        );
        // The fresh thread keeps its excerpt and leads the block; the repeat
        // renders label + link only.
        const freshIndex = result.section.indexOf(
            "- **note (non-blocking)** [`a/a.go:2`](https://github.com/o/r/pull/1#discussion_r2): Concern new.",
        );
        const repeatIndex = result.section.indexOf(
            "- **note (non-blocking)** [`a/a.go:1`](https://github.com/o/r/pull/1#discussion_r1)\n",
        );
        expect(freshIndex).toBeGreaterThan(-1);
        expect(repeatIndex).toBeGreaterThan(freshIndex);
        expect(result.section).not.toContain("r1): Concern old.");
    });

    it("never damps a blocking thread, and a thread with no URL renders full", () => {
        // Blocking lines are the reason the verdict is what it is; they must
        // stand on their own however many times they have been recapped. And
        // a staged thread without a URL cannot be matched against prior
        // bodies, so it fails toward the full render.
        const noUrl = thread({
            thread_id: "nb",
            url: undefined,
            comments: [
                {
                    author: "github-actions",
                    body: "**note (non-blocking):** No url.",
                },
            ],
        });
        const blocking = thread({
            thread_id: "blk",
            url: "https://github.com/o/r/pull/1#discussion_r2",
        });
        const result = renderRereviewSection({
            threads: [noUrl, blocking],
            reconciler: {resolve: [], keep: ["nb", "blk"]},
            priorReviewBodies: [
                "- [`a/b.go:7`](https://github.com/o/r/pull/1#discussion_r2): The guard was removed.",
            ],
        });
        expect(result.section).toContain(
            "](https://github.com/o/r/pull/1#discussion_r2): The guard was removed.",
        );
        expect(result.section).toContain(": No url.");
        expect(result.section).not.toContain("previously reported");
    });

    it("renders no collapsed block when every kept thread blocks", () => {
        const result = renderRereviewSection({
            threads: [thread({thread_id: "a"})],
            reconciler: {resolve: [], keep: ["a"]},
        });
        expect(result.section).not.toContain("<details>");
        expect(result.section).toContain("- **issue (blocking)**");
    });

    it("pluralizes the collapsed-block summary", () => {
        const nb = (id: string): StagedThread =>
            thread({
                thread_id: id,
                comments: [
                    {
                        author: "github-actions",
                        body: "**note (non-blocking):** x.",
                    },
                ],
            });
        const result = renderRereviewSection({
            threads: [nb("a"), nb("b")],
            reconciler: {resolve: [], keep: ["a", "b"]},
        });
        expect(result.section).toContain(
            "<summary>2 non-blocking threads still open</summary>",
        );
        // No visible entry lines between the header and the block.
        expect(result.section.split("\n")[1]).toBe("");
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

    it("labels a markdown-stripped staged opener correctly (webapp #40561)", () => {
        // The pathology: every staged body lost its `**` wrapping and every
        // recap line rendered `**unknown**`. The blocking/non-blocking split
        // (and the flip gate's keptBlockingCount) must survive that form.
        const result = renderRereviewSection({
            threads: [
                thread({
                    thread_id: "plain-blk",
                    comments: [
                        {
                            author: "github-actions",
                            body: "issue (blocking): A gated spec goes silent.",
                        },
                    ],
                }),
                thread({
                    thread_id: "plain-nb",
                    comments: [
                        {
                            author: "github-actions",
                            body: "thought (non-blocking): The trim loop now counts.",
                        },
                    ],
                }),
            ],
            reconciler: {resolve: [], keep: ["plain-blk", "plain-nb"]},
        });
        expect(result.section).not.toContain("unknown");
        expect(result.section).toContain(
            "- **issue (blocking)** [`services/foo/foo.go:12`](https://github.com/o/r/pull/1#discussion_r100): A gated spec goes silent.",
        );
        expect(result.section).toContain(
            "- **thought (non-blocking)** [`services/foo/foo.go:12`](https://github.com/o/r/pull/1#discussion_r100): The trim loop now counts.",
        );
        expect(result.keptBlockingCount).toBe(1);
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
    const PRIOR_REVIEWS = "/tmp/gh-aw/review/prior-reviews.json";
    const RESULT = "/tmp/gh-aw/review/rereview.json";

    it("feeds staged prior-review bodies into the recap damping", () => {
        const url = "https://github.com/o/r/pull/1#discussion_r1";
        const {fs} = makeFs({
            [THREADS]: JSON.stringify([
                {
                    thread_id: "a",
                    path: "x.go",
                    line: 3,
                    url,
                    comments: [
                        {
                            author: "github-actions",
                            body: "**note (non-blocking):** Old concern.",
                        },
                    ],
                },
            ]),
            [RECONCILER]: JSON.stringify({
                resolve: [],
                keep: ["a"],
                skipLines: [],
            }),
            [PRIOR_REVIEWS]: JSON.stringify([
                {
                    state: "APPROVED",
                    body: `- [\`x.go:3\`](${url}): Old concern.`,
                },
            ]),
        });
        const result = runRereviewCli(fs);
        expect(result.section).toContain("(1 previously reported)");
        expect(result.section).not.toContain(": Old concern.");
        // Malformed staging reads as no prior reviews: full render.
        const {fs: fsBad} = makeFs({
            [THREADS]: JSON.stringify([
                {
                    thread_id: "a",
                    path: "x.go",
                    line: 3,
                    url,
                    comments: [
                        {
                            author: "github-actions",
                            body: "**note (non-blocking):** Old concern.",
                        },
                    ],
                },
            ]),
            [RECONCILER]: JSON.stringify({
                resolve: [],
                keep: ["a"],
                skipLines: [],
            }),
            [PRIOR_REVIEWS]: "not json[",
        });
        expect(runRereviewCli(fsBad).section).toContain(": Old concern.");
        // A prior body that merely MENTIONS the URL in prose (no rendered
        // `](url)` link) is not a recap: the thread renders full. Bare
        // substring matching would also let a prefix id (r1 vs r12) damp a
        // never-recapped thread.
        const {fs: fsProse} = makeFs({
            [THREADS]: JSON.stringify([
                {
                    thread_id: "a",
                    path: "x.go",
                    line: 3,
                    url,
                    comments: [
                        {
                            author: "github-actions",
                            body: "**note (non-blocking):** Old concern.",
                        },
                    ],
                },
            ]),
            [RECONCILER]: JSON.stringify({
                resolve: [],
                keep: ["a"],
                skipLines: [],
            }),
            [PRIOR_REVIEWS]: JSON.stringify([
                {state: "APPROVED", body: `see ${url} for the discussion`},
                {
                    state: "APPROVED",
                    body: `linked: [\`x.go:9\`](${url}9): other`,
                },
            ]),
        });
        const prose = runRereviewCli(fsProse);
        expect(prose.section).toContain(": Old concern.");
        expect(prose.section).not.toContain("previously reported");
    });

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
        expect(result).toEqual({
            section: "",
            keptCount: 0,
            resolvedCount: 0,
            acknowledged: [],
            acknowledgedCount: 0,
            keptBlockingCount: 0,
        });
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

describe("keptBlockingCount (the mode dial's flip-gate input)", () => {
    const thread = (id: string, label: string, line: number): StagedThread => ({
        thread_id: id,
        path: "src/handler.ts",
        line,
        comments: [{author: "github-actions[bot]", body: `**${label}:** x`}],
    });

    it("counts only kept threads whose opening label blocks", () => {
        const result = renderRereviewSection({
            threads: [
                thread("t1", "issue (blocking)", 10),
                thread("t2", "suggestion (non-blocking)", 20),
                thread("t3", "todo (blocking)", 30),
            ],
            reconciler: {resolve: ["t2"], keep: ["t1", "t3"]},
        });
        expect(result.keptCount).toBe(2);
        expect(result.keptBlockingCount).toBe(2);
    });

    it("is zero when every kept thread is non-blocking (flip may proceed)", () => {
        const result = renderRereviewSection({
            threads: [thread("t1", "nitpick (non-blocking)", 5)],
            reconciler: {resolve: [], keep: ["t1"]},
        });
        expect(result.keptBlockingCount).toBe(0);
    });

    it("is zero when everything is resolved", () => {
        const result = renderRereviewSection({
            threads: [thread("t1", "issue (blocking)", 5)],
            reconciler: {resolve: ["t1"], keep: []},
        });
        expect(result.keptBlockingCount).toBe(0);
    });

    it("fails closed on an unparseable opener: visible and counted", () => {
        // A staging-corruption mode neither label regex covers must degrade
        // to noise (a visible unknown entry that blocks the flip), never to
        // a hidden thread plus a permitted APPROVE.
        const result = renderRereviewSection({
            threads: [
                {
                    thread_id: "t1",
                    path: "src/handler.ts",
                    line: 10,
                    comments: [
                        {
                            author: "github-actions[bot]",
                            body: "ISSUE (BLOCKING) - A gated spec goes silent.",
                        },
                    ],
                },
            ],
            reconciler: {resolve: [], keep: ["t1"]},
        });
        expect(result.keptBlockingCount).toBe(1);
        expect(result.section).toContain("- **unknown**");
        expect(result.section).not.toContain("<details>");
    });

    it("fails closed on a keep id missing from the staging", () => {
        const result = renderRereviewSection({
            threads: [],
            reconciler: {resolve: [], keep: ["ghost"]},
        });
        expect(result.keptBlockingCount).toBe(1);
    });
});

describe("acknowledged threads (the will-fix signal, webapp#41290)", () => {
    // The motivating pathology: the author replied will-fix/TODO on a bot
    // thread without resolving it, and every later recap counted the thread
    // "unaddressed" while the pipeline re-derived the defect afresh. The
    // reconciler now reports conceded-but-unfixed keeps as `acknowledged`;
    // code verifies each id against the staged reply chain (the reconciler
    // asserts, code verifies, like thread resolutions) and the recap counts
    // them addressed-pending.
    const ackThread = (
        id: string,
        replies: {author: string; body: string}[],
        opener = "**note (non-blocking):** Side effects escape the gate.",
    ): StagedThread =>
        thread({
            thread_id: id,
            path: "a/a.go",
            line: 5,
            url: `https://github.com/o/r/pull/1#discussion_${id}`,
            comments: [{author: "github-actions", body: opener}, ...replies],
        });

    describe("verifiedAcknowledgedIds", () => {
        const author = "octocat";

        it("verifies an ack backed by the PR author's reply on a kept thread", () => {
            const ids = verifiedAcknowledgedIds(
                {
                    resolve: [],
                    keep: ["t1"],
                    acknowledged: ["t1"],
                },
                [ackThread("t1", [{author, body: "yes, will fix (TODO)"}])],
                author,
            );
            expect([...ids]).toEqual(["t1"]);
        });

        it("matches the author across the REST/GraphQL bot-suffix split rules", () => {
            // sameLogin is case-folded; a human login never carries the
            // suffix, so this is just the case fold.
            const ids = verifiedAcknowledgedIds(
                {resolve: [], keep: ["t1"], acknowledged: ["t1"]},
                [ackThread("t1", [{author: "OctoCat", body: "ok"}])],
                author,
            );
            expect(ids.has("t1")).toBe(true);
        });

        it("never counts bot replies (thumbs follow-ups, autofix)", () => {
            // Autofix's replies (and retired sweep follow-ups on older
            // threads) sit on exactly these threads; a reconciler
            // hallucinating a concession out of one must contribute nothing.
            // t1 is the spelling staged threads actually carry (GraphQL's
            // bare login, caught by isReviewBotAuthor); t2's `[bot]` suffix
            // is the REST spelling, unreachable from today's staging and
            // kept only to pin the isBotLogin belt-and-suspenders clause.
            const ids = verifiedAcknowledgedIds(
                {resolve: [], keep: ["t1", "t2"], acknowledged: ["t1", "t2"]},
                [
                    ackThread("t1", [
                        {
                            author: "github-actions",
                            body: "Thanks for the downvote",
                        },
                    ]),
                    ackThread("t2", [
                        {author: "khan-autofix[bot]", body: "pushed a fix"},
                    ]),
                ],
                author,
            );
            expect(ids.size).toBe(0);
        });

        it("ignores replies from humans other than the PR author", () => {
            const ids = verifiedAcknowledgedIds(
                {resolve: [], keep: ["t1"], acknowledged: ["t1"]},
                [ackThread("t1", [{author: "someone-else", body: "agreed"}])],
                author,
            );
            expect(ids.size).toBe(0);
        });

        it("requires keep membership: resolved or unknown ids are dropped", () => {
            const ids = verifiedAcknowledgedIds(
                {
                    resolve: ["t1"],
                    keep: [],
                    acknowledged: ["t1", "ghost"],
                },
                [ackThread("t1", [{author, body: "will fix"}])],
                author,
            );
            expect(ids.size).toBe(0);
        });

        it("verifies nothing without a usable PR author (absent, empty, or a bot)", () => {
            const reconciler = {
                resolve: [],
                keep: ["t1"],
                acknowledged: ["t1"],
            };
            const threads = [ackThread("t1", [{author, body: "will fix"}])];
            expect(
                verifiedAcknowledgedIds(reconciler, threads, undefined).size,
            ).toBe(0);
            expect(verifiedAcknowledgedIds(reconciler, threads, "").size).toBe(
                0,
            );
            expect(
                verifiedAcknowledgedIds(reconciler, threads, "github-actions")
                    .size,
            ).toBe(0);
            expect(
                verifiedAcknowledgedIds(
                    reconciler,
                    threads,
                    "khan-autofix[bot]",
                ).size,
            ).toBe(0);
        });

        it("requires a reply: the opener alone verifies nothing", () => {
            const ids = verifiedAcknowledgedIds(
                {resolve: [], keep: ["t1"], acknowledged: ["t1"]},
                [ackThread("t1", [])],
                author,
            );
            expect(ids.size).toBe(0);
        });
    });

    describe("renderRereviewSection with acknowledgments", () => {
        const author = "octocat";

        it("counts verified acks as addressed-pending in the header and marks their lines", () => {
            const result = renderRereviewSection({
                threads: [
                    ackThread("ack", [{author, body: "yes, TODO filed"}]),
                    ackThread("plain", []),
                ],
                reconciler: {
                    resolve: ["done"],
                    keep: ["ack", "plain"],
                    acknowledged: ["ack"],
                },
                headSha: "abcdef1234567890",
                prAuthor: author,
            });
            expect(result.section.split("\n")[0]).toBe(
                "1 of 3 prior review threads resolved; 2 still open, " +
                    "1 of them acknowledged (fix pending) as of abcdef1:",
            );
            expect(result.section).toContain(
                "[`a/a.go:5`](https://github.com/o/r/pull/1#discussion_ack)" +
                    " (acknowledged, fix pending): Side effects escape the gate.",
            );
            // The unacknowledged kept thread beside it renders WITHOUT the
            // marker: the per-entry semantics, not just the header count.
            expect(result.section).toContain(
                "- **note (non-blocking)** " +
                    "[`a/a.go:5`](https://github.com/o/r/pull/1#discussion_plain): " +
                    "Side effects escape the gate.",
            );
            expect(result.acknowledged).toEqual(["ack"]);
            expect(result.acknowledgedCount).toBe(1);
        });

        it("keeps the exact pre-acknowledgment wording when nothing verifies", () => {
            const result = renderRereviewSection({
                threads: [ackThread("t1", [{author, body: "will fix"}])],
                reconciler: {
                    resolve: [],
                    keep: ["t1"],
                    acknowledged: ["t1"],
                },
                // No prAuthor staged: verification fails closed, and the
                // section is byte-identical to the pre-acknowledgment render.
            });
            expect(result.section).toContain("still unaddressed");
            expect(result.section).not.toContain("acknowledged");
            expect(result.acknowledged).toEqual([]);
            expect(result.acknowledgedCount).toBe(0);
        });

        it("never lets an acknowledged blocking thread fold or release the flip gate", () => {
            const result = renderRereviewSection({
                threads: [
                    ackThread(
                        "blk",
                        [{author, body: "true, fixing"}],
                        "**issue (blocking):** The guard was removed.",
                    ),
                ],
                reconciler: {
                    resolve: [],
                    keep: ["blk"],
                    acknowledged: ["blk"],
                },
                prAuthor: author,
            });
            // Visible line (no <details>), marked, and still counted: the
            // code change is what resolves a blocking thread, never the
            // promise of one. The header assertion pins the acknowledged
            // wording on the resolvedCount === 0 branch (the mixed test
            // covers the resolved-count form).
            expect(result.section.split("\n")[0]).toBe(
                "1 of 1 prior review thread is still open, " +
                    "1 of them acknowledged (fix pending):",
            );
            expect(result.keptBlockingCount).toBe(1);
            expect(result.section).not.toContain("<details>");
            expect(result.section).toContain(
                "- **issue (blocking)** " +
                    "[`a/a.go:5`](https://github.com/o/r/pull/1#discussion_blk)" +
                    " (acknowledged, fix pending): The guard was removed.",
            );
        });

        it("keeps the marker on a damped (previously recapped) line", () => {
            const url = "https://github.com/o/r/pull/1#discussion_ack";
            const result = renderRereviewSection({
                threads: [ackThread("ack", [{author, body: "yep"}])],
                reconciler: {
                    resolve: [],
                    keep: ["ack"],
                    acknowledged: ["ack"],
                },
                priorReviewBodies: [`- [\`a/a.go:5\`](${url}): quoted before`],
                prAuthor: author,
            });
            expect(result.section).toContain(
                `- **note (non-blocking)** [\`a/a.go:5\`](${url})` +
                    " (acknowledged, fix pending)\n",
            );
            expect(result.section).not.toContain(
                ": Side effects escape the gate.",
            );
        });
    });

    describe("runRereviewCli with acknowledgments", () => {
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

        it("reads the staged PR author and records verified acks in rereview.json", () => {
            const {fs, written} = makeFs({
                [THREADS]: JSON.stringify([
                    ackThread("t1", [{author: "octocat", body: "will fix"}]),
                ]),
                [RECONCILER]: JSON.stringify({
                    resolve: [],
                    keep: ["t1"],
                    acknowledged: ["t1"],
                    skipLines: [],
                }),
                [PR_CONTEXT]: JSON.stringify({
                    author: "octocat",
                    headSha: "abc",
                }),
            });
            const result = runRereviewCli(fs);
            expect(result.acknowledged).toEqual(["t1"]);
            expect(result.acknowledgedCount).toBe(1);
            expect(JSON.parse(written[RESULT]).acknowledged).toEqual(["t1"]);
        });

        it("filters non-string acknowledged entries, keeping real acks", () => {
            // One junk entry must not erase a real acknowledgment: the
            // field is an optional refinement over keep, and every
            // surviving id still passes verification.
            const {fs} = makeFs({
                [THREADS]: JSON.stringify([
                    ackThread("t1", [{author: "octocat", body: "will fix"}]),
                ]),
                [RECONCILER]: JSON.stringify({
                    resolve: [],
                    keep: ["t1"],
                    acknowledged: [42, "t1"],
                    skipLines: [],
                }),
                [PR_CONTEXT]: JSON.stringify({author: "octocat"}),
            });
            const result = runRereviewCli(fs);
            expect(result.acknowledged).toEqual(["t1"]);
            expect(result.acknowledgedCount).toBe(1);
        });

        it("degrades a non-array acknowledged to none, keeping the section", () => {
            const {fs} = makeFs({
                [THREADS]: JSON.stringify([
                    ackThread("t1", [{author: "octocat", body: "will fix"}]),
                ]),
                [RECONCILER]: JSON.stringify({
                    resolve: [],
                    keep: ["t1"],
                    acknowledged: "t1",
                    skipLines: [],
                }),
                [PR_CONTEXT]: JSON.stringify({author: "octocat"}),
            });
            const result = runRereviewCli(fs);
            expect(result.acknowledgedCount).toBe(0);
            expect(result.keptCount).toBe(1);
            expect(result.section).toContain("still unaddressed");
        });
    });
});
