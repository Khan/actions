import {execFileSync} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {isMap, parse, parseDocument} from "yaml";

import {
    checkJob,
    checkRunsOn,
    DEFAULT_ALLOWED_RUNS_ON,
    DEFAULT_CONFIG_FILE,
    DEFAULT_SETUP_ACTION,
    fixRunsOn,
    type Options,
    parseCliArgs,
    parseConfig,
    processJob,
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
            fixRunsOn: false,
            configFile: "",
            setupAction: DEFAULT_SETUP_ACTION,
        });
    });

    it("reads --fix-runs-on", () => {
        expect(parseCliArgs(["--fix-runs-on"]).fixRunsOn).toBe(true);
    });

    it.each([
        [["--config-file"], "argument missing"],
        // Not taken as --config-file's value, which would turn the fix off.
        [["--config-file", "--fix-runs-on"], "argument is ambiguous"],
        [["--setup-action"], "argument missing"],
    ])("throws when a flag is missing its value: %o", (args, message) => {
        expect(() => parseCliArgs(args)).toThrow(message);
    });

    // As with the config's unknown keys, a typo mustn't quietly leave the
    // fix off.
    it.each([
        ["--fix-runs-on=true", "does not take an argument"],
        ["--fix-run-on", "Unknown option '--fix-run-on'"],
        ["extra", "Unexpected argument 'extra'"],
    ])("throws on a bad argument: %s", (arg, message) => {
        expect(() => parseCliArgs([arg])).toThrow(message);
    });

    it("accepts a value given with =", () => {
        expect(parseCliArgs(["--config-file=ci/fix-workflows.yml"])).toEqual({
            fixRunsOn: false,
            configFile: "ci/fix-workflows.yml",
            setupAction: DEFAULT_SETUP_ACTION,
        });
    });

    it("reads --config-file and --setup-action", () => {
        expect(
            parseCliArgs([
                "--config-file",
                "ci/fix-workflows.yml",
                "--setup-action",
                "./.github/actions/setup",
            ]),
        ).toEqual({
            fixRunsOn: false,
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

describe("fixRunsOn", () => {
    it("replaces a runs-on that isn't allowed", () => {
        const {job} = parseJob(`
jobs:
  build:
    runs-on: ubuntu-latest-l
    steps: []
`);
        expect(fixRunsOn(job, ALLOWED, "ubuntu-latest")).toBe(true);
        expect(job.get("runs-on")).toBe("ubuntu-latest");
    });

    it.each([
        ["an allowed value", "ubuntu-latest"],
        ["an ignored value", "ubuntu-latest-l # fix-workflows-ignore: runs-on"],
        ["a macos- runner", "macos-latest"],
        ["a label array", "[self-hosted, linux]"],
    ])("leaves %s alone", (_name, runsOn) => {
        const {job} = parseJob(`
jobs:
  build:
    runs-on: ${runsOn}
    steps: []
`);
        const before = job.toJSON()["runs-on"];
        expect(fixRunsOn(job, ALLOWED, "ubuntu-latest")).toBe(false);
        expect(job.toJSON()["runs-on"]).toEqual(before);
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
    // Without a runsOnPolicy (fix-runs-on off), runs-on is left alone.
    it("leave a runs-on untouched without a runsOnPolicy", () => {
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

    it("rejects the runsOnPolicy option on checkJob, which would ignore it", () => {
        const {job} = parseJob(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []
`);
        const policy = {allowed: ALLOWED, replacement: "ubuntu-latest"};
        // @ts-expect-error checkJob only verifies setup steps.
        expect(checkJob(job, {runsOnPolicy: policy})).toBe(false);
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
    async function run(files: Record<string, string>, options: Options = {}) {
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

    const runsOnOf = (job = "build") =>
        (parse(fs.readFileSync(path.join(workspace!, CI), "utf8")) as any).jobs[
            job
        ]["runs-on"];

    it("replaces a disallowed runs-on with the config's first entry", async () => {
        const core = await run(
            {
                [CI]: workflow("ubuntu-latest-l"),
                [DEFAULT_CONFIG_FILE]: config("ubuntu-latest", TOGGLE),
            },
            {fixRunsOn: true},
        );
        expect(runsOnOf()).toBe("ubuntu-latest");
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(core.info).toHaveBeenCalledWith("Fixed 1 file(s).");
        // The config lists runners, so nothing says it fell back to the
        // default, even though this run rewrote a runs-on.
        expect(core.warning).not.toHaveBeenCalled();
        expect(core.info).not.toHaveBeenCalledWith(
            expect.stringContaining("allowing only the default"),
        );
    });

    it("leaves the file untouched when every runs-on is in the config", async () => {
        const core = await run(
            {
                [CI]: workflow("ubuntu-latest-l"),
                [DEFAULT_CONFIG_FILE]: config(
                    "ubuntu-latest",
                    "ubuntu-latest-l",
                ),
            },
            {fixRunsOn: true},
        );
        expect(fs.readFileSync(path.join(workspace!, CI), "utf8")).toBe(
            workflow("ubuntu-latest-l"),
        );
        expect(core.info).toHaveBeenCalledWith("No violations found.");
    });

    // One run brings a whole file into line: both rules, every job.
    it("fixes runs-on and setup steps across jobs in one run", async () => {
        await run(
            {
                [CI]: `name: CI
on: push
jobs:
  first:
    runs-on: ubuntu-latest-l
    steps:
      - uses: actions/checkout@v4
  second:
    runs-on: ubuntu-26.04
    steps: []
`,
                [DEFAULT_CONFIG_FILE]: config("ubuntu-latest"),
            },
            {fixRunsOn: true},
        );
        expect(runsOnOf("first")).toBe("ubuntu-latest");
        expect(runsOnOf("second")).toBe("ubuntu-latest");
        const steps = (
            parse(fs.readFileSync(path.join(workspace!, CI), "utf8")) as any
        ).jobs.first.steps;
        expect(steps[1].uses).toBe(DEFAULT_SETUP_ACTION);
    });

    // Without a list, v4 enforces the `ubuntu-latest` form of the
    // ephemeral-runner toggle, and writes it.
    it("writes the default toggle when there's no config", async () => {
        expect(DEFAULT_ALLOWED_RUNS_ON).toEqual([TOGGLE]);
        await run({[CI]: workflow("ubuntu-latest-l")}, {fixRunsOn: true});
        expect(runsOnOf()).toBe(TOGGLE);
    });

    it("leaves the default toggle alone when there's no config", async () => {
        await run({[CI]: workflow(TOGGLE)}, {fixRunsOn: true});
        expect(fs.readFileSync(path.join(workspace!, CI), "utf8")).toBe(
            workflow(TOGGLE),
        );
    });

    it("reads the config from configFile when given", async () => {
        await run(
            {
                [CI]: workflow("ubuntu-latest-m"),
                "ci/fix-workflows.yml": config("ubuntu-latest-l"),
            },
            {fixRunsOn: true, configFile: "ci/fix-workflows.yml"},
        );
        expect(runsOnOf()).toBe("ubuntu-latest-l");
    });

    it("throws, naming the path, when a configFile given is missing", async () => {
        await expect(
            run(
                {[CI]: workflow("ubuntu-latest")},
                {fixRunsOn: true, configFile: "ci/fix-workflows.yml"},
            ),
        ).rejects.toThrow("ci/fix-workflows.yml");
    });

    it("fails before touching any file when the config is broken", async () => {
        const committed = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest-l
    steps:
      - uses: actions/checkout@v4
`;
        await expect(
            run(
                {
                    [CI]: committed,
                    [DEFAULT_CONFIG_FILE]:
                        "allowed-run-on:\n    - ubuntu-latest\n",
                },
                {fixRunsOn: true},
            ),
        ).rejects.toThrow("unknown key(s) allowed-run-on");
        // Both fixes would otherwise have changed this file.
        expect(fs.readFileSync(path.join(workspace!, CI), "utf8")).toBe(
            committed,
        );
    });

    // The default list rewrites every runs-on but the toggle, so that has to
    // stand out; a run that changed nothing only notes it.
    it("warns, with a count, when the default list rewrote runs-on", async () => {
        const core = await run(
            {[CI]: workflow("ubuntu-latest-l")},
            {fixRunsOn: true},
        );
        expect(core.warning).toHaveBeenCalledWith(
            expect.stringContaining("Rewrote 1 runs-on value(s)"),
        );
        expect(core.warning.mock.calls[0]![0]).toContain(
            "No .github/fix-workflows.yml",
        );
        expect(core.info).not.toHaveBeenCalledWith(
            expect.stringContaining("allowing only the default"),
        );
    });

    it.each([
        ["there's no config", {}, "No .github/fix-workflows.yml"],
        [
            "the config lists none",
            {[DEFAULT_CONFIG_FILE]: "allowed-runs-on: []\n"},
            "lists no allowed-runs-on",
        ],
    ])(
        "says it's using the default list when %s",
        async (_name, files, message) => {
            const core = await run(
                {[CI]: workflow(TOGGLE), ...files},
                {fixRunsOn: true},
            );
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining(message),
            );
            expect(core.warning).not.toHaveBeenCalled();
            expect(core.setFailed).not.toHaveBeenCalled();
        },
    );

    // Off by default, as before v4.
    it("leaves runs-on alone unless fixRunsOn is set", async () => {
        const core = await run({[CI]: workflow("ubuntu-latest-l")});
        expect(runsOnOf()).toBe("ubuntu-latest-l");
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(core.warning).not.toHaveBeenCalled();
    });

    it("warns when a config exists but the fix is off", async () => {
        const core = await run({
            [CI]: workflow("ubuntu-latest-l"),
            [DEFAULT_CONFIG_FILE]: config("ubuntu-latest"),
        });
        expect(core.warning).toHaveBeenCalledWith(
            expect.stringContaining("fix-runs-on is off"),
        );
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    // The config only matters to fix-runs-on, so a mistake in it can't fail
    // a run that has the fix off.
    it("doesn't validate the config when the fix is off", async () => {
        const core = await run({
            [CI]: workflow("ubuntu-latest-l"),
            [DEFAULT_CONFIG_FILE]: "allowed-run-on:\n    - ubuntu-latest\n",
        });
        expect(core.warning).toHaveBeenCalledTimes(1);
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("doesn't require a configFile given when the fix is off", async () => {
        const core = await run(
            {[CI]: workflow("ubuntu-latest-l")},
            {configFile: "ci/fix-workflows.yml"},
        );
        expect(core.warning).not.toHaveBeenCalled();
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

    // The runner parses `${{` in an action's descriptions as an expression
    // when it loads the action, and `vars` (like most contexts) isn't
    // available there, so v4.0.0 failed every job at "Set up job". So the
    // description names each default by the expression inside its braces.
    it("documents DEFAULT_CONFIG_FILE and DEFAULT_ALLOWED_RUNS_ON", () => {
        const {description} = action.inputs["config-file"];
        expect(description).toContain(DEFAULT_CONFIG_FILE);
        for (const value of DEFAULT_ALLOWED_RUNS_ON) {
            const inner = value
                .replace(/^\$\{\{\s*/, "")
                .replace(/\s*\}\}$/, "");
            expect(inner).not.toBe(value);
            expect(description).toContain(inner);
        }
    });

    it("has no `${{` in any description, which would fail to load", () => {
        const descriptions = [
            action.description,
            ...Object.values(action.inputs).map((i: any) => i.description),
        ];
        for (const description of descriptions) {
            expect(description).not.toContain("${{");
        }
    });

    it("leaves fix-runs-on off by default, as before v4", () => {
        expect(action.inputs["fix-runs-on"].default).toBe("false");
    });

    // The hint's local command has to fix runs-on whenever the action did.
    it("passes fix-runs-on to the fixer and the hint", () => {
        const expr = "${{ inputs.fix-runs-on == 'true' }}";
        expect(step("Fix workflow violations").with.script).toContain(
            `fixRunsOn: ${expr},`,
        );
        expect(step("Show fix instructions").env).toEqual({
            FIX_RUNS_ON: expr,
            CONFIG_FILE: "${{ inputs.config-file }}",
            SETUP_ACTION: "${{ inputs.setup-action }}",
        });
    });

    // Awaiting is what routes the fixer's async errors (a broken config, say)
    // into the catch and so into setFailed.
    it("awaits the fixer", () => {
        expect(step("Fix workflow violations").with.script).toContain(
            "await require('./actions/fix-workflows/index.js').default(",
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
        expect(fix.with.script).toContain(
            "configFile: process.env.CONFIG_FILE,",
        );
        expect(fix.with.script).toContain(
            "setupAction: process.env.SETUP_ACTION,",
        );
    });

    // Run the hint step's command-building lines in bash, then parse the
    // command the way a shell and the CLI would, so the hint and the CLI can't
    // drift apart.
    it.each([
        [{FIX_RUNS_ON: "false", CONFIG_FILE: "", SETUP_ACTION: "Khan/a@v1"}],
        [
            {
                FIX_RUNS_ON: "true",
                CONFIG_FILE: "ci/it's config.yml",
                SETUP_ACTION: "./.github/actions/setup",
            },
        ],
    ])("prints a hint command the CLI parses back: %o", (env) => {
        const script: string = step("Show fix instructions").run;
        const build = script.slice(
            script.indexOf('ARGS=""'),
            script.indexOf("HINT="),
        );
        const out = execFileSync(
            "bash",
            ["-c", `${build}\neval "set -- $CMD"; printf '%s\\0' "$@"`],
            {
                env: {...process.env, ...env, TAG: "fix-workflows-v4"},
                encoding: "utf8",
            },
        );
        const [pnpm, dlx, pkg, ...args] = out.split("\0").slice(0, -1);
        expect([pnpm, dlx, pkg]).toEqual([
            "pnpm",
            "dlx",
            "github:Khan/actions#fix-workflows-v4",
        ]);
        expect(parseCliArgs(args)).toEqual({
            fixRunsOn: env.FIX_RUNS_ON === "true",
            configFile: env.CONFIG_FILE,
            setupAction: env.SETUP_ACTION,
        });
    });
});
