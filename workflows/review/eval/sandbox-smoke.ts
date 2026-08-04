/**
 * The sandbox smoke: does the PRODUCTION tool surface actually work inside the
 * srt sandbox?
 *
 * Why this is separate from the A/B arms. The measured arms now run the
 * production surface too (`live-runner.ts` grants `createReviewTools`
 * unrestricted), so the A/B owns quality-on-the-production-surface. This job
 * keeps a different franchise: it exercises the sandbox BOUNDARY itself
 * (deny-side probes, the cap journal's one allowed write, Bash reached
 * live), proves the sandbox rather than quality, and reports no metrics.
 * Bash matters most: it runs the investigation-cap CLI, the one thing in the
 * review that must WRITE inside a sandbox whose whole point is that writes
 * are denied.
 *
 * Two phases, deliberately split by determinism:
 *
 *   Phase A (free, no model): exercise the boundary through
 *   `createToolExec()` — the exact function the production runner calls — and
 *   assert each probe lands on the right side of the policy. The cap-journal
 *   probe runs the REAL cap CLI the way the prompts do (`cd <lib> && node
 *   workflows/review/lib/investigation-cap.ts request <id>`), so "the cap
 *   journal is writable" is proven by the code that writes it, not by a
 *   hand-rolled echo. This phase is the hard gate: it costs nothing and its
 *   verdict does not depend on a model's choices. It is also what caught the
 *   `npx -y tsx` invocation failing outright under a deny-all network policy.
 *
 *   Phase B (one case, real dollars): run one live corpus case on the
 *   production tool surface and assert the loop actually reached Bash. This is
 *   the end-to-end plumbing check — tool definitions, the sandbox wrapper, the
 *   prompt's own cap-CLI instruction, all in one live dispatch. Journal growth
 *   here is REPORTED, not asserted: whether a reviewer opens a budget request
 *   is the model's call, and a gate that depends on it would be flaky. Phase A
 *   already asserts the write.
 *
 * Both phases fail closed: any hard check that cannot be evaluated is a
 * failure, since "we could not tell" and "the sandbox is broken" have the same
 * cost on a consumer's PR.
 *
 * Usage:
 *
 *   pnpm dlx tsx workflows/review/eval/sandbox-smoke.ts            # both phases
 *   pnpm dlx tsx workflows/review/eval/sandbox-smoke.ts --probes-only
 *   pnpm dlx tsx workflows/review/eval/sandbox-smoke.ts --case incident-race-condition
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    appendFileSync,
} from "node:fs";
import {resolve} from "node:path";

import {
    CAP_JOURNAL_PATH,
    SCRATCH_DIR,
    createPiRunner,
    createToolExec,
    rejectStaleRunnerSelection,
    type ToolExec,
} from "../lib/dispatch-runner-pi";
import {extractAgents} from "./agent-extract";
import {loadLiveCorpus} from "./corpus/loader";
import {produceLive, type LiveAgentRunner} from "./live-producer";

/**
 * The default smoke case: a small real defect, so the reviewers have something
 * to investigate (an investigation is what reaches for Bash), and cheap.
 * Deliberately NOT incident-sql-missing-index: that case carries the
 * reproducibly lost finding under review, and a sandbox smoke must not double
 * as a quality signal.
 */
const DEFAULT_CASE = "incident-cache-missing-key";

/** Where the prompts expect this repo to be checked out (review.md Step 1). */
const LIB_DIR_NAME = "gh-aw-review-lib";

/**
 * The cap CLI exactly as the sub-agent prompts invoke it. Kept in one place so
 * this probe cannot drift from review.md and quietly prove the wrong command:
 * `node`, never `tsx` — see the entry guard in investigation-cap.ts for why
 * nothing else runs inside the sandbox.
 */
const CAP_CLI_COMMAND =
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON workflows/review/lib/investigation-cap.ts";

/** The prompt the eval measures (live-runner.ts's default), overridable. */
const DEFAULT_REVIEW_MD = "workflows/review/review.md";

/* -------------------------------------------------------------------------- */
/* Probe results (pure)                                                       */
/* -------------------------------------------------------------------------- */

/** One boundary probe: what it tried, and which side of the policy it hit. */
export type ProbeResult = {
    name: string;
    /** What the sandbox policy says should happen. */
    expected: "allowed" | "denied";
    /** What actually happened, as observed from OUTSIDE the sandbox. */
    satisfied: boolean;
    /** Evidence, for the log: command output, file state, journal delta. */
    detail: string;
};

export type SmokeVerdict = {
    ok: boolean;
    /** Names of the probes whose observed behavior contradicts the policy. */
    failed: string[];
};

