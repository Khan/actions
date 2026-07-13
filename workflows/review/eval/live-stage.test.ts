import {describe, it, expect} from "vitest";
import {Volume} from "memfs";

import {parseCase} from "./corpus/loader";
import {
    PRODUCTION_REVIEW_DIR,
    rewriteAgentPrompt,
    stageCase,
    type StageFs,
} from "./live-stage";

/** Adapt a memfs volume to the staging fs seam. */
const volFs = (vol: InstanceType<typeof Volume>): StageFs => ({
    existsSync: (p) => vol.existsSync(p),
    mkdirSync: (p, opts) => {
        vol.mkdirSync(p, opts);
    },
    readdirSync: (p, opts) =>
        vol.readdirSync(p, opts) as unknown as ReturnType<
            StageFs["readdirSync"]
        >,
    readFileSync: (p, enc) => vol.readFileSync(p, enc) as string,
    writeFileSync: (p, data) => {
        vol.writeFileSync(p, data);
    },
});

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

/** A live case parsed through the real loader path. */
const liveCase = (over: Record<string, unknown> = {}) =>
    parseCase(
        {
            id: "stage-case",
            tags: ["live"],
            category: "clean",
            description: "a stageable case",
            changedFiles: [
                {path: "src/a.ts", status: "modified"},
                // Listed but absent from the diff: hasPatch must be false.
                {path: "assets/logo.png", status: "modified"},
            ],
            expected: {verdict: "APPROVE"},
            diff: DIFF,
            live: {
                prContext: {
                    title: "A staged change",
                    description: "body text",
                    author: "octocat",
                    baseBranch: "main",
                },
            },
            ...over,
        },
        "/corpus/clean/stage-case/case.json",
    );

const treeVol = () =>
    Volume.fromJSON({
        "/corpus/clean/stage-case/tree/src/a.ts": "const a = 2;\nexport {a};\n",
        "/corpus/clean/stage-case/tree/assets/logo.png": "binaryish",
    });

describe("stageCase", () => {
    it("materializes the production staging layout", () => {
        const vol = treeVol();
        const staged = stageCase(liveCase(), "/stage", volFs(vol));
        expect(staged.contextDir).toBe("/stage/context");
        expect(staged.checkoutDir).toBe("/stage/checkout");

        const read = (p: string) => vol.readFileSync(p, "utf8") as string;
        expect(read("/stage/context/full.diff")).toBe(DIFF);
        expect(read("/stage/context/pr.diff")).toBe(DIFF);
        expect(read("/stage/context/full-stripped.diff")).toBe(DIFF);

        const files = JSON.parse(read("/stage/context/files.json"));
        expect(files).toEqual([
            {path: "src/a.ts", status: "modified", hasPatch: true},
            {path: "assets/logo.png", status: "modified", hasPatch: false},
        ]);
        expect(read("/stage/context/review-files.json")).toBe(
            read("/stage/context/files.json"),
        );

        const prContext = JSON.parse(read("/stage/context/pr-context.json"));
        expect(prContext.title).toBe("A staged change");
        expect(prContext.author).toBe("octocat");
        expect(prContext.baseBranch).toBe("main");
        expect(prContext.isDraft).toBe(false);
        expect(prContext.diffPath).toBe("/stage/context/full.diff");
        expect(prContext.filesPath).toBe("/stage/context/files.json");

        const provenance = JSON.parse(read("/stage/context/provenance.json"));
        expect(provenance.warnings).toEqual([]);
        expect(provenance.files["src/a.ts"].added).toContain(1);

        expect(JSON.parse(read("/stage/context/routing.json"))).toHaveProperty(
            "lensesToSpawn",
        );
        expect(vol.existsSync("/stage/context/out")).toBe(true);
    });

    it("copies the tree recursively into the checkout", () => {
        const vol = treeVol();
        stageCase(liveCase(), "/stage", volFs(vol));
        expect(vol.readFileSync("/stage/checkout/src/a.ts", "utf8")).toBe(
            "const a = 2;\nexport {a};\n",
        );
        expect(vol.existsSync("/stage/checkout/assets/logo.png")).toBe(true);
    });

    it("throws on a non-live case and on a missing tree", () => {
        const recorded = parseCase(
            {
                id: "recorded-only",
                tags: ["smoke"],
                category: "clean",
                description: "no live block",
                changedFiles: [{path: "src/a.ts", status: "modified"}],
                expected: {verdict: "APPROVE"},
            },
            "/corpus/clean/recorded-only.json",
        );
        expect(() =>
            stageCase(recorded, "/stage", volFs(new Volume())),
        ).toThrow(/not live-enabled/);
        expect(() =>
            stageCase(liveCase(), "/stage", volFs(new Volume())),
        ).toThrow(/tree .* does not exist/);
    });
});

describe("rewriteAgentPrompt", () => {
    it("rewrites every production staging path to the case context dir", () => {
        const vol = treeVol();
        const staged = stageCase(liveCase(), "/stage", volFs(vol));
        const prompt = [
            `Read ${PRODUCTION_REVIEW_DIR}/pr-context.json first.`,
            `The diff: ${PRODUCTION_REVIEW_DIR}/pr.diff.`,
            `Write output under ${PRODUCTION_REVIEW_DIR}/out/.`,
        ].join("\n");
        const rewritten = rewriteAgentPrompt(prompt, staged);
        expect(rewritten).not.toContain(PRODUCTION_REVIEW_DIR);
        expect(rewritten).toContain("/stage/context/pr-context.json");
        expect(rewritten).toContain("/stage/context/pr.diff");
        expect(rewritten).toContain("/stage/context/out/");
    });
});
