import {execFileSync} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {isMap, LineCounter, parse, parseDocument} from "yaml";

import {
    checkJob,
    checkRunsOn,
    DEFAULT_ALLOWED_RUNS_ON,
    DEFAULT_CONFIG_FILE,
    DEFAULT_SETUP_ACTION,
    findRunsOnViolations,
    parseCliArgs,
    parseConfig,
    processJob,
    runsOnViolationMessage,
} from "./index.ts";

/**
 * The `runs-on` allowlist, split from index.test.ts to keep that file inside its
 * 1000-line cap.
 */

const TOGGLE =
    "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}";

const ALLOWED = new Set(["ubuntu-latest", TOGGLE]);

/** Parse a YAML string and return the document and first job's map node. */
function parseJob(yaml: string) {
    const doc = parseDocument(yaml);
    const job = (doc.get("jobs") as any).items[0].value;
    if (!isMap(job)) {
        throw new Error("Expected a job map");
    }
    return {doc, job};
}

describe("parseConfig", () => {
    it("reads allowed-runs-on entries written like the runs-on they match", () => {
        expect(
            parseConfig(
                `# Runners this repo may use.
allowed-runs-on:
    - ubuntu-latest
    - ${TOGGLE}
    - "${TOGGLE}"
`,
                "config.yml",
            ),
        ).toEqual({allowedRunsOn: ["ubuntu-latest", TOGGLE, TOGGLE]});
    });

    it.each([
        ["an empty file", ""],
        ["a comments-only file", "# nothing yet\n"],
        ["no allowed-runs-on value", "allowed-runs-on:\n"],
        ["an empty list", "allowed-runs-on: []\n"],
    ])("returns no values for %s", (_name, text) => {
        expect(parseConfig(text, "config.yml")).toEqual({allowedRunsOn: []});
    });

    it.each([
        ["invalid YAML", "allowed-runs-on: [ubuntu-latest", "not valid YAML"],
        ["a top-level list", "- ubuntu-latest\n", "must be a YAML mapping"],
        [
            "a misspelled key",
            "allowed-run-on:\n    - ubuntu-latest\n",
            "unknown key(s) allowed-run-on",
        ],
        ["a bare value", "allowed-runs-on: ubuntu-latest\n", "must be a list"],
        [
            "a non-string entry",
            "allowed-runs-on:\n    - ubuntu-latest\n    - 22.04\n",
            "22.04 is not one",
        ],
        [
            "an empty entry",
            "allowed-runs-on:\n    - ubuntu-latest\n    -\n",
            "null is not one",
        ],
    ])("rejects %s, naming the file", (_name, text, message) => {
        expect(() => parseConfig(text, "config.yml")).toThrow(message);
        expect(() => parseConfig(text, "config.yml")).toThrow("config.yml");
    });
});

describe("parseCliArgs", () => {
    it("defaults to the action's defaults", () => {
        expect(parseCliArgs([])).toEqual({
            checkRunsOn: false,
            configFile: "",
            setupAction: DEFAULT_SETUP_ACTION,
        });
    });

    it.each([["--check-runs-on"], ["--fix-runs-on"]])(
        "turns the check on with %s",
        (flag) => {
            expect(parseCliArgs([flag]).checkRunsOn).toBe(true);
        },
    );

    it("reads --config-file and --setup-action", () => {
        expect(
            parseCliArgs([
                "--config-file",
                "ci/fix-workflows.yml",
                "--setup-action",
                "./.github/actions/setup",
            ]),
        ).toEqual({
            checkRunsOn: false,
            configFile: "ci/fix-workflows.yml",
            setupAction: "./.github/actions/setup",
        });
    });
});

