import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {isMap, LineCounter, parse, parseDocument} from "yaml";

import {
    checkJob,
    checkRunsOn,
    cliArgs,
    DEFAULT_ALLOWED_RUNS_ON,
    findRunsOnViolations,
    parseAllowedRunsOn,
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

describe("parseAllowedRunsOn", () => {
    it("reads a YAML block list, with comments, like the runs-on it matches", () => {
        expect(
            parseAllowedRunsOn(`# Runners this repo may use.
- ubuntu-latest
- ${TOGGLE}
- "${TOGGLE}"
`),
        ).toEqual(["ubuntu-latest", TOGGLE, TOGGLE]);
    });

    it("reads a flow list", () => {
        expect(parseAllowedRunsOn("[ubuntu-latest, ubuntu-latest-l]")).toEqual([
            "ubuntu-latest",
            "ubuntu-latest-l",
        ]);
    });

    it.each([
        ["an unset input", undefined],
        ["an empty input", ""],
        ["only whitespace", "  \n"],
        ["only comments", "# nothing yet\n"],
        ["an empty list", "[]"],
    ])("returns [] for %s", (_name, text) => {
        expect(parseAllowedRunsOn(text)).toEqual([]);
    });

    it.each([
        ["a bare value", "ubuntu-latest"],
        ["a mapping", "runner: ubuntu-latest"],
        ["a non-string entry", "- ubuntu-latest\n- 22.04"],
        ["an empty entry", "- ubuntu-latest\n- ''"],
        ["invalid YAML", "- [ubuntu-latest"],
    ])("rejects %s", (_name, text) => {
        expect(() => parseAllowedRunsOn(text)).toThrow(
            "allowed-runs-on must be a YAML list",
        );
    });
});

describe("cliArgs", () => {
    it("repeats --allowed-runs-on per value, single-quoted for the shell", () => {
        expect(
            cliArgs({
                allowedRunsOn: ["ubuntu-latest", TOGGLE],
                setupAction: "./.github/actions/setup",
            }),
        ).toBe(
            "--allowed-runs-on 'ubuntu-latest' " +
                `--allowed-runs-on '${TOGGLE.replace(/'/g, "'\\''")}' ` +
                "--setup-action './.github/actions/setup'",
        );
    });

    it("leaves out --allowed-runs-on when the list is empty", () => {
        expect(cliArgs({})).toBe(
            "--setup-action 'Khan/actions@secure-network-v1'",
        );
    });

    it("adds --check-runs-on when the check is on", () => {
        expect(cliArgs({checkRunsOn: true})).toBe(
            "--check-runs-on --setup-action 'Khan/actions@secure-network-v1'",
        );
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
    it("names the value, the input, and every allowed value", () => {
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
     * Run the action's entrypoint against a scratch repo with one workflow.
     * index.ts reads the repo root from GITHUB_WORKSPACE when it loads, so it
     * is imported fresh.
     */
    async function run(
        runsOn: string,
        options: {checkRunsOn?: boolean; allowedRunsOn?: string[]} = {},
    ) {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fix-workflows-"));
        const workflows = path.join(workspace, ".github", "workflows");
        fs.mkdirSync(workflows, {recursive: true});
        fs.writeFileSync(path.join(workflows, "ci.yml"), workflow(runsOn));
        vi.stubEnv("GITHUB_WORKSPACE", workspace);
        vi.resetModules();
        const {default: fixWorkflows} = await import("./index.ts");
        const core = {
            info: vi.fn(),
            error: vi.fn(),
            setFailed: vi.fn(),
        };
        await fixWorkflows({core, ...options});
        return core;
    }

    const workflow = (runsOn: string) => `name: CI
on: push
jobs:
  build:
    runs-on: ${runsOn}
    steps: []
`;

    it("passes when every runs-on is on the list", async () => {
        const core = await run("ubuntu-latest-l", {
            checkRunsOn: true,
            allowedRunsOn: ["ubuntu-latest", "ubuntu-latest-l"],
        });
        expect(core.error).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("annotates the line, fails, and leaves the file as it was", async () => {
        const core = await run("ubuntu-latest-l", {
            checkRunsOn: true,
            allowedRunsOn: ["ubuntu-latest"],
        });
        expect(core.error).toHaveBeenCalledTimes(1);
        expect(core.error.mock.calls[0]![1]).toEqual({
            file: ".github/workflows/ci.yml",
            startLine: 5,
        });
        expect(core.setFailed).toHaveBeenCalledTimes(1);
        expect(
            fs.readFileSync(
                path.join(workspace!, ".github/workflows/ci.yml"),
                "utf8",
            ),
        ).toBe(workflow("ubuntu-latest-l"));
    });

    // Without a list, v4 enforces what the pre-v4 regex did for the common
    // case: the ephemeral-runner toggle.
    it("allows the ephemeral-runner toggle when no list is given", async () => {
        expect(DEFAULT_ALLOWED_RUNS_ON).toEqual([TOGGLE]);
        const core = await run(TOGGLE, {checkRunsOn: true});
        expect(core.error).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("rejects anything else when no list is given", async () => {
        const core = await run("ubuntu-latest", {checkRunsOn: true});
        expect(core.error).toHaveBeenCalledTimes(1);
        expect(core.setFailed).toHaveBeenCalledTimes(1);
    });

    // Off by default, as `fix-runs-on` was before v4.
    it("skips the runs-on check unless checkRunsOn is set", async () => {
        const core = await run("ubuntu-latest-l");
        expect(core.error).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });
});

describe("action.yml and cli.ts", () => {
    const actionYml = fs.readFileSync(
        new URL("./action.yml", import.meta.url),
        "utf-8",
    );
    const cliTs = fs.readFileSync(
        new URL("./cli.ts", import.meta.url),
        "utf-8",
    );

    it("document DEFAULT_ALLOWED_RUNS_ON as the default", () => {
        for (const value of DEFAULT_ALLOWED_RUNS_ON) {
            expect(actionYml).toContain(value);
        }
    });

    it("leave the runs-on check off by default, as fix-runs-on was", () => {
        expect(parse(actionYml).inputs["check-runs-on"].default).toBe("false");
        expect(cliTs).toContain('"--check-runs-on"');
    });

    // A pre-v4 caller's `fix-runs-on: true` keeps the check on, with a
    // deprecation warning, rather than silently turning it off.
    it("keep fix-runs-on as a deprecated alias for check-runs-on", () => {
        const input = parse(actionYml).inputs["fix-runs-on"];
        expect(input.default).toBe("false");
        expect(input.deprecationMessage).toContain("check-runs-on");
        expect(actionYml).toContain(
            "checkRunsOn: ${{ inputs.check-runs-on == 'true' || inputs.fix-runs-on == 'true' }},",
        );
        expect(cliTs).toContain('"--fix-runs-on"');
    });

    // The list holds `${{` and quotes, which would break (or inject into) the
    // github-script source if spliced into it like setup-action is.
    it("pass the list to the fixer through the environment", () => {
        expect(actionYml).toContain(
            "ALLOWED_RUNS_ON: ${{ inputs.allowed-runs-on }}",
        );
        expect(actionYml).toContain(
            "parseAllowedRunsOn(process.env.ALLOWED_RUNS_ON)",
        );
    });

    // cliArgs builds the hint's flags; the CLI must parse the same ones.
    it("print fix instructions with flags the CLI parses", () => {
        expect(actionYml).toContain("cliArgs(options)");
        expect(actionYml).toContain("${{ steps.fix.outputs.cli-args }}");
        expect(cliTs).toContain('"--allowed-runs-on"');
        expect(cliTs).toContain('"--setup-action"');
    });
});
