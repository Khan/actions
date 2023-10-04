import filterFiles from ".";

describe("filterFiles", () => {
    const core = console;

    it("should return a new array files that are not filtered", () => {
        // Arrange
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
            "packages/core/src/index.ts",
            "packages/core/src/index.jsx",
        ];
        // splitting on newline
        const extensionsRaw = `test.ts
        test.js
        test.jsx
        test.tsx`;
        // splitting on comma and ignoring whitespace
        const exactFilesRaw = ".github/, .changeset/";
        // not splitting inside brackets
        const globsRaw =
            "!(packages/**/*.{ts,tsx,js,jsx}), packages/this-one.ts";

        // Act
        const result = filterFiles({
            extensionsRaw,
            exactFilesRaw,
            globsRaw,
            inputFiles,
            invert,
            core,
        });

        // Assert
        expect(result).toEqual(expected);
    });

    it("should throw an error for unbalanced brackets", () => {
        // Arrange
        const invert = true;
        const globsRaw =
            "!packages/**/*.{ts,tsx,js,jsx}}), packages/this-one.ts";

        // Assert
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
        // Note: skipping the bracket validation isn't a "feature" per se,
        //   but it's a good way to check that we have exited early

        // Arrange
        const invert = true;
        const globsRaw = `packages/**/*.ts,tsx,js,jsx}})
            packages/this-one.ts`;

        // Act
        const result = filterFiles({
            extensionsRaw: "",
            exactFilesRaw: "",
            globsRaw,
            inputFiles: ["packages/this-one.ts", "not filtered"],
            invert,
            core,
        });

        // Assert
        expect(result).toEqual(["not filtered"]);
    });

    it("should allow whitespace", () => {
        // Arrange
        const invert = true;
        const exactFilesRaw = `sub dir/file1.txt, file 2.txt, file 3.txt`;

        // Act
        const result = filterFiles({
            extensionsRaw: "",
            exactFilesRaw,
            globsRaw: "",
            inputFiles: ["file 2.txt", "sub dir/file1.txt", "not filtered"],
            invert,
            core,
        });

        // Assert
        expect(result).toEqual(["not filtered"]);
    });

    it("inclusive disjunction (OR) by default", () => {
        // Arrange
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
        const globsRaw = "!(packages/**/*.test.*), packages/this-one.ts";

        // Act
        const result = filterFiles({
            extensionsRaw,
            exactFilesRaw,
            globsRaw,
            inputFiles,
            core,
        });

        // Assert
        expect(result).toEqual(expected);
    });

    it("conjunction (AND) when specified", () => {
        // Arrange
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
            "packages/core/src/index.jsx",
            "packages/this-one.ts",
        ];
        const extensionsRaw = `ts,js,jsx,tsx`;
        const exactFilesRaw = "packages/";
        const globsRaw = "!(packages/**/*.test.*)";

        // Act
        const result = filterFiles({
            inputFiles,
            extensionsRaw,
            exactFilesRaw,
            globsRaw,
            conjunctive: true,
            core,
        });

        // Assert
        expect(result).toEqual(expected);
    });

    it("in conjunctive mode, globs should not return match unless all match", () => {
        // Arrange
        const inputFiles = [
            "packages/wonder-blocks-icon-button/src/__tests__/__snapshots__/custom-snapshot.test.tsx.snap",
        ];

        const exactFilesRaw = "packages/";
        const globsRaw = "!(**/__tests__/**), !(**/dist/**)";

        // Act
        const result = filterFiles({
            inputFiles,
            exactFilesRaw,
            globsRaw,
            conjunctive: true,
            core,
        });

        // Assert
        expect(result).toEqual([]);
    });
});
