import {describe, it, expect} from "vitest";

import {splitUnifiedDiff} from "./diff";
import {computeDiffProvenance} from "./provenance";
import {
    computeHunkSignature,
    renderRereviewStamp,
    STAMP_SCHEMA_VERSION,
} from "./rereview-mode";
import {runCli as runRouterCli} from "./router";
import {
    buildUnifiedDiff,
    computeDiffFingerprint,
    computeNewScope,
    hashHunkAddedLines,
    runStagePrCli,
    type GhGet,
    type StagePrFs,
} from "./stage-pr";

/**
 * Pre-agent staging tests (deterministic-orchestrator slice 1).
 *
 * The staging this module takes over was previously performed by the
 * orchestrator following review.md Steps 1 and 3 prose; these tests pin the
 * on-disk contract those steps defined, because every sub-agent prompt and
 * every downstream CLI (router, provenance, rereview-mode, dispatch-gate)
 * reads these exact paths and shapes.
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (
    files: Record<string, string> = {},
): StagePrFs & {files: Record<string, string>} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) =>
            p in state || Object.keys(state).some((f) => f.startsWith(`${p}/`)),
        mkdirSync: () => {},
    };
};

const ghGetFromMap =
    (routes: Record<string, unknown>): GhGet =>
    (path: string) => {
        if (!(path in routes)) {
            return Promise.reject(new Error(`unexpected GET ${path}`));
        }
        return Promise.resolve(routes[path]);
    };

const PR_META = {
    number: 7,
    title: "t",
    body: "d",
    user: {login: "octo"},
    base: {ref: "main"},
    head: {sha: "abc123"},
    draft: false,
};

const PATCH_ONE = "@@ -1,2 +1,3 @@\n ctx\n+added line\n ctx";

const baseRoutes = (files: unknown[]): Record<string, unknown> => ({
    "/repos/o/r/pulls/7": PR_META,
    "/repos/o/r/pulls/7/files?per_page=100&page=1": files,
    "/repos/o/r/pulls/7/reviews?per_page=100&page=1": [],
});

describe("buildUnifiedDiff", () => {
    it("emits the Step 1 header format the provenance parser requires", () => {
        const diff = buildUnifiedDiff([
            {filename: "a.ts", status: "modified", patch: PATCH_ONE},
            {
                filename: "gone.ts",
                status: "removed",
                patch: "@@ -1 +0,0 @@\n-x",
            },
            {filename: "new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+y"},
            {
                filename: "moved.ts",
                status: "renamed",
                previous_filename: "old.ts",
                patch: "@@ -1 +1 @@\n-a\n+b",
            },
            {filename: "bin.png", status: "modified"},
        ]);
        expect(diff).toContain(
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts",
        );
        expect(diff).toContain(
            "diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null",
        );
        expect(diff).toContain(
            "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts",
        );
        expect(diff).toContain("diff --git a/old.ts b/moved.ts");
        expect(diff).not.toContain("bin.png");
        // The round-trip that matters: the shared diff parser sees every file.
        expect(splitUnifiedDiff(diff).map((s) => s.path)).toEqual([
            "a.ts",
            "gone.ts",
            "new.ts",
            "moved.ts",
        ]);
        // And the provenance map reads the added lines off it.
        expect(computeDiffProvenance(diff).files["a.ts"]?.added).toEqual([2]);
    });

    it("returns an empty string when no file carries a patch", () => {
        expect(buildUnifiedDiff([{filename: "b.png", status: "added"}])).toBe(
            "",
        );
    });
});

describe("computeNewScope", () => {
    const file = {filename: "a.ts", status: "modified", patch: PATCH_ONE};

    it("puts the whole diff in scope when there is no prior signature", () => {
        expect(computeNewScope([file], undefined)).toEqual({
            priorReview: false,
            inScope: {},
        });
        expect(computeNewScope([file], "garbled")).toEqual({
            priorReview: false,
            inScope: {},
        });
    });

    it("drops hunks whose added-lines hash the previous run already saw", () => {
        const seen = {"a.ts": [hashHunkAddedLines(PATCH_ONE)]};
        expect(computeNewScope([file], seen)).toEqual({
            priorReview: true,
            inScope: {},
        });
    });

    it("keeps unseen hunks with their RIGHT-side added line numbers", () => {
        const scope = computeNewScope([file], {"a.ts": ["other-hash"]});
        expect(scope).toEqual({priorReview: true, inScope: {"a.ts": [2]}});
    });

    it("hashes added lines only, `+` stripped and trailing whitespace trimmed", () => {
        const a = hashHunkAddedLines("@@ -1 +1,2 @@\n ctx\n+x  ");
        const b = hashHunkAddedLines("@@ -9 +9,2 @@\n other ctx\n+x");
        expect(a).toBe(b);
    });

    it("includes added lines whose content itself starts with `+` (e.g. `++counter`)", () => {
        // `++counter` serializes as `+++counter` in the patch; a
        // header-shaped exclusion would drop it from the hash while the line
        // numbering still counts it, so a push changing only that line would
        // be scoped out as already-reviewed.
        const before = "@@ -1 +1,2 @@\n ctx\n+++counter";
        const after = "@@ -1 +1,2 @@\n ctx\n+++counter2";
        expect(hashHunkAddedLines(before)).not.toBe(hashHunkAddedLines(after));
        const scope = computeNewScope(
            [
                {
                    filename: "a.ts",
                    status: "modified",
                    patch: after,
                },
            ],
            {"a.ts": [hashHunkAddedLines(before)]},
        );
        expect(scope.inScope).toEqual({"a.ts": [2]});
    });
});

describe("computeDiffFingerprint", () => {
    it("hashes the patch, falling back to status/additions/deletions", () => {
        const fp = computeDiffFingerprint([
            {filename: "b.png", status: "modified", additions: 1, deletions: 2},
            {filename: "a.ts", status: "modified", patch: PATCH_ONE},
        ]);
        expect(Object.keys(fp)).toEqual(["a.ts", "b.png"]);
        expect(fp["a.ts"]).toMatch(/^[0-9a-f]{64}$/);
        expect(fp["b.png"]).toMatch(/^[0-9a-f]{64}$/);
        expect(fp["a.ts"]).not.toBe(fp["b.png"]);
    });
});

describe("runStagePrCli", () => {
    const options = {repo: "o/r", prNumber: 7, repoRoot: "/work"};

    it("stages the full Step 1 + Step 3 contract for a first review", async () => {
        const fs = makeFakeFs({
            "/tmp/gh-aw/aw-prompts/prompt.txt": [
                "<!-- BEGIN REVIEW DISCIPLINES -->",
                "## Structured finding schema and hunts",
                "<!-- END REVIEW DISCIPLINES -->",
            ].join("\n"),
        });
        const result = await runStagePrCli(
            fs,
            ghGetFromMap(
                baseRoutes([
                    {filename: "a.ts", status: "modified", patch: PATCH_ONE},
                    {filename: "bin.png", status: "modified", additions: 1},
                ]),
            ),
            options,
        );

        const read = (name: string) => fs.files[`${REVIEW}/${name}`];
        expect(JSON.parse(read("pr-context.json"))).toMatchObject({
            number: 7,
            title: "t",
            author: "octo",
            baseBranch: "main",
            headSha: "abc123",
            isDraft: false,
            repo: "o/r",
            diffPath: `${REVIEW}/full.diff`,
        });
        expect(JSON.parse(read("files.json"))).toEqual([
            {path: "a.ts", status: "modified", hasPatch: true},
            {path: "bin.png", status: "modified", hasPatch: false},
        ]);
        expect(read("full.diff")).toContain("diff --git a/a.ts b/a.ts");
        const facts = JSON.parse(read("diff-facts.json"));
        expect(Object.keys(facts.diffFingerprint)).toEqual(["a.ts", "bin.png"]);
        expect(facts.hunkSignature["a.ts"]).toEqual([
            hashHunkAddedLines(PATCH_ONE),
        ]);
        expect(JSON.parse(read("new-scope.json"))).toEqual({
            priorReview: false,
            inScope: {},
        });
        expect(JSON.parse(read("prior-reviews.json"))).toEqual([]);
        // The deterministic CLI chain ran: router → provenance → plan.
        expect(JSON.parse(read("routing.json"))).toMatchObject({
            reReviewMode: "full",
        });
        expect(JSON.parse(read("provenance.json")).files["a.ts"].added).toEqual(
            [2],
        );
        expect(read("full-stripped.diff")).toContain("a.ts");
        expect(read("full-stripped-annotated.diff")).toContain("added line");
        const plan = JSON.parse(read("rereview-plan.json"));
        expect(plan.depth).toBe("full");
        expect(
            JSON.parse(fs.files[`${REVIEW}/out/rereview-plan.json`]),
        ).toEqual(plan);
        expect(result.depth).toBe("full");
        expect(result.changedFileCount).toBe(2);
        expect(result.warnings).toEqual([]);
    });

    it("computes new-scope from cache memory's reviewedHunks", async () => {
        const fs = makeFakeFs({
            "/tmp/gh-aw/cache-memory/pr-7.json": JSON.stringify({
                reviewedHunks: {"a.ts": [hashHunkAddedLines(PATCH_ONE)]},
            }),
        });
        await runStagePrCli(
            fs,
            ghGetFromMap(
                baseRoutes([
                    {filename: "a.ts", status: "modified", patch: PATCH_ONE},
                ]),
            ),
            options,
        );
        expect(JSON.parse(fs.files[`${REVIEW}/new-scope.json`])).toEqual({
            priorReview: true,
            inScope: {},
        });
    });

    it("paginates the files fetch past 100 entries", async () => {
        const page1 = Array.from({length: 100}, (_, i) => ({
            filename: `f${String(i).padStart(3, "0")}.ts`,
            status: "modified",
            patch: PATCH_ONE,
        }));
        const routes = {
            ...baseRoutes(page1),
            "/repos/o/r/pulls/7/files?per_page=100&page=2": [
                {filename: "last.ts", status: "modified", patch: PATCH_ONE},
            ],
        };
        const fs = makeFakeFs();
        const result = await runStagePrCli(fs, ghGetFromMap(routes), options);
        expect(result.changedFileCount).toBe(101);
        expect(
            JSON.parse(fs.files[`${REVIEW}/files.json`]).map(
                (f: {path: string}) => f.path,
            ),
        ).toContain("last.ts");
    });

    it("degrades a failed reviews fetch to [] with a warning (re-review goes full)", async () => {
        const routes = baseRoutes([
            {filename: "a.ts", status: "modified", patch: PATCH_ONE},
        ]);
        delete routes["/repos/o/r/pulls/7/reviews?per_page=100&page=1"];
        const fs = makeFakeFs();
        const result = await runStagePrCli(fs, ghGetFromMap(routes), options);
        expect(JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`])).toEqual(
            [],
        );
        expect(result.warnings.join(" ")).toContain(
            "prior-reviews fetch failed",
        );
        expect(JSON.parse(fs.files[`${REVIEW}/rereview-plan.json`]).depth).toBe(
            "full",
        );
    });

    it("keeps only github-actions[bot] reviews, every state, body verbatim", async () => {
        const routes = baseRoutes([
            {filename: "a.ts", status: "modified", patch: PATCH_ONE},
        ]);
        routes["/repos/o/r/pulls/7/reviews?per_page=100&page=1"] = [
            {
                user: {login: "github-actions[bot]"},
                body: "dismissed body",
                submitted_at: "2026-07-01T00:00:00Z",
                state: "DISMISSED",
            },
            {user: {login: "human"}, body: "lgtm", state: "APPROVED"},
        ];
        const fs = makeFakeFs();
        await runStagePrCli(fs, ghGetFromMap(routes), options);
        expect(JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`])).toEqual([
            {body: "dismissed body", submittedAt: "2026-07-01T00:00:00Z"},
        ]);
    });

    it("performs the scoped swap and flip-gated staging from the staged plan", async () => {
        // Prior review stamped over three hunks of a.ts; the current diff
        // carries those plus one new hunk in b.ts (unreviewed share 0.25,
        // under the divergence tripwire's 0.4). Under flip-gated mode the
        // plan stages new-hunks, so the whole-change surfaces and the review
        // diff must shrink to b.ts before the agent ever runs.
        const hunkA = [
            "@@ -1,2 +1,3 @@\n ctx\n+alpha\n ctx",
            "@@ -10,2 +11,3 @@\n ctx\n+alpha2\n ctx",
            "@@ -20,2 +22,3 @@\n ctx\n+alpha3\n ctx",
        ].join("\n");
        const hunkB = "@@ -5,2 +5,3 @@\n ctx\n+beta\n ctx";
        const priorDiff = buildUnifiedDiff([
            {filename: "a.ts", status: "modified", patch: hunkA},
        ]);
        const stamp = renderRereviewStamp({
            schemaVersion: STAMP_SCHEMA_VERSION,
            depth: "full",
            verdict: "APPROVE",
            anchorDraft: false,
            anchorHunks: computeHunkSignature(priorDiff),
        });
        const routes = baseRoutes([
            {filename: "a.ts", status: "modified", patch: hunkA},
            {filename: "b.ts", status: "modified", patch: hunkB},
        ]);
        routes["/repos/o/r/pulls/7/reviews?per_page=100&page=1"] = [
            {
                user: {login: "github-actions[bot]"},
                body: stamp,
                submitted_at: "2026-07-01T00:00:00Z",
                state: "APPROVED",
            },
        ];
        const fs = makeFakeFs({
            "/work/.github/aw/review/ROUTING": "re-review flip-gated\n",
        });
        const result = await runStagePrCli(fs, ghGetFromMap(routes), options);

        expect(result.depth).toBe("flip-gated");
        const scoped = fs.files[`${REVIEW}/scoped.diff`];
        expect(scoped).toContain("b.ts");
        expect(scoped).not.toContain("alpha");
        expect(fs.files[`${REVIEW}/full-stripped.diff`]).toBe(scoped);
        expect(fs.files[`${REVIEW}/pr.diff`]).toBe(scoped);
        expect(fs.files[`${REVIEW}/pr-annotated.diff`]).toContain("beta");
        expect(JSON.parse(fs.files[`${REVIEW}/review-files.json`])).toEqual([
            {path: "b.ts", status: "modified", hasPatch: true},
        ]);
    });

    it("fails hard when the PR metadata fetch fails (staging is a prerequisite)", async () => {
        const fs = makeFakeFs();
        await expect(
            runStagePrCli(fs, ghGetFromMap({}), options),
        ).rejects.toThrow("unexpected GET /repos/o/r/pulls/7");
        expect(fs.files[`${REVIEW}/pr-context.json`]).toBe(undefined);
    });
});

describe("review-feedback coverage (slice 1 hardening)", () => {
    const options = {repo: "o/r", prNumber: 7, repoRoot: "/work"};
    const oneFile = () =>
        baseRoutes([{filename: "a.ts", status: "modified", patch: PATCH_ONE}]);

    it("degrades an unparseable cache file to whole-diff scope with a warning", async () => {
        const fs = makeFakeFs({
            "/tmp/gh-aw/cache-memory/pr-7.json": "corrupt {",
        });
        const result = await runStagePrCli(
            fs,
            ghGetFromMap(oneFile()),
            options,
        );
        expect(JSON.parse(fs.files[`${REVIEW}/new-scope.json`])).toEqual({
            priorReview: false,
            inScope: {},
        });
        expect(result.warnings.join(" ")).toContain("cache memory unparseable");
    });

    it("paginates the reviews fetch past 100 entries and keeps the newest stamp", async () => {
        const routes = oneFile();
        routes["/repos/o/r/pulls/7/reviews?per_page=100&page=1"] = Array.from(
            {length: 100},
            (_, i) => ({
                user: {login: "github-actions[bot]"},
                body: `old ${i}`,
                submitted_at: "2026-07-01T00:00:00Z",
            }),
        );
        routes["/repos/o/r/pulls/7/reviews?per_page=100&page=2"] = [
            {
                user: {login: "github-actions[bot]"},
                body: "newest",
                submitted_at: "2026-07-20T00:00:00Z",
            },
        ];
        const fs = makeFakeFs();
        await runStagePrCli(fs, ghGetFromMap(routes), options);
        const staged = JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`]);
        expect(staged).toHaveLength(101);
        expect(staged.at(-1).body).toBe("newest");
    });

    it("fails hard on metadata missing load-bearing fields (no partial staging)", async () => {
        const routes = oneFile();
        routes["/repos/o/r/pulls/7"] = {number: 7, title: "t"};
        const fs = makeFakeFs();
        await expect(
            runStagePrCli(fs, ghGetFromMap(routes), options),
        ).rejects.toThrow(/load-bearing fields/);
        expect(fs.files[`${REVIEW}/pr-context.json`]).toBe(undefined);
    });

    it("fails hard when the files endpoint returns a non-array", async () => {
        const routes = oneFile();
        routes["/repos/o/r/pulls/7/files?per_page=100&page=1"] = {oops: true};
        await expect(
            runStagePrCli(makeFakeFs(), ghGetFromMap(routes), options),
        ).rejects.toThrow(/non-array/);
    });

    it("performs the scoped-depth swap: stripped and annotated shrink, pr.diff stays triage's", async () => {
        const hunkA = [
            "@@ -1,2 +1,3 @@\n ctx\n+alpha\n ctx",
            "@@ -10,2 +11,3 @@\n ctx\n+alpha2\n ctx",
            "@@ -20,2 +22,3 @@\n ctx\n+alpha3\n ctx",
        ].join("\n");
        const hunkB = "@@ -5,2 +5,3 @@\n ctx\n+beta\n ctx";
        const priorDiff = buildUnifiedDiff([
            {filename: "a.ts", status: "modified", patch: hunkA},
        ]);
        const stamp = renderRereviewStamp({
            schemaVersion: STAMP_SCHEMA_VERSION,
            depth: "full",
            verdict: "APPROVE",
            anchorDraft: false,
            anchorHunks: computeHunkSignature(priorDiff),
        });
        const routes = baseRoutes([
            {filename: "a.ts", status: "modified", patch: hunkA},
            {filename: "b.ts", status: "modified", patch: hunkB},
        ]);
        routes["/repos/o/r/pulls/7/reviews?per_page=100&page=1"] = [
            {
                user: {login: "github-actions[bot]"},
                body: stamp,
                submitted_at: "2026-07-01T00:00:00Z",
                state: "APPROVED",
            },
        ];
        const fs = makeFakeFs({
            "/work/.github/aw/review/ROUTING": "re-review scoped\n",
        });
        const result = await runStagePrCli(fs, ghGetFromMap(routes), options);
        expect(result.depth).toBe("scoped");
        const scoped = fs.files[`${REVIEW}/scoped.diff`];
        expect(scoped).toContain("beta");
        expect(scoped).not.toContain("alpha");
        expect(fs.files[`${REVIEW}/full-stripped.diff`]).toBe(scoped);
        expect(fs.files[`${REVIEW}/full-stripped-annotated.diff`]).toContain(
            "beta",
        );
        expect(
            fs.files[`${REVIEW}/full-stripped-annotated.diff`],
        ).not.toContain("alpha");
        // At scoped depth, pattern-triage still owns pr.diff mid-run.
        expect(fs.files[`${REVIEW}/pr.diff`]).toBe(undefined);
        expect(fs.files[`${REVIEW}/review-files.json`]).toBe(undefined);
    });

    it("router second pass changes only tiers/budget: generatedFiles and reReviewMode are pass-stable", async () => {
        // The invariant the pre-staged provenance and re-review artifacts
        // rely on (stated in the staging step's rationale): resolving the
        // direction-dependent tier questions must not move anything those
        // CLIs read.
        const fs = makeFakeFs({
            "/work/.github/aw/review/ROUTING": [
                "re-review scoped",
                "pkg/auth/** tier=high direction-dependent lens=security-auth",
            ].join("\n"),
            "/work/.gitattributes": "*.lock linguist-generated\n",
        });
        const routes = baseRoutes([
            {filename: "pkg/auth/x.ts", status: "modified", patch: PATCH_ONE},
            {filename: "yarn.lock", status: "modified", patch: PATCH_ONE},
        ]);
        await runStagePrCli(fs, ghGetFromMap(routes), options);
        const first = JSON.parse(fs.files[`${REVIEW}/routing.json`]);
        // Second pass: answers staged, router re-run (as the orchestrator
        // does mid-run).
        fs.files["/tmp/gh-aw/review/resolved-tiers.json"] = JSON.stringify({
            "pkg/auth/x.ts": "Low",
        });
        runRouterCli(fs, "/work", {});
        const second = JSON.parse(fs.files[`${REVIEW}/routing.json`]);
        expect(second.generatedFiles).toEqual(first.generatedFiles);
        expect(second.reReviewMode).toBe(first.reReviewMode);
        expect(second.perFileTier["pkg/auth/x.ts"]).not.toBe(
            first.perFileTier["pkg/auth/x.ts"],
        );
    });
});

describe("disciplines extraction (slice 3, #247)", () => {
    const PROMPT = "/tmp/gh-aw/aw-prompts/prompt.txt";
    const options = {
        repo: "o/r",
        prNumber: 7,
        repoRoot: "/work",
    };
    const routes = () =>
        baseRoutes([{filename: "a.ts", status: "modified", patch: PATCH_ONE}]);
    const disciplines = [
        "<!-- BEGIN REVIEW DISCIPLINES -->",
        "# Review disciplines (specialist lenses)",
        "## Structured finding schema and hunts",
        "rules...",
        "<!-- END REVIEW DISCIPLINES -->",
    ].join("\n");

    it("extracts the marker-delimited section and verifies the schema heading", async () => {
        const fs = makeFakeFs({
            [PROMPT]: `preamble\n${disciplines}\ntrailer\n`,
        });
        const result = await runStagePrCli(fs, ghGetFromMap(routes()), options);
        expect(fs.files[`${REVIEW}/disciplines.md`]).toBe(`${disciplines}\n`);
        expect(
            result.warnings.filter((w) => w.includes("disciplines")),
        ).toEqual([]);
    });

    it("warns (fallback applies) when the schema heading is missing", async () => {
        const broken = disciplines.replace(
            "## Structured finding schema and hunts",
            "## Something else",
        );
        const fs = makeFakeFs({[PROMPT]: broken});
        const result = await runStagePrCli(fs, ghGetFromMap(routes()), options);
        expect(fs.files[`${REVIEW}/disciplines.md`]).toBe(undefined);
        expect(result.warnings.join(" ")).toContain("schema-heading verify");
    });

    it("warns when the prompt or its markers are absent", async () => {
        const noPrompt = makeFakeFs();
        const r1 = await runStagePrCli(
            noPrompt,
            ghGetFromMap(routes()),
            options,
        );
        expect(r1.warnings.join(" ")).toContain("rendered prompt not found");
        const noMarkers = makeFakeFs({[PROMPT]: "just a prompt"});
        const r2 = await runStagePrCli(
            noMarkers,
            ghGetFromMap(routes()),
            options,
        );
        expect(r2.warnings.join(" ")).toContain("markers not found");
    });
});