describe("checkRunsOn", () => {
    it.each([
        ["an allowed plain runner", "ubuntu-latest", false],
        ["an allowed expression, unquoted", TOGGLE, false],
        ["an allowed expression, double-quoted", `"${TOGGLE}"`, false],
        [
            "an allowed expression, single-quoted",
            `'${TOGGLE.replace(/'/g, "''")}'`,
            false,
        ],
        ["a runner not on the list", "ubuntu-latest-l", true],
        ["a pinned ubuntu version not on the list", "ubuntu-24.04", true],
        [
            "an allowed expression with different spacing",
            TOGGLE.replace("== 'true'", "=='true'"),
            true,
        ],
        ["a macos- runner, which is exempt", "macos-latest", false],
    ])("%s => %s", (_name, runsOn, expected) => {
        const {job} = parseJob(`
jobs:
  build:
    runs-on: ${runsOn}
    steps: []
`);
        expect(checkRunsOn(job, ALLOWED)).toBe(expected);
    });

    it("does not check a runs-on that opts out with an ignore directive", () => {
        const {job} = parseJob(`
jobs:
  build:
    runs-on: ubuntu-latest-m # fix-workflows-ignore: runs-on
    steps: []
`);
        expect(checkRunsOn(job, ALLOWED)).toBe(false);
    });

    it("does not check a label array", () => {
        const {job} = parseJob(`
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps: []
`);
        expect(checkRunsOn(job, ALLOWED)).toBe(false);
    });
});

// INFRA-11270 requires that a job can pick its runner by who triggered the
// run, and that listing the expression as written allows it.
describe("a per-user runs-on expression", () => {
    const PER_USER =
        "${{ contains(fromJSON(vars.ARC_PREVIEW_USERS || '[]'), github.triggering_actor) && 'arc-foo' || 'ubuntu-latest' }}";
    const {job} = parseJob(`
jobs:
  build:
    runs-on: ${PER_USER}
    steps: []
`);

    it("parses from the workflow unchanged", () => {
        expect(job.get("runs-on")).toBe(PER_USER);
    });

    it("passes when the config lists it as written", () => {
        const {allowedRunsOn} = parseConfig(
            `allowed-runs-on:\n    - ubuntu-latest\n    - ${PER_USER}\n`,
            "config.yml",
        );
        expect(allowedRunsOn).toEqual(["ubuntu-latest", PER_USER]);
        expect(checkRunsOn(job, new Set(allowedRunsOn))).toBe(false);
    });

    it("fails when the config doesn't list it", () => {
        expect(checkRunsOn(job, ALLOWED)).toBe(true);
    });
});

describe("processJob and checkJob", () => {
    // The runs-on autofix is gone: a value not on the list is reported by
    // findRunsOnViolations, never rewritten.
    it("leave a runs-on that is not on the list untouched", () => {
        const {doc, job} = parseJob(`
jobs:
  build:
    runs-on: ubuntu-latest-l
    steps: []
`);
        expect(processJob(doc, job)).toBe(false);
        expect(job.get("runs-on")).toBe("ubuntu-latest-l");
        expect(checkJob(job)).toBe(false);
    });
});

describe("findRunsOnViolations", () => {
    it("reports each job whose runs-on is not on the list, with its line", () => {
        const lineCounter = new LineCounter();
        const doc = parseDocument(
            `name: CI
jobs:
  ok:
    runs-on: ubuntu-latest
    steps: []
  big:
    runs-on: ubuntu-latest-l
    steps: []
  ignored:
    runs-on: ubuntu-24.04 # fix-workflows-ignore
    steps: []
  mac:
    runs-on: macos-15
    steps: []
  pinned:
    runs-on: "ubuntu-24.04"
    steps: []
`,
            {lineCounter},
        );
        expect(findRunsOnViolations(doc, ALLOWED, lineCounter)).toEqual([
            {jobId: "big", runsOn: "ubuntu-latest-l", line: 7},
            {jobId: "pinned", runsOn: "ubuntu-24.04", line: 16},
        ]);
    });
});

describe("runsOnViolationMessage", () => {
    it("names the value, the config key, and every allowed value", () => {
        const message = runsOnViolationMessage(
            {jobId: "big", runsOn: "ubuntu-latest-l"},
            ALLOWED,
        );
        expect(message).toContain("'ubuntu-latest-l'");
        expect(message).toContain("allowed-runs-on");
        expect(message).toContain("\n  ubuntu-latest\n");
        expect(message).toContain(`\n  ${TOGGLE}\n`);
    });
});

