import {describe, expect, it} from "vitest";
import * as realFs from "node:fs";
import path from "node:path";
import {parse} from "yaml";

// The runner parses `${{` in an action's descriptions as an expression when it
// loads the action, and most contexts (`vars`, `secrets`, `inputs`, ...) aren't
// available there, so one stray `${{` fails every job that uses the action at
// "Set up job", before any step runs. fix-workflows v4.0.0 shipped that way. A
// description has to name an expression some other way, e.g. by the text
// inside its braces. (`${{` is fine in `outputs.*.value` and in `runs:`.)

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

describe("action.yml descriptions", () => {
    it("finds the repo's actions", () => {
        expect(actionNames).toContain("fix-workflows");
    });

    it.each(actionNames)("%s has no `${{` in any description", (name) => {
        const action: ActionYml = parse(
            realFs.readFileSync(
                path.join(actionsDir, name, "action.yml"),
                "utf-8",
            ),
        );
        for (const [where, description] of descriptions(action)) {
            expect(String(description ?? ""), `${name} ${where}`).not.toContain(
                "${{",
            );
        }
    });
});