/**
 * Signatures of the sandbox WRAPPER failing, as opposed to the policy denying
 * something. The distinction is the whole game for a `denied` probe: a wrapper
 * that never started denies everything, so "the write did not land" is
 * evidence of nothing. Run 30867350588 is the worked example — bwrap could not
 * bring up loopback in its netns, every command died before executing, and the
 * checkout-write probe scored "as expected" on the strength of a sandbox that
 * was not running.
 */
const WRAPPER_FAILURES = [
    "bwrap:",
    "Failed RTM_",
    "sandbox-exec:",
    "seatbelt",
    "Operation not permitted",
];

/** Whether a probe's output shows the wrapper itself failing to run. */
export const wrapperFailed = (output: string): boolean =>
    WRAPPER_FAILURES.some((signature) => output.includes(signature));

/**
 * The gate decision over a probe set. Pure, and unit-tested. Two rules that
 * are easy to get wrong and both fail closed: an empty probe set fails,
 * because "no probes ran" must never read as "the sandbox holds"; and a probe
 * whose evidence shows the WRAPPER failed fails whatever it expected, because
 * a denial by breakage is not a denial by policy.
 */
export const summarizeProbes = (results: ProbeResult[]): SmokeVerdict => {
    const failed = results
        .filter((probe) => !probe.satisfied || wrapperFailed(probe.detail))
        .map((probe) => probe.name);
    return {ok: results.length > 0 && failed.length === 0, failed};
};

/** The probe table, for the job log and the step summary. */
export const renderProbes = (results: ProbeResult[]): string =>
    [
        "| probe | policy | observed | evidence |",
        "| --- | --- | --- | --- |",
        ...results.map(
            (probe) =>
                `| ${probe.name} | ${probe.expected} | ${
                    wrapperFailed(probe.detail)
                        ? "**SANDBOX BROKEN**"
                        : probe.satisfied
                        ? "as expected"
                        : "**CONTRADICTED**"
                } | ${probe.detail.replaceAll("|", "\\|").slice(0, 160)} |`,
        ),
    ].join("\n");

/** Count non-empty journal lines; one line is one authorised call. */
const journalLines = (): number =>
    existsSync(CAP_JOURNAL_PATH)
        ? readFileSync(CAP_JOURNAL_PATH, "utf8")
              .split("\n")
              .filter((line) => line.trim() !== "").length
        : 0;

/* -------------------------------------------------------------------------- */
/* Phase A: the boundary probes                                               */
/* -------------------------------------------------------------------------- */

/**
 * Per-probe deadline. The runner's own 120s subprocess timeout kills the direct
 * child, but a sandboxed command is a process TREE (bwrap, then a proxy, then
 * the command), and a grandchild holding the pipes open leaves the executor's
 * promise unresolved with nothing left to kill it. A probe that has not
 * answered in this long is inconclusive, and inconclusive fails.
 */
const PROBE_DEADLINE_MS = 60_000;

