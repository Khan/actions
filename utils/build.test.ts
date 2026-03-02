import {vi, describe, it, expect} from "vitest";
import {vol} from "memfs";
import {execSync} from "child_process";

// Mock fs to use memfs
vi.mock("fs", () => vi.importActual("memfs"));
vi.mock("child_process", () => ({execSync: vi.fn().mockName("execSync")}));

import {
    buildPackage,
    extractIntraRepoDependencies,
    processActionYml,
} from "./build.ts";

describe("processActionYml", () => {
    it("should work", () => {
        const before = `
name: Example
description: Do a thing
runs:
  using: "composite"
  steps:
    - name: Limited run
      uses: ./actions/json-args
    - uses: actions/github-script@v7
      with:
        script: |
          require('./actions/full-or-limited/index.js')({github, core})
`;
        expect(
            processActionYml(
                `full-or-limited`,
                {
                    "full-or-limited": {
                        version: "0.1.2",
                        dependencies: {
                            "json-args": "*",
                        },
                    },

                    "json-args": {
                        version: "1.2.3",
                    },
                },

                before,
                "Our/monorepo",
                {
                    "json-args": {
                        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        version: "1.2.3",
                    },
                },
            ),
        ).toMatchInlineSnapshot(`
          "
          name: Example
          description: Do a thing
          runs:
            using: "composite"
            steps:
              - name: Limited run
                uses: Our/monorepo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # json-args-v1.2.3
              - uses: actions/github-script@v7
                with:
                  script: |
                    require('\${{ github.action_path }}/index.js')({github, core})
          "
        `);
    });
});

describe("extractIntraRepoDependencies", () => {
    it("finds all local action references", () => {
        const actionYml = `
runs:
  using: composite
  steps:
    - uses: ./actions/a
    - uses: ./actions/b
    - uses: ./actions/a
    - uses: actions/github-script@v7
`;
        expect(extractIntraRepoDependencies(actionYml)).toEqual(["a", "b"]);
    });
});

describe("buildPackage", () => {
    it("creates dist directory", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(vol.existsSync("./actions/test-action/dist")).toBe(true);
    });

    it("copies package.json to dist", () => {
        vol.fromJSON({
            "./actions/test-action/package.json":
                '{"name": "@khanacademy/test-action", "version": "1.0.0"}',
            "./actions/test-action/action.yml": "name: Test",
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(
            vol.readFileSync("./actions/test-action/dist/package.json", "utf8"),
        ).toBe('{"name": "@khanacademy/test-action", "version": "1.0.0"}');
    });

    it("copies markdown files to dist", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
            "./actions/test-action/README.md": "# README",
            "./actions/test-action/CHANGELOG.md": "# Changelog",
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(
            vol.readFileSync("./actions/test-action/dist/README.md", "utf8"),
        ).toBe("# README");
        expect(
            vol.readFileSync("./actions/test-action/dist/CHANGELOG.md", "utf8"),
        ).toBe("# Changelog");
    });

    it("processes action.yml and writes to dist", () => {
        const actionYml = `
name: Test Action
description: Test
runs:
  using: "composite"
  steps:
    - uses: ./actions/dependency-action`;

        vol.fromJSON({
            "./actions/test-action/action.yml": actionYml,
        });

        const packageJsons = {
            "test-action": {
                version: "1.0.0",
            },
            "dependency-action": {
                version: "2.0.0",
            },
        };

        // Act
        buildPackage("test-action", packageJsons, "Khan/actions", {
            "dependency-action": {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                version: "2.0.0",
            },
        });

        const result = vol.readFileSync(
            "./actions/test-action/dist/action.yml",
            "utf8",
        );
        expect(result).toContain(
            "Khan/actions@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # dependency-action-v2.0.0",
        );
    });

    it("bundles index.js using ncc when present", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
            "./actions/test-action/index.js": "console.log('test');",
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(execSync).toHaveBeenCalledWith(
            "pnpm ncc build actions/test-action/index.js -o actions/test-action/dist --source-map",
        );
    });

    it("prefers index.ts over index.js when both exist", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
            "./actions/test-action/index.ts": "export const value = 1;",
            "./actions/test-action/index.js": "console.log('fallback');",
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(execSync).toHaveBeenCalledWith(
            "pnpm ncc build actions/test-action/index.ts -o actions/test-action/dist --source-map",
        );
    });

    it("skips bundling when no entrypoint exists", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(execSync).not.toHaveBeenCalled();
    });

    it("works without optional files (package.json, markdown)", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
        });

        expect(() =>
            buildPackage(
                "test-action",
                {"test-action": {version: "1.0.0", dependencies: {}}},
                "Khan/actions",
            ),
        ).not.toThrow();

        expect(vol.existsSync("./actions/test-action/dist/package.json")).toBe(
            false,
        );
    });

    it("returns the dist path", () => {
        vol.fromJSON({
            "./actions/test-action/action.yml": "name: Test",
        });

        // Act
        const result = buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        expect(result).toBe("actions/test-action/dist");
    });

    it("handles action.yml with local path replacement", () => {
        const actionYml = `
name: Test
runs:
  using: "composite"
  steps:
    - uses: actions/github-script@v7
      with:
        script: |
          require('./actions/test-action/index.js')({github, core})`;

        vol.fromJSON({
            "./actions/test-action/action.yml": actionYml,
        });

        // Act
        buildPackage(
            "test-action",
            {"test-action": {version: "1.0.0", dependencies: {}}},
            "Khan/actions",
        );

        const result = vol.readFileSync(
            "./actions/test-action/dist/action.yml",
            "utf8",
        );
        expect(result).toContain("${{ github.action_path }}/index.js");
        expect(result).not.toContain("./actions/test-action/");
    });

    it("handles multiple dependencies in action.yml", () => {
        const actionYml = `
name: Test
runs:
  using: "composite"
  steps:
    - uses: ./actions/dep-1
    - uses: ./actions/dep-2
    - uses: ./actions/external-dep`;

        vol.fromJSON({
            "./actions/test-action/action.yml": actionYml,
        });

        const packageJsons = {
            "test-action": {
                version: "1.0.0",
            },
            "dep-1": {version: "1.0.0"},
            "dep-2": {version: "2.0.0"},
            // external-dep is not in packageJsons, simulating external dependency
        };

        // Act
        buildPackage("test-action", packageJsons, "Khan/actions", {
            "dep-1": {
                sha: "1111111111111111111111111111111111111111",
                version: "1.0.0",
            },
            "dep-2": {
                sha: "2222222222222222222222222222222222222222",
                version: "2.0.0",
            },
        });

        const result = vol.readFileSync(
            "./actions/test-action/dist/action.yml",
            "utf8",
        );
        expect(result).toContain(
            "Khan/actions@1111111111111111111111111111111111111111 # dep-1-v1.0.0",
        );
        expect(result).toContain(
            "Khan/actions@2222222222222222222222222222222222222222 # dep-2-v2.0.0",
        );
        // External dependency should remain unchanged
        expect(result).toContain("./actions/external-dep");
    });

    it("throws when a local dependency sha is missing", () => {
        const actionYml = `name: Test Action
runs:
  using: "composite"
  steps:
    - uses: ./actions/dependency-action`;

        vol.fromJSON({
            "./actions/test-action/action.yml": actionYml,
        });

        expect(() =>
            buildPackage(
                "test-action",
                {
                    "test-action": {version: "1.0.0"},
                    "dependency-action": {version: "2.0.0"},
                },
                "Khan/actions",
            ),
        ).toThrow(/Missing published SHA/);
    });
});
