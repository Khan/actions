import {describe, it, expect} from "vitest";

import {
    applyProvenanceGate,
    computeDiffProvenance,
    isAnchorInProvenance,
    runProvenanceCli,
    type DiffProvenance,
} from "./provenance.ts";
import {labelForFinding, isBlockingLabel} from "./render-comment.ts";
import {
    FINDING_SCHEMA_VERSION,
    assertFinding,
    type Finding,
} from "./finding-schema.ts";

/**
 * Unit tests for the change-provenance gate: a finding whose anchor is not an
 * added or modified line of the diff cannot carry a blocking label, and
 * pre-existing observations are set aside (artifact-only, never posted). Also
 * covers the CLI that stages `provenance.json` and the generated-stripped
 * whole-change diff.
 */

const DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,4 @@",
    " context();",
    "-oldGuard();",
    "+newGuard();",
    " more();",
    " tail();",
].join("\n");

const provenance = (): DiffProvenance => computeDiffProvenance(DIFF);

const makeFinding = (overrides: Record<string, unknown> = {}): Finding =>
    assertFinding({
        schema_version: FINDING_SCHEMA_VERSION,
        id: "finding-1",
        lens: "correctness",
        anchor: {type: "line", path: "src/app.ts", line: 11},
        severity: "blocking",
        confidence: 0.9,
        evidence_trace: ["src/app.ts:11 replaces the guard"],
        failure_scenario:
            "A request that the old guard rejected passes the new guard and reaches the handler.",
        producing_hunt: "correctness:line-scan",
        model_authored_prose: "The replacement guard drops the null check.",
        ...overrides,
    });

describe("computeDiffProvenance", () => {
    it("maps the diff's changed lines and reports no warnings", () => {
        const prov = provenance();
        expect(prov.warnings).toEqual([]);
        expect(prov.files["src/app.ts"].added).toEqual([11]);
        expect(prov.files["src/app.ts"].removed).toEqual([11]);
    });

    it("flags an unparseable non-empty diff so the gate fails open", () => {
        const prov = computeDiffProvenance("@@ hunks with no file headers\n+x");
        expect(prov.files).toEqual({});
        expect(prov.warnings).toHaveLength(1);
    });

    it("treats an empty diff as valid and empty", () => {
        expect(computeDiffProvenance("")).toEqual({files: {}, warnings: []});
    });

    it("flags a partially garbled diff (orphan hunks) so the gate fails open", () => {
        const partiallyGarbled = [
            "dfif --git a/src/lost.ts b/src/lost.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            DIFF,
        ].join("\n");
        const prov = computeDiffProvenance(partiallyGarbled);
        // The intact section still parses, so zero-sections cannot catch
        // this; the orphan-hunk tripwire is what does.
        expect(Object.keys(prov.files)).toEqual(["src/app.ts"]);
        expect(prov.warnings).toHaveLength(1);
        expect(prov.warnings[0]).toMatch(/not attributable/);

        // And the gate honors it: nothing is demoted on a partial parse.
        const offAnchor = makeFinding({
            anchor: {type: "line", path: "src/app.ts", line: 13},
        });
        const {kept, preExisting} = applyProvenanceGate([offAnchor], prov);
        expect(kept).toEqual([offAnchor]);
        expect(preExisting).toEqual([]);
    });
});

describe("isAnchorInProvenance", () => {
    it("accepts a RIGHT-side anchor on an added line", () => {
        expect(
            isAnchorInProvenance(
                {type: "line", path: "src/app.ts", line: 11, side: "RIGHT"},
                provenance(),
            ),
        ).toBe(true);
    });

    it("rejects a RIGHT-side anchor on an untouched context line", () => {
        expect(
            isAnchorInProvenance(
                {type: "line", path: "src/app.ts", line: 13},
                provenance(),
            ),
        ).toBe(false);
    });

    it("accepts a LEFT-side anchor on a removed line", () => {
        expect(
            isAnchorInProvenance(
                {type: "line", path: "src/app.ts", line: 11, side: "LEFT"},
                provenance(),
            ),
        ).toBe(true);
    });

    it("accepts a range anchor when any line of the range is changed", () => {
        expect(
            isAnchorInProvenance(
                {type: "line", path: "src/app.ts", line: 12, start_line: 10},
                provenance(),
            ),
        ).toBe(true);
    });

    it("rejects an anchor on a file outside the diff", () => {
        expect(
            isAnchorInProvenance(
                {type: "line", path: "src/other.ts", line: 11},
                provenance(),
            ),
        ).toBe(false);
    });

    it("accepts file anchors on changed files and pr anchors always", () => {
        expect(
            isAnchorInProvenance(
                {type: "file", path: "src/app.ts"},
                provenance(),
            ),
        ).toBe(true);
        expect(
            isAnchorInProvenance(
                {type: "file", path: "src/other.ts"},
                provenance(),
            ),
        ).toBe(false);
        expect(isAnchorInProvenance({type: "pr"}, provenance())).toBe(true);
    });
});

