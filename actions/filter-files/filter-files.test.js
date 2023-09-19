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
});