describe("fixWorkflows", () => {
    let workspace: string | undefined;

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
        if (workspace) {
            fs.rmSync(workspace, {recursive: true, force: true});
            workspace = undefined;
        }
    });

    /**
     * Run the action's entrypoint against a scratch repo holding `files`.
     * index.ts reads the repo root from GITHUB_WORKSPACE when it loads, so it
     * is imported fresh.
     */
    async function run(
        files: Record<string, string>,
        options: {checkRunsOn?: boolean; configFile?: string} = {},
    ) {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fix-workflows-"));
        fs.mkdirSync(path.join(workspace, ".github", "workflows"), {
            recursive: true,
        });
        for (const [name, content] of Object.entries(files)) {
            const abs = path.join(workspace, name);
            fs.mkdirSync(path.dirname(abs), {recursive: true});
            fs.writeFileSync(abs, content);
        }
        vi.stubEnv("GITHUB_WORKSPACE", workspace);
        vi.resetModules();
        const {default: fixWorkflows} = await import("./index.ts");
        const core = {
            info: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
            setFailed: vi.fn(),
        };
        await fixWorkflows({core, ...options});
        return core;
    }

    const CI = ".github/workflows/ci.yml";

    const workflow = (runsOn: string) => `name: CI
on: push
jobs:
  build:
    runs-on: ${runsOn}
    steps: []
`;

    const config = (...values: string[]) =>
        `allowed-runs-on:\n${values.map((v) => `    - ${v}\n`).join("")}`;

    it("passes when every runs-on is in the config", async () => {
        const core = await run(
            {
                [CI]: workflow("ubuntu-latest-l"),
                [DEFAULT_CONFIG_FILE]: config(
                    "ubuntu-latest",
                    "ubuntu-latest-l",
                ),
            },
            {checkRunsOn: true},
        );
        expect(core.error).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("annotates the line, fails, and leaves the file as it was", async () => {
        const core = await run(
            {
                [CI]: workflow("ubuntu-latest-l"),
                [DEFAULT_CONFIG_FILE]: config("ubuntu-latest"),
            },
            {checkRunsOn: true},
        );
        expect(core.error).toHaveBeenCalledTimes(1);
        expect(core.error.mock.calls[0]![1]).toEqual({file: CI, startLine: 5});
        expect(core.setFailed).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(path.join(workspace!, CI), "utf8")).toBe(
            workflow("ubuntu-latest-l"),
        );
    });

    // The setup autofix inserts steps above the second job's runs-on, but
    // GitHub shows the annotation against the committed file.
    it("annotates the runs-on line as committed, not as autofixed", async () => {
        const committed = `name: CI
on: push
jobs:
  first:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  second:
    runs-on: ubuntu-latest-l
    steps: []
`;
        const core = await run(
            {[CI]: committed, [DEFAULT_CONFIG_FILE]: config("ubuntu-latest")},
            {checkRunsOn: true},
        );
        expect(fs.readFileSync(path.join(workspace!, CI), "utf8")).not.toBe(
            committed,
        );
        expect(core.error.mock.calls[0]![1]).toEqual({file: CI, startLine: 9});
    });

    it("reads the config from configFile when given", async () => {
        const core = await run(
            {
                [CI]: workflow("ubuntu-latest-l"),
                "ci/fix-workflows.yml": config("ubuntu-latest-l"),
            },
            {checkRunsOn: true, configFile: "ci/fix-workflows.yml"},
        );
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("throws, naming the path, when a configFile given is missing", async () => {
        await expect(
            run(
                {[CI]: workflow("ubuntu-latest")},
                {checkRunsOn: true, configFile: "ci/fix-workflows.yml"},
            ),
        ).rejects.toThrow("ci/fix-workflows.yml");
    });

    // Without a list, v4 enforces what the pre-v4 regex did for the common
    // case: the ephemeral-runner toggle.
    it("allows the ephemeral-runner toggle when there's no config", async () => {
        expect(DEFAULT_ALLOWED_RUNS_ON).toEqual([TOGGLE]);
        const core = await run({[CI]: workflow(TOGGLE)}, {checkRunsOn: true});
        expect(core.error).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("rejects anything else when there's no config", async () => {
        const core = await run(
            {[CI]: workflow("ubuntu-latest")},
            {checkRunsOn: true},
        );
        expect(core.error).toHaveBeenCalledTimes(1);
        expect(core.setFailed).toHaveBeenCalledTimes(1);
    });

    // Off by default, as `fix-runs-on` was before v4.
    it("skips the runs-on check unless checkRunsOn is set", async () => {
        const core = await run({[CI]: workflow("ubuntu-latest-l")});
        expect(core.error).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(core.warning).not.toHaveBeenCalled();
    });

    it("warns when the config lists runners but the check is off", async () => {
        const core = await run({
            [CI]: workflow("ubuntu-latest-l"),
            [DEFAULT_CONFIG_FILE]: config("ubuntu-latest"),
        });
        expect(core.warning).toHaveBeenCalledWith(
            expect.stringContaining("check-runs-on is off"),
        );
        expect(core.setFailed).not.toHaveBeenCalled();
    });
});

describe("action.yml", () => {
    const actionYml = fs.readFileSync(
        new URL("./action.yml", import.meta.url),
        "utf-8",
    );
    const action = parse(actionYml);
    const step = (name: string) =>
        action.runs.steps.find((s: {name: string}) => s.name === name);

    it("documents DEFAULT_CONFIG_FILE and DEFAULT_ALLOWED_RUNS_ON", () => {
        const {description} = action.inputs["config-file"];
        expect(description).toContain(DEFAULT_CONFIG_FILE);
        for (const value of DEFAULT_ALLOWED_RUNS_ON) {
            expect(description).toContain(value);
        }
    });

    it("leaves the runs-on check off by default, as fix-runs-on was", () => {
        expect(action.inputs["check-runs-on"].default).toBe("false");
    });

    // A pre-v4 caller's `fix-runs-on: true` keeps the check on, with a
    // deprecation warning, rather than silently turning it off.
    it("keeps fix-runs-on as a deprecated alias for check-runs-on", () => {
        const input = action.inputs["fix-runs-on"];
        expect(input.default).toBe("false");
        expect(input.deprecationMessage).toContain("check-runs-on");
        expect(step("Fix workflow violations").with.script).toContain(
            "checkRunsOn: ${{ inputs.check-runs-on == 'true' || inputs.fix-runs-on == 'true' }},",
        );
    });

    // A quote or `${` in a string input would run as JS if spliced into the
    // github-script source.
    it("passes string inputs to the fixer through the environment", () => {
        const fix = step("Fix workflow violations");
        expect(fix.env).toEqual({
            CONFIG_FILE: "${{ inputs.config-file }}",
            SETUP_ACTION: "${{ inputs.setup-action }}",
        });
        expect(fix.with.script).not.toContain("${{ inputs.config-file");
        expect(fix.with.script).not.toContain("${{ inputs.setup-action");
    });

    // A runs-on violation fails the fixer step, but its setup-step fixes still
    // need formatting and the hint.
    it("runs the formatter and the hint after a failed fixer step", () => {
        for (const name of [
            "Format YAML files with oxfmt",
            "Show fix instructions",
        ]) {
            expect(step(name).if).toBe("${{ !cancelled() }}");
        }
    });

    // Run the hint step's flag-building lines in bash, then parse the flags the
    // way the CLI does, so the hint and the CLI can't drift apart.
    it.each([
        [{CHECK_RUNS_ON: "false", CONFIG_FILE: "", SETUP_ACTION: "Khan/a@v1"}],
        [
            {
                CHECK_RUNS_ON: "true",
                CONFIG_FILE: "ci/it's config.yml",
                SETUP_ACTION: "./.github/actions/setup",
            },
        ],
    ])("prints hint flags the CLI parses back: %o", (env) => {
        const script: string = step("Show fix instructions").run;
        const build = script.slice(
            script.indexOf('ARGS=""'),
            script.indexOf("CMD="),
        );
        const out = execFileSync(
            "bash",
            ["-c", `${build}\neval "set -- $ARGS"; printf '%s\\0' "$@"`],
            {env: {...process.env, ...env}, encoding: "utf8"},
        );
        expect(parseCliArgs(out.split("\0").slice(0, -1))).toEqual({
            checkRunsOn: env.CHECK_RUNS_ON === "true",
            configFile: env.CONFIG_FILE,
            setupAction: env.SETUP_ACTION,
        });
    });
});
