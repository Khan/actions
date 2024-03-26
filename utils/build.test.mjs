import {processActionYml} from "./build.mjs";

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
            ),
        ).toMatchInlineSnapshot(`
            "
            name: Example
            description: Do a thing
            runs:
              using: \\"composite\\"
              steps:
                - name: Limited run
                  uses: Our/monorepo@json-args-v1.2.3
                - uses: actions/github-script@v7
                  with:
                    script: |
                      require('\${{ github.action_path }}/index.js')({github, core})
            "
        `);
    });
});
