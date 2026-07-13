import {describe, it, expect} from "vitest";
import {Volume} from "memfs";

import {
    CorpusCaseError,
    LIVE_TAG,
    loadCorpus,
    loadLiveCorpus,
    parseCase,
    validateLiveTree,
    type LoaderFs,
} from "./loader";

/**
 * Loader unit tests for the live-enabled case format (`live-ab-plan.md`
 * Phase 1): the `live` block, the `<id>/case.json` + `<id>/tree/` layout, and
 * the on-disk tree validation. The recorded-case format is exercised by the
 * suite tests; here the recorded fields stay minimal.
 */

/** Adapt a memfs volume to the loader's injected-fs seam. */
const volFs = (files: Record<string, string>): LoaderFs => {
    const vol = Volume.fromJSON(files);
    return {
        existsSync: (p) => vol.existsSync(p),
        readdirSync: (p, opts) =>
            vol.readdirSync(p, opts) as unknown as ReturnType<
                LoaderFs["readdirSync"]
            >,
        readFileSync: (p, enc) => vol.readFileSync(p, enc) as string,
    };
};

/** A minimal clean-and-parseable git diff touching `src/a.ts`. */
const DIFF_A = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

/** A minimal valid recorded case (no live block). */
const recordedCase = (over: Record<string, unknown> = {}) => ({
    id: "case-1",
    tags: ["smoke"],
    category: "clean",
    description: "a minimal case",
    changedFiles: [{path: "src/a.ts", status: "modified"}],
    expected: {verdict: "APPROVE"},
    ...over,
});

/** A minimal valid live-enabled case. */
const liveCase = (over: Record<string, unknown> = {}) =>
    recordedCase({
        tags: ["smoke", LIVE_TAG],
        diff: DIFF_A,
        live: {
            prContext: {
                title: "A change",
                description: "",
                author: "octocat",
                baseBranch: "main",
            },
        },
        ...over,
    });

const parseErrors = (raw: unknown): string => {
    try {
        parseCase(raw, "test://case");
        return "";
    } catch (error) {
        if (error instanceof CorpusCaseError) {
            return error.message;
        }
        throw error;
    }
};

