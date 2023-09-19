import filterFiles from ".";

describe("filterFiles", () => {
    // eslint-disable-next-line no-console
    const core = {info: console.info};
    const invert = true;

    it("should return a new array files that are not filtered", () => {
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
});