/** Run one probe command under the deadline; a timeout reads as a broken wrapper. */
const probeExec = async (
    exec: ToolExec,
    argv: string[],
    cwd: string,
): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(
            () =>
                resolve(
                    `bwrap: probe did not answer in ${PROBE_DEADLINE_MS}ms`,
                ),
            PROBE_DEADLINE_MS,
        );
    });
    try {
        return await Promise.race([exec(argv, cwd), deadline]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Run the five probes that define the review sandbox's boundary. `probeDir`
 * stands in for production's checkout: it lives inside the workspace, not
 * under /tmp, because that is where production's read-only mount applies and a
 * /tmp stand-in could pass on a policy that does not cover the real thing.
 */
const runProbes = async (
    exec: ToolExec,
    probeDir: string,
): Promise<ProbeResult[]> => {
    const results: ProbeResult[] = [];

    // 1. The checkout is readable. If this fails, nothing else means anything:
    //    a sandbox that cannot read the code cannot review it.
    const readOut = await probeExec(
        exec,
        ["cat", "--", "sentinel.txt"],
        probeDir,
    );
    results.push({
        name: "read the checkout",
        expected: "allowed",
        satisfied: readOut.includes("sandbox-smoke-sentinel"),
        detail: readOut.trim().slice(0, 200),
    });

    // 2. The checkout is NOT writable. This is the promise Bash used to be
    //    able to break (`echo > file`), and the reason the mount exists.
    const poison = `${probeDir}/poison.txt`;
    const writeOut = await probeExec(
        exec,
        ["sh", "-c", "echo poisoned > poison.txt"],
        probeDir,
    );
    results.push({
        name: "write to the checkout",
        expected: "denied",
        satisfied: !existsSync(poison),
        detail: existsSync(poison)
            ? `poison.txt EXISTS: the checkout took a write`
            : `refused: ${writeOut.trim().slice(0, 160) || "(no output)"}`,
    });

    // 3. The cap journal is writable THROUGH THE REAL CLI, invoked exactly as
    //    the sub-agent prompts invoke it. Two things are under test at once
    //    and both are load-bearing: the one writable mount in the staging dir,
    //    and whether `npx -y tsx` can even start with the network denied (the
    //    runner's npx cache is warmed outside the sandbox, as production warms
    //    it in its pre-agent steps).
    const before = journalLines();
    const capOut = await probeExec(
        exec,
        [
            "sh",
            "-c",
            `cd ${LIB_DIR_NAME} && ${CAP_CLI_COMMAND} request sandbox-smoke-probe`,
        ],
        probeDir,
    );
    const after = journalLines();
    results.push({
        name: "append to the cap journal (real CLI)",
        expected: "allowed",
        satisfied: after === before + 1,
        detail: `journal ${before} -> ${after}; cli: ${
            capOut.trim().slice(0, 160) || "(no output)"
        }`,
    });

    // 4. The scratch dir is writable: the model's own workspace, which nothing
    //    downstream reads.
    const scratchProbe = `${SCRATCH_DIR}/sandbox-smoke-probe`;
    const scratchOut = await probeExec(
        exec,
        ["sh", "-c", `echo ok > ${scratchProbe}`],
        probeDir,
    );
    results.push({
        name: "write to the scratch dir",
        expected: "allowed",
        satisfied: existsSync(scratchProbe),
        detail: existsSync(scratchProbe)
            ? "scratch write landed"
            : `scratch write refused: ${scratchOut.trim().slice(0, 160)}`,
    });

    // 5. No network from a tool. Model traffic leaves from the runner process;
    //    a tool that can dial out is an exfiltration path for a prompt-injected
    //    reviewer, and in the eval the sandbox is the ONLY network boundary the
    //    tools have.
    const dial = [
        'const s = require("node:net").connect(443, "1.1.1.1");',
        "const done = (m) => { console.log(m); process.exit(0); };",
        's.setTimeout(4000, () => done("DENIED timeout"));',
        's.on("connect", () => done("CONNECTED"));',
        's.on("error", (e) => done("DENIED " + e.code));',
    ].join(" ");
    const netOut = await probeExec(exec, ["node", "-e", dial], probeDir);
    results.push({
        name: "open a TCP connection",
        expected: "denied",
        // Fail closed: only an explicit DENIED counts. A crashed probe (no
        // node, a syntax error) leaves the question unanswered, and an
        // unanswered egress question is a failure.
        satisfied: netOut.includes("DENIED"),
        detail: netOut.trim().slice(0, 160) || "(no output)",
    });

    return results;
};

/* -------------------------------------------------------------------------- */
/* Phase B: one live case on the production tool surface                      */
/* -------------------------------------------------------------------------- */

/**
 * The production surface runner: `createPiRunner()` with NO `allowedTools`,
 * which is what production does. Two smoke-only additions: it records every
 * tool name so the job can assert Bash was reached, and it links this repo in
 * as `gh-aw-review-lib` inside the case checkout, because that is where the
 * prompts' cap-CLI command looks for it (in production the lock file checks
 * the repo out under that name next to the PR checkout).
 */
const productionSurfaceRunner = (
    repoRoot: string,
    toolNames: string[],
): LiveAgentRunner => {
    rejectStaleRunnerSelection(process.env);
    let runner: ReturnType<typeof createPiRunner> | undefined;
    return async (request) => {
        const link = `${request.cwd}/${LIB_DIR_NAME}`;
        if (!existsSync(link)) {
            symlinkSync(repoRoot, link, "dir");
        }
        // Memoize the PROMISE, not the resolved runner: the roster fans out
        // concurrently, and one sandbox initialization is the point (see
        // live-runner.ts for the same reasoning).
        runner ??= createPiRunner({
            onToolCall: (toolName) => toolNames.push(toolName),
        });
        return (await runner)(request);
    };
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

const summaryLine = (text: string): void => {
    console.log(text);
    const path = process.env["GITHUB_STEP_SUMMARY"];
    if (path !== undefined && path !== "") {
        appendFileSync(path, `${text}\n`);
    }
};

const main = async (): Promise<void> => {
    const repoRoot = resolve(argValue("--repo-root") ?? process.cwd());
    const probesOnly = process.argv.includes("--probes-only");
    const caseId = argValue("--case") ?? DEFAULT_CASE;

    // The probe dir stands in for production's checkout (see runProbes), and
    // the lib link mirrors the layout the prompts assume.
    const probeDir = mkdtempSync(`${repoRoot}/.sandbox-smoke-`);
    let failures: string[] = [];
    try {
        appendFileSync(`${probeDir}/sentinel.txt`, "sandbox-smoke-sentinel\n");
        symlinkSync(repoRoot, `${probeDir}/${LIB_DIR_NAME}`, "dir");

        // Fail-closed by construction: this throws when srt cannot initialize.
        // REVIEW_SANDBOX=off would make every probe below meaningless, so the
        // smoke refuses to run under it rather than reporting a green wall.
        if (process.env["REVIEW_SANDBOX"] === "off") {
            throw new Error(
                "REVIEW_SANDBOX=off disables the boundary this job exists to prove; unset it.",
            );
        }
        const exec = await createToolExec();
        summaryLine("### Sandbox smoke\n");
        summaryLine("Phase A: boundary probes (srt active, no model)\n");

        const probes = await runProbes(exec, probeDir);
        summaryLine(renderProbes(probes));
        summaryLine("");
        const verdict = summarizeProbes(probes);
        failures = verdict.failed;

        if (probesOnly) {
            summaryLine("Phase B skipped (--probes-only).\n");
        } else if (!process.env["ANTHROPIC_API_KEY"]) {
            // Not a pass: the live phase is the only check of the tool
            // DEFINITIONS, so a missing key is a gap to report, not to hide.
            failures.push("phase B did not run (no ANTHROPIC_API_KEY)");
        } else {
            const toolNames: string[] = [];
            const journalBefore = journalLines();
            const stageRoot = mkdtempSync("/tmp/review-sandbox-smoke-");
            const cases = loadLiveCorpus();
            const corpusCase = cases.find((entry) => entry.id === caseId);
            if (corpusCase === undefined) {
                throw new Error(
                    `no live case "${caseId}"; available: ${cases
                        .map((entry) => entry.id)
                        .join(", ")}`,
                );
            }
            const reviewMd = argValue("--review-md") ?? DEFAULT_REVIEW_MD;
            const agents = extractAgents(
                readFileSync(`${repoRoot}/${reviewMd}`, "utf8"),
            );
            summaryLine(
                `Phase B: case \`${caseId}\` on the production tool surface\n`,
            );
            const result = await produceLive(corpusCase, agents, {
                runner: productionSurfaceRunner(repoRoot, toolNames),
                stageDir: `${stageRoot}/${caseId}`,
            });
            const usd = result.perAgent.reduce((sum, a) => sum + a.usd, 0);
            const bashCalls = toolNames.filter(
                (name) => name === "Bash",
            ).length;
            const journalDelta = journalLines() - journalBefore;
            summaryLine(
                [
                    `| signal | value |`,
                    `| --- | --- |`,
                    `| tool calls | ${toolNames.length} (${[
                        ...new Set(toolNames),
                    ].join(", ")}) |`,
                    `| Bash calls | ${bashCalls} |`,
                    `| cap-journal lines added | ${journalDelta} (reported, not gated) |`,
                    `| findings | ${result.findings.length} |`,
                    `| cost | $${usd.toFixed(2)} |`,
                ].join("\n"),
            );
            summaryLine("");
            if (bashCalls === 0) {
                failures.push(
                    "phase B never reached Bash: the production tool surface is unproven",
                );
            }
        }
    } finally {
        rmSync(probeDir, {recursive: true, force: true});
    }

    if (failures.length > 0) {
        summaryLine(`**Sandbox smoke FAILED:** ${failures.join("; ")}\n`);
        throw new Error(`sandbox smoke failed: ${failures.join("; ")}`);
    }
    summaryLine("**Sandbox smoke passed.**\n");
};

/**
 * Exit explicitly, once stdout has drained.
 *
 * srt's initialize starts a proxy and nothing here shuts it down, so the event
 * loop never empties and the process outlives its own verdict: run 30867526519
 * printed "Sandbox smoke passed." at 01:03:43 and then held the runner until it
 * was cancelled 25 minutes later. A PASSED smoke that presents as a hung job is
 * worse than a failure, because the check never resolves either way.
 *
 * Draining first, rather than a bare process.exit: Actions gives this process a
 * pipe, writes to a pipe are asynchronous, and exiting on top of a buffered
 * write truncates the last lines of the very table the job exists to print. The
 * unref'd fallback covers a drain callback that never fires.
 */
const exitWhenFlushed = (code: number): void => {
    const done = (): never => process.exit(code);
    setTimeout(done, 2000).unref();
    process.stdout.write("", done);
};

// CLI entry point (mirrors live-runner.ts): run when executed, not imported.
if (process.argv[1]?.endsWith("sandbox-smoke.ts")) {
    main().then(
        () => exitWhenFlushed(0),
        (error: unknown) => {
            console.error(error);
            exitWhenFlushed(1);
        },
    );
}