describe("parseCase: the live block", () => {
    it("parses a valid live case, defaulting tree to 'tree'", () => {
        const parsed = parseCase(liveCase(), "test://case");
        expect(parsed.live?.tree).toBe("tree");
        expect(parsed.live?.prContext.author).toBe("octocat");
        expect(parsed.tags).toContain(LIVE_TAG);
    });

    it("accepts an empty PR description (untrusted text may be empty)", () => {
        const parsed = parseCase(liveCase(), "test://case");
        expect(parsed.live?.prContext.description).toBe("");
    });

    it("parses defect specs with line windows and mechanisms", () => {
        const parsed = parseCase(
            liveCase({
                live: {
                    prContext: {
                        title: "t",
                        description: "d",
                        author: "a",
                        baseBranch: "main",
                    },
                    mustCatchSpecs: [
                        {
                            key: "bug-1",
                            path: "src/a.ts",
                            lineStart: 1,
                            lineEnd: 2,
                            mechanism: ["off.by.one", "constant changed"],
                            lens: "correctness",
                        },
                    ],
                    mustNotFlagSpecs: [
                        {
                            key: "trap-1",
                            path: "src/a.ts",
                            mechanism: ["wrapper chunks internally"],
                        },
                    ],
                },
            }),
            "test://case",
        );
        expect(parsed.live?.mustCatchSpecs?.[0]?.key).toBe("bug-1");
        expect(parsed.live?.mustCatchSpecs?.[0]?.lineEnd).toBe(2);
        expect(parsed.live?.mustNotFlagSpecs?.[0]?.lineStart).toBeUndefined();
    });

    it("parses and validates altLocations like the primary location", () => {
        const withAlt = (altLocations: unknown) =>
            liveCase({
                changedFiles: [
                    {path: "src/a.ts", status: "modified"},
                    {path: "src/only-listed.ts", status: "modified"},
                ],
                live: {
                    prContext: {
                        title: "t",
                        description: "d",
                        author: "a",
                        baseBranch: "main",
                    },
                    mustCatchSpecs: [
                        {
                            key: "k",
                            path: "src/a.ts",
                            mechanism: ["m"],
                            altLocations,
                        },
                    ],
                },
            });
        const parsed = parseCase(
            withAlt([{path: "src/a.ts", lineStart: 1, lineEnd: 2}]),
            "test://case",
        );
        expect(parsed.live?.mustCatchSpecs?.[0]?.altLocations).toEqual([
            {path: "src/a.ts", lineStart: 1, lineEnd: 2},
        ]);
        expect(parseErrors(withAlt([]))).toMatch(
            /altLocations: must be a non-empty array/,
        );
        expect(parseErrors(withAlt([{path: "src/nope.ts"}]))).toMatch(
            /altLocations\[0\]\.path: "src\/nope\.ts" is not in changedFiles/,
        );
        expect(parseErrors(withAlt([{path: "src/only-listed.ts"}]))).toMatch(
            /no section in the diff/,
        );
        expect(
            parseErrors(withAlt([{path: "src/a.ts", lineStart: 3}])),
        ).toMatch(/must be set together/);
        expect(
            parseErrors(
                withAlt([{path: "src/a.ts", lineStart: 5, lineEnd: 3}]),
            ),
        ).toMatch(/lineStart <= lineEnd/);
    });

    it("requires a diff on a live case", () => {
        const raw = liveCase();
        delete (raw as Record<string, unknown>)["diff"];
        expect(parseErrors(raw)).toMatch(/live: requires a non-empty/);
    });

    it("rejects a live case whose diff does not parse cleanly", () => {
        expect(parseErrors(liveCase({diff: "not a unified diff"}))).toMatch(
            /live: diff must parse cleanly/,
        );
    });

    it("ties the live tag and the live block together, both directions", () => {
        expect(parseErrors(liveCase({tags: ["smoke"]}))).toMatch(
            /must carry the "live" tag/,
        );
        expect(parseErrors(recordedCase({tags: ["smoke", LIVE_TAG]}))).toMatch(
            /"live" tag requires a live block/,
        );
    });

    it("rejects a spec path missing from changedFiles or from the diff", () => {
        const withSpec = (path: string) =>
            liveCase({
                changedFiles: [
                    {path: "src/a.ts", status: "modified"},
                    {path: "src/only-listed.ts", status: "modified"},
                ],
                live: {
                    prContext: {
                        title: "t",
                        description: "d",
                        author: "a",
                        baseBranch: "main",
                    },
                    mustCatchSpecs: [{key: "k", path, mechanism: ["m"]}],
                },
            });
        expect(parseErrors(withSpec("src/other.ts"))).toMatch(
            /not in changedFiles/,
        );
        expect(parseErrors(withSpec("src/only-listed.ts"))).toMatch(
            /no section in the diff/,
        );
    });

    it("rejects unpaired or inverted line windows", () => {
        const withWindow = (window: Record<string, unknown>) =>
            liveCase({
                live: {
                    prContext: {
                        title: "t",
                        description: "d",
                        author: "a",
                        baseBranch: "main",
                    },
                    mustCatchSpecs: [
                        {
                            key: "k",
                            path: "src/a.ts",
                            mechanism: ["m"],
                            ...window,
                        },
                    ],
                },
            });
        expect(parseErrors(withWindow({lineStart: 3}))).toMatch(
            /must be set together/,
        );
        expect(parseErrors(withWindow({lineStart: 5, lineEnd: 3}))).toMatch(
            /lineStart <= lineEnd/,
        );
    });

    it("rejects duplicate spec keys across both spec lists", () => {
        const raw = liveCase({
            live: {
                prContext: {
                    title: "t",
                    description: "d",
                    author: "a",
                    baseBranch: "main",
                },
                mustCatchSpecs: [
                    {key: "dup", path: "src/a.ts", mechanism: ["m"]},
                ],
                mustNotFlagSpecs: [
                    {key: "dup", path: "src/a.ts", mechanism: ["m"]},
                ],
            },
        });
        expect(parseErrors(raw)).toMatch(/duplicate spec key "dup"/);
    });

    it("rejects an escaping or absolute tree path", () => {
        const withTree = (tree: string) =>
            liveCase({
                live: {
                    prContext: {
                        title: "t",
                        description: "d",
                        author: "a",
                        baseBranch: "main",
                    },
                    tree,
                },
            });
        expect(parseErrors(withTree("../outside"))).toMatch(/no \.\. segments/);
        expect(parseErrors(withTree("/abs"))).toMatch(/no \.\. segments/);
    });

    it("rejects a live block with a missing prContext field", () => {
        const raw = liveCase({
            live: {
                prContext: {title: "t", description: "d", author: "a"},
            },
        });
        expect(parseErrors(raw)).toMatch(/prContext\.baseBranch/);
    });
});

