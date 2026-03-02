import {describe, it, expect} from "vitest";
import filterFiles from "./index.ts";

describe("filterFiles", () => {
    const core = console;

    it("should honor NOT globs", () => {
        const inputFiles = [
            "other/thing.ts",
            "packages/this-one.ts",
            "packages/some.json",
        ];

        const result = filterFiles({
            globsRaw: `packages/*\n!packages/*.json`,
            inputFiles,
            core,
        });

        expect(result).toEqual(["packages/this-one.ts"]);
    });

    it("should ignore comment lines", () => {
        const inputFiles = ["other/thing.ts", "packages/this-one.ts"];

        const result = filterFiles({
            globsRaw: `# this is a comment\nother/*`,
            inputFiles,
            matchAllGlobs: true,
            core,
        });

        expect(result).toEqual(["other/thing.ts"]);
    });

    it("should return a new array files that are not filtered", () => {
        const invert = true;
        const inputFiles = [
            ".github/workflows/test.yml",
            ".changeset/README.md",
            "other/thing.ts",
            "packages/core/src/index.ts",
            "packages/core/src/index.test.ts",
            "packages/core/src/index.jsx",
            "packages/core/src/index.test.jsx",
            "packages/core/src/styles.css",
            "packages/this-one.ts",
        ];
        const expected = [
            "other/thing.ts",
            "packages/core/src/index.ts",
            "packages/core/src/index.jsx",
            "packages/core/src/styles.css",
        ];
        const extensionsRaw = `test.ts
        test.js
        test.jsx
        test.tsx`;
        const exactFilesRaw = ".github/, .changeset/";
        const globsRaw = "packages/this-one.ts, packages/**/*.test.ts";

        const result = filterFiles({
            extensionsRaw,
            exactFilesRaw,
            globsRaw,
            inputFiles,
            invert,
            core,
        });

        expect(result).toEqual(expected);
    });

    it("should throw an error for unbalanced brackets", () => {
        const invert = true;
        const globsRaw =
            "!packages/**/*.{ts,tsx,js,jsx}}), packages/this-one.ts";

        expect(() =>
            filterFiles({
                extensionsRaw: "",
                exactFilesRaw: "",
                globsRaw,
                inputFiles: [],
                invert,
                core,
            }),
        ).toThrow("Unbalanced brackets in input");
    });

    it("should skip char-by-char parsing if split on newlines", () => {
        const invert = true;
        const globsRaw = `packages/**/*.ts,tsx,js,jsx}})
            packages/this-one.ts`;

        const result = filterFiles({
            extensionsRaw: "",
            exactFilesRaw: "",
            globsRaw,
            inputFiles: ["packages/this-one.ts", "not filtered"],
            invert,
            core,
        });

        expect(result).toEqual(["not filtered"]);
    });

    it("should allow whitespace", () => {
        const invert = true;
        const exactFilesRaw = `sub dir/file1.txt, file 2.txt, file 3.txt`;

        const result = filterFiles({
            extensionsRaw: "",
            exactFilesRaw,
            globsRaw: "",
            inputFiles: ["file 2.txt", "sub dir/file1.txt", "not filtered"],
            invert,
            core,
        });

        expect(result).toEqual(["not filtered"]);
    });

    it("inclusive disjunction (OR) by default", () => {
        const inputFiles = [
            ".github/workflows/test.yml",
            ".changeset/README.md",
            "other/thing.ts",
            "packages/core/src/index.ts",
            "packages/core/src/index.test.ts",
            "packages/core/src/index.jsx",
            "packages/core/src/index.test.jsx",
            "packages/core/src/styles.css",
            "packages/this-one.ts",
            "anything.ts",
        ];
        const expected = [
            "other/thing.ts",
            "packages/core/src/index.ts",
            "packages/core/src/index.test.ts",
            "packages/core/src/index.jsx",
            "packages/core/src/index.test.jsx",
            "packages/core/src/styles.css",
            "packages/this-one.ts",
            "anything.ts",
        ];
        const extensionsRaw = `ts,js,jsx,tsx`;
        const exactFilesRaw = "packages/";
        const globsRaw = "packages/this-one.ts";

        const result = filterFiles({
            extensionsRaw,
            exactFilesRaw,
            globsRaw,
            inputFiles,
            core,
        });

        expect(result).toEqual(expected);
    });

    it("conjunction (AND) when specified", () => {
        const inputFiles = [
            ".github/workflows/test.yml",
            ".changeset/README.md",
            "other/thing.ts",
            "packages/core/src/index.ts",
            "packages/core/src/index.test.ts",
            "packages/core/src/index.jsx",
            "packages/core/src/index.test.jsx",
            "packages/core/src/styles.css",
            "packages/this-one.ts",
        ];
        const expected = [
            "packages/core/src/index.ts",
            "packages/core/src/index.test.ts",
            "packages/core/src/index.jsx",
            "packages/core/src/index.test.jsx",
            "packages/this-one.ts",
        ];
        const extensionsRaw = `ts,js,jsx,tsx`;
        const exactFilesRaw = "packages/";
        const globsRaw = "**/src/*, **/*-one.ts";

        const result = filterFiles({
            inputFiles,
            extensionsRaw,
            exactFilesRaw,
            globsRaw,
            conjunctive: true,
            core,
        });

        expect(result).toEqual(expected);
    });

    it("when matchAllGlobs is true, globs should not return match unless all match", () => {
        const inputFiles = [
            "packages/wonder-blocks-icon-button/src/__tests__/__snapshots__/custom-snapshot.test.tsx.snap",
        ];

        const exactFilesRaw = "packages/";
        const globsRaw = "!(**/__tests__/**), !(**/dist/**)";

        const result = filterFiles({
            inputFiles,
            exactFilesRaw,
            globsRaw,
            conjunctive: true,
            matchAllGlobs: true,
            core,
        });

        expect(result).toEqual([]);
    });
});
