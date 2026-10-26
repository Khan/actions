import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import * as realFs from "node:fs";
import path from "node:path";
import {parse} from "yaml";

import {processActionYml} from "./build.ts";

// The runner parses `${{` in some of an action's descriptions (an input's, at
// least) as an expression when it loads the action, and only a few contexts
// are available there. An expression that uses another one (`vars` and
// `secrets`, for example) fails every job that uses the action at "Set up
// job", before any step runs; fix-workflows v4.0.0 shipped that way with
// `vars`.
//
// Which contexts each description field allows isn't documented (it's in the
// runner's action_yaml.json) and differs by field, so rather than tell the
// expressions that would load from the ones that wouldn't, this bans `${{` in
// every description. A description is documentation, shown as raw text, so it
// never needs a live expression: name one some other way, e.g. by the text
// inside its braces. (`${{` is fine in `outputs.*.value` and in `runs:`.)
//
// The runner loads the published action.yml, not the source: publishing
// rewrites the first `./actions/<name>/` in the file to
// `${{ github.action_path }}/` (see processActionYml), wherever it is. So each
// action is checked both as written and as published.

type Described = {description?: unknown};

type ActionYml = {
    description?: unknown;
    inputs?: Record<string, Described>;
    outputs?: Record<string, Described>;
};

const actionsDir = path.join(__dirname, "..", "actions");

const actionNames = realFs
    .readdirSync(actionsDir)
    .filter((name) =>
        realFs.existsSync(path.join(actionsDir, name, "action.yml")),
    )
    .sort();

/** Each description in an action.yml, keyed by where it is. */
function descriptions(action: ActionYml): Array<[string, unknown]> {
    return [
        ["description", action.description],
        ...Object.entries(action.inputs ?? {}).map(
            ([name, input]): [string, unknown] => [
                `inputs.${name}.description`,
                input.description,
            ],
        ),
        ...Object.entries(action.outputs ?? {}).map(
            ([name, output]): [string, unknown] => [
                `outputs.${name}.description`,
                output.description,
            ],
        ),
    ];
}

/**
 * An action.yml as publishing rewrites it. With no package metadata, every
 * `uses: ./actions/...` dependency is left alone (those rewrites only add a
 * SHA and a comment), so this applies just the require-path rewrite.
 */
function asPublished(name: string, actionYml: string): string {
    return processActionYml(name, {}, actionYml, "Khan/actions");
}

/** The descriptions in `actionYml` that contain `${{`, keyed by where. */
function descriptionsWithExpressions(actionYml: string): string[] {
    return descriptions(parse(actionYml))
        .filter(([, description]) => String(description ?? "").includes("${{"))
        .map(([where]) => where);
}

describe("action.yml descriptions", () => {
    // processActionYml logs each rewrite.
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("finds the repo's actions", () => {
        expect(actionNames).toContain("fix-workflows");
    });

    // Without this, the check below would pass if descriptions() stopped
    // finding any descriptions.
    it("finds every description it should check", () => {
        const action: ActionYml = {
            description: "a ${{ vars.X }}",
            inputs: {i: {description: "b ${{ vars.X }}"}},
            outputs: {o: {description: "c ${{ vars.X }}"}},
        };
        expect(descriptions(action)).toEqual([
            ["description", "a ${{ vars.X }}"],
            ["inputs.i.description", "b ${{ vars.X }}"],
            ["outputs.o.description", "c ${{ vars.X }}"],
        ]);
    });

    it("catches a `${{` that only publishing adds", () => {
        const actionYml = [
            "name: Example",
            "description: Loads ./actions/example/index.js.",
            "runs:",
            '    using: "composite"',
            "    steps: []",
            "",
        ].join("\n");
        expect(descriptionsWithExpressions(actionYml)).toEqual([]);
        expect(
            descriptionsWithExpressions(asPublished("example", actionYml)),
        ).toEqual(["description"]);
    });

    it.each(actionNames)(
        "%s has no `${{` in any description, as written or as published",
        (name) => {
            const actionYml = realFs.readFileSync(
                path.join(actionsDir, name, "action.yml"),
                "utf-8",
            );
            expect(
                descriptionsWithExpressions(actionYml),
                "as written",
            ).toEqual([]);
            expect(
                descriptionsWithExpressions(asPublished(name, actionYml)),
                "as published",
            ).toEqual([]);
        },
    );
});