describe("case-directory layout and tree validation", () => {
    const corpus = (extra: Record<string, string> = {}) => ({
        "/corpus/smoke/flat-case.json": JSON.stringify(
            recordedCase({id: "flat-case"}),
        ),
        "/corpus/smoke/live-case/case.json": JSON.stringify(
            liveCase({id: "live-case"}),
        ),
        "/corpus/smoke/live-case/tree/src/a.ts": "const a = 2;\nexport {a};\n",
        ...extra,
    });

    it("loads both layouts and never parses tree files as cases", () => {
        const cases = loadCorpus(
            "/corpus",
            volFs(
                corpus({
                    // A JSON file inside the tree must NOT be parsed as a case.
                    "/corpus/smoke/live-case/tree/package.json": "{}",
                }),
            ),
        );
        expect(cases.map((c) => c.id).sort()).toEqual([
            "flat-case",
            "live-case",
        ]);
    });

    it("loadLiveCorpus returns exactly the live-tagged cases", () => {
        const live = loadLiveCorpus("/corpus", volFs(corpus()));
        expect(live.map((c) => c.id)).toEqual(["live-case"]);
        expect(live[0]?.live).toBeDefined();
    });

    it("hydrates a live case's fileLineCounts from its tree", () => {
        const cases = loadCorpus("/corpus", volFs(corpus()));
        const live = cases.find((c) => c.id === "live-case");
        // The fixture tree file has two lines (trailing newline does not
        // start a third); the flat case has no tree and no explicit counts.
        expect(live?.fileLineCounts).toEqual({"src/a.ts": 2});
        const flat = cases.find((c) => c.id === "flat-case");
        expect(flat?.fileLineCounts).toBeUndefined();
    });

    it("lets an explicit fileLineCounts field win over tree hydration", () => {
        const files = corpus({
            "/corpus/smoke/live-case/case.json": JSON.stringify({
                ...liveCase({id: "live-case"}),
                fileLineCounts: {"src/a.ts": 99},
            }),
        });
        const cases = loadCorpus("/corpus", volFs(files));
        const live = cases.find((c) => c.id === "live-case");
        expect(live?.fileLineCounts).toEqual({"src/a.ts": 99});
    });

    it("rejects a non-integer fileLineCounts entry", () => {
        const raw = {
            ...recordedCase({id: "bad-counts"}),
            fileLineCounts: {"src/a.ts": 1.5},
        };
        expect(() => parseCase(raw, "bad-counts.json")).toThrow(
            /fileLineCounts/,
        );
    });

    it("rejects a live case whose tree directory is missing", () => {
        const files = corpus();
        delete files["/corpus/smoke/live-case/tree/src/a.ts"];
        expect(() => loadCorpus("/corpus", volFs(files))).toThrow(/live\.tree/);
    });

    it("rejects a live case whose tree is missing a changed file", () => {
        const files = corpus({
            "/corpus/smoke/live-case/case.json": JSON.stringify(
                liveCase({
                    id: "live-case",
                    changedFiles: [
                        {path: "src/a.ts", status: "modified"},
                        {path: "src/b.ts", status: "modified"},
                    ],
                }),
            ),
        });
        expect(() => loadCorpus("/corpus", volFs(files))).toThrow(
            /missing changed file "src\/b\.ts"/,
        );
    });

    it("does not require removed files to exist in the tree", () => {
        const files = corpus({
            "/corpus/smoke/live-case/case.json": JSON.stringify(
                liveCase({
                    id: "live-case",
                    changedFiles: [
                        {path: "src/a.ts", status: "modified"},
                        {path: "src/gone.ts", status: "removed"},
                    ],
                }),
            ),
        });
        expect(() => loadCorpus("/corpus", volFs(files))).not.toThrow();
    });

    it("validateLiveTree is a no-op for recorded cases", () => {
        const parsed = parseCase(recordedCase(), "test://case");
        expect(() => validateLiveTree(parsed, volFs({}))).not.toThrow();
    });
});