describe("applyProvenanceGate", () => {
    it("keeps change-anchored findings unchanged", () => {
        const finding = makeFinding();
        const {kept, preExisting} = applyProvenanceGate(
            [finding],
            provenance(),
        );
        expect(kept).toEqual([finding]);
        expect(preExisting).toEqual([]);
    });

    it("sets aside an out-of-provenance finding and demotes it so no label computation can block", () => {
        const finding = makeFinding({
            anchor: {type: "line", path: "src/app.ts", line: 13},
        });
        const {kept, preExisting} = applyProvenanceGate(
            [finding],
            provenance(),
        );
        expect(kept).toEqual([]);
        expect(preExisting).toHaveLength(1);
        expect(preExisting[0].severity).toBe("advisory");
        // The enforcement the design names: the demoted finding cannot carry
        // a blocking label through the code-owned label computation.
        expect(isBlockingLabel(labelForFinding(preExisting[0]))).toBe(false);
    });

    it("fails open (keeps everything) when the provenance map is unusable", () => {
        const finding = makeFinding({
            anchor: {type: "line", path: "src/app.ts", line: 13},
        });
        const broken = computeDiffProvenance("not a diff at all");
        expect(broken.warnings.length).toBeGreaterThan(0);
        const {kept, preExisting} = applyProvenanceGate([finding], broken);
        expect(kept).toEqual([finding]);
        expect(preExisting).toEqual([]);
    });
});

describe("runProvenanceCli", () => {
    type Files = Record<string, string>;

    const makeFs = (files: Files) => {
        const written: Files = {};
        return {
            written,
            fs: {
                readFileSync: (p: string) => {
                    const content = written[p] ?? files[p];
                    if (content === undefined) {
                        throw new Error(`ENOENT: ${p}`);
                    }
                    return content;
                },
                writeFileSync: (p: string, data: string) => {
                    written[p] = data;
                },
                existsSync: (p: string) =>
                    (written[p] ?? files[p]) !== undefined,
                mkdirSync: () => undefined,
            },
        };
    };

    const GENERATED_DIFF = [
        DIFF,
        "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
        "--- a/pnpm-lock.yaml",
        "+++ b/pnpm-lock.yaml",
        "@@ -1 +1 @@",
        "-lockfile: 1",
        "+lockfile: 2",
    ].join("\n");

    it("writes provenance.json and the generated-stripped diff", () => {
        const {fs, written} = makeFs({
            "/tmp/gh-aw/review/full.diff": GENERATED_DIFF,
            "/tmp/gh-aw/review/routing.json": JSON.stringify({
                generatedFiles: ["pnpm-lock.yaml"],
            }),
        });
        const result = runProvenanceCli(fs);
        expect(result.strippedFiles).toEqual(["pnpm-lock.yaml"]);

        const provJson = JSON.parse(
            written["/tmp/gh-aw/review/provenance.json"],
        ) as DiffProvenance;
        expect(Object.keys(provJson.files).sort()).toEqual([
            "pnpm-lock.yaml",
            "src/app.ts",
        ]);
        expect(provJson.warnings).toEqual([]);

        const stripped = written["/tmp/gh-aw/review/full-stripped.diff"];
        expect(stripped).toContain("src/app.ts");
        expect(stripped).not.toContain("pnpm-lock.yaml");
    });

    it("keeps the stripped diff equal to the full diff when routing.json is absent", () => {
        const {fs, written} = makeFs({
            "/tmp/gh-aw/review/full.diff": GENERATED_DIFF,
        });
        const result = runProvenanceCli(fs);
        expect(result.strippedFiles).toEqual([]);
        expect(written["/tmp/gh-aw/review/full-stripped.diff"]).toBe(
            GENERATED_DIFF,
        );
    });

    it("flags a changed file with a patch that is missing from the parsed diff", () => {
        const {fs, written} = makeFs({
            "/tmp/gh-aw/review/full.diff": DIFF,
            "/tmp/gh-aw/review/files.json": JSON.stringify([
                {path: "src/app.ts", status: "modified", hasPatch: true},
                {path: "src/absorbed.ts", status: "modified", hasPatch: true},
                {path: "assets/logo.png", status: "added", hasPatch: false},
            ]),
        });
        const result = runProvenanceCli(fs);
        expect(result.provenance.warnings).toHaveLength(1);
        expect(result.provenance.warnings[0]).toMatch(/src\/absorbed\.ts/);
        // The binary (hasPatch: false) file is legitimately absent from the
        // diff and must not trigger the fail-open.
        expect(result.provenance.warnings[0]).not.toMatch(/logo\.png/);
        const provJson = JSON.parse(
            written["/tmp/gh-aw/review/provenance.json"] ?? "{}",
        ) as DiffProvenance;
        expect(provJson.warnings).toHaveLength(1);
    });

    it("skips the completeness check for entries without hasPatch (older staging)", () => {
        const {fs} = makeFs({
            "/tmp/gh-aw/review/full.diff": DIFF,
            "/tmp/gh-aw/review/files.json": JSON.stringify([
                {path: "src/app.ts", status: "modified"},
                {path: "src/not-in-diff.ts", status: "modified"},
            ]),
        });
        expect(runProvenanceCli(fs).provenance.warnings).toEqual([]);
    });

    it("emits a fail-open warning when the full diff was never staged", () => {
        const {fs, written} = makeFs({});
        const result = runProvenanceCli(fs);
        expect(result.provenance.warnings).toHaveLength(1);
        const provJson = JSON.parse(
            written["/tmp/gh-aw/review/provenance.json"],
        ) as DiffProvenance;
        expect(provJson.warnings).toHaveLength(1);
    });
});
