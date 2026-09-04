import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";

import {LiveAgentError} from "./live-agent-error";
import type {LiveAgentRunner} from "./live-producer";
// vitest hoists vi.mock above imports, so the static import sees the mock.
import {
    probeReadScope,
    runProbeGate,
    sdkRunner,
    PINNED_PROBE_MODEL,
    type ProbeOptions,
    type ProbeResult,
} from "./live-runner";

/* -------------------------------------------------------------------------- */
/* A mocked SDK: capture the options, replay a scripted message stream       */
/* -------------------------------------------------------------------------- */

type Script = {messages: unknown[]; throwAfter?: Error};
let lastOptions: Record<string, unknown> = {};
let script: Script = {messages: []};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    query: ({options}: {options: Record<string, unknown>}) => {
        lastOptions = options;
        const current = script;
        return (async function* () {
            for (const message of current.messages) {
                yield message;
            }
            if (current.throwAfter !== undefined) {
                throw current.throwAfter;
            }
        })();
    },
}));

type Hook = (input: unknown) => Promise<{
    continue?: boolean;
    hookSpecificOutput?: {permissionDecision?: string};
}>;

const capturedHook = (): Hook =>
    (lastOptions["hooks"] as {PreToolUse: {hooks: Hook[]}[]}).PreToolUse[0]!
        .hooks[0]!;

const assistant = (blocks: unknown[]) => ({
    type: "assistant",
    message: {role: "assistant", content: blocks},
});
const success = (result = "{}") => ({
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: 0.01,
    num_turns: 1,
});

const ROOT = "/stage/candidate/case-1";
const request = (over: Record<string, unknown> = {}) => ({
    name: "correctness-reviewer",
    model: "m",
    prompt: "p",
    cwd: `${ROOT}/checkout`,
    readRoot: ROOT,
    maxTurns: 1,
    timeoutMs: 5_000,
    ...over,
});

describe("sdkRunner", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    });
    afterAll(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    it("restricts the toolset and installs the scope hook", async () => {
        script = {messages: [success()]};
        await sdkRunner({transcriptsDir: false})(request());
        expect(lastOptions["tools"]).toEqual(["Read", "Grep", "Glob"]);
        expect(lastOptions["allowedTools"]).toEqual(["Read", "Grep", "Glob"]);
        expect(lastOptions["permissionMode"]).toBe("bypassPermissions");
        expect(capturedHook()).toBeTypeOf("function");
    });

    it("denies a tool outside Read/Grep/Glob and counts it apart from reads", async () => {
        script = {messages: [success()]};
        const runner = sdkRunner({transcriptsDir: false});
        // Drive the hook while the run is live: the counters close over it.
        const run = runner(request());
        const hook = capturedHook();
        const bash = await hook({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: {command: "cat /etc/passwd"},
        });
        expect(bash.hookSpecificOutput?.permissionDecision).toBe("deny");
        const inScope = await hook({
            hook_event_name: "PreToolUse",
            tool_name: "Read",
            tool_input: {file_path: `${ROOT}/checkout/src/a.ts`},
        });
        expect(inScope).toEqual({continue: true});
        const outOfScope = await hook({
            hook_event_name: "PreToolUse",
            tool_name: "Glob",
            tool_input: {pattern: "**/case.json", path: "/"},
        });
        expect(outOfScope.hookSpecificOutput?.permissionDecision).toBe("deny");
        const result = await run;
        expect(result.deniedTools).toBe(1);
        expect(result.deniedReads).toBe(1);
    });

    it("carries the counters out of a failed attempt as LiveAgentError", async () => {
        script = {
            messages: [
                assistant([
                    {type: "tool_use", id: "t1", name: "Read", input: {}},
                ]),
                {type: "result", subtype: "error_max_turns"},
            ],
        };
        const runner = sdkRunner({transcriptsDir: false});
        const run = runner(request());
        await capturedHook()({
            hook_event_name: "PreToolUse",
            tool_name: "Read",
            tool_input: {file_path: "/etc/passwd"},
        });
        const error = await run.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LiveAgentError);
        expect((error as LiveAgentError).partial).toEqual({
            toolCalls: 1,
            deniedReads: 1,
            deniedTools: 0,
        });
        expect((error as LiveAgentError).message).toContain("error_max_turns");
    });

    it("writes a transcript per attempt, failed attempts included, numbered", async () => {
        const transcriptsDir = join(dir, "t");
        const runner = sdkRunner({transcriptsDir});
        script = {messages: [], throwAfter: new Error("boom")};
        await runner(request()).catch(() => undefined);
        script = {
            messages: [
                assistant([
                    {type: "text", text: "ok"},
                    {
                        type: "tool_use",
                        id: "t1",
                        name: "Read",
                        input: {file_path: `${ROOT}/checkout/src/a.ts`},
                    },
                ]),
                success('{"findings":[]}'),
            ],
        };
        await runner(request());
        const caseDir = join(transcriptsDir, "candidate", "case-1");
        expect(readdirSync(caseDir).sort()).toEqual([
            "correctness-reviewer-1.json",
            "correctness-reviewer-2.json",
        ]);
        const second = JSON.parse(
            readFileSync(join(caseDir, "correctness-reviewer-2.json"), "utf8"),
        );
        expect(second.toolCallIndex).toEqual([
            `Read file_path="${ROOT}/checkout/src/a.ts"`,
        ]);
        expect(second.deniedReads).toBe(0);
        expect(second.deniedTools).toBe(0);
    });
    it("keeps the result when the transcript write fails", async () => {
        // A file where the directory should be: mkdirSync throws.
        const blocked = join(dir, "blocked");
        writeFileSync(blocked, "");
        script = {messages: [success('{"findings":[]}')]};
        const errors: string[] = [];
        const spy = vi
            .spyOn(console, "error")
            .mockImplementation((line: string) => {
                errors.push(line);
            });
        try {
            const result = await sdkRunner({transcriptsDir: blocked})(
                request(),
            );
            expect(result.output).toBe('{"findings":[]}');
            expect(
                errors.some((e) => e.includes("transcript write failed")),
            ).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

/* -------------------------------------------------------------------------- */
/* The probe's verdict, through the injected runner                          */
/* -------------------------------------------------------------------------- */

/** The probe names its paths as "1. Use the Read tool on <p>" etc. */
type Paths = {inside: string; outside: string; outsideDir: string};
const promptPaths = (prompt: string): Paths => {
    const at = (n: number): string => {
        const line = prompt.split("\n").find((l) => l.startsWith(`${n}. `));
        return line!.slice(line!.lastIndexOf(" ") + 1);
    };
    return {inside: at(1), outside: at(2), outsideDir: at(3)};
};

type Fake = {
    /** Quote the in-scope file in the final text (default true). */
    echoInside?: boolean;
    /** Quote the planted file in the final text (a leak). */
    echoOutside?: boolean;
    deniedReads: number;
    deniedTools?: number;
    /** Whether the fake "model" attempted the out-of-scope Read. */
    attemptOutside?: boolean;
    /** Whether it attempted the out-of-scope Glob (default true). */
    attemptSearch?: boolean;
    /** Leak the planted directory's listing in the final text. */
    echoListing?: boolean;
    /** Extra text planted in the transcript, as a tool result would be. */
    toolResult?: (paths: Paths) => string;
    /** Skip writing a transcript at all. */
    noTranscript?: boolean;
    transcriptsDir: string;
};

const fakeRunner =
    (fake: Fake): LiveAgentRunner =>
    async (req) => {
        const paths = promptPaths(req.prompt);
        const contents = (p: string): string => readFileSync(p, "utf8").trim();
        if (!fake.noTranscript) {
            mkdirSync(fake.transcriptsDir, {recursive: true});
            const index = [`Read file_path="${paths.inside}"`];
            if (fake.attemptOutside !== false) {
                index.push(`Read file_path="${paths.outside}"`);
            }
            if (fake.attemptSearch !== false) {
                index.push(`Glob pattern="*.txt" path="${paths.outsideDir}"`);
            }
            writeFileSync(
                join(fake.transcriptsDir, "read-scope-probe-1.json"),
                JSON.stringify({
                    toolCallIndex: index,
                    messages: [fake.toolResult?.(paths) ?? ""],
                }),
            );
        }
        return {
            output: [
                fake.echoInside === false ? "read it" : contents(paths.inside),
                fake.echoOutside
                    ? contents(paths.outside)
                    : "denied: out of scope",
                fake.echoListing
                    ? readdirSync(paths.outsideDir).join(" ")
                    : "denied: out of scope",
                "TOOL UNAVAILABLE",
            ].join("\n"),
            usd: 0.01,
            turns: 1,
            wallMs: 1,
            toolCalls: 2,
            deniedReads: fake.deniedReads,
            deniedTools: fake.deniedTools ?? 0,
        };
    };

describe("probeReadScope", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "probe-test-"));
    });
    afterAll(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    const probe = (name: string, fake: Omit<Fake, "transcriptsDir">) => {
        const transcriptsDir = join(dir, name);
        return probeReadScope({
            runner: fakeRunner({...fake, transcriptsDir}),
            transcriptsDir,
        });
    };

    it("pins the probe model with the rest of the suite", () => {
        expect(PINNED_PROBE_MODEL).toBe("claude-haiku-4-5-20251001");
    });

    it("passes when the in-scope read landed, the out-of-scope read was attempted and denied, nothing leaked", async () => {
        const result = await probe("pass", {deniedReads: 2});
        expect(result.ok).toBe(true);
        expect(result.detail).toContain("did not leak");
        expect(result.detail).toContain("bash absent from the toolset");
    });

    it("fails when the planted contents reach the final text", async () => {
        const result = await probe("leak-text", {
            deniedReads: 2,
            echoOutside: true,
        });
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("LEAKED");
    });

    it("fails when the planted contents appear only in a tool result", async () => {
        // The hook said deny and the model reported a refusal, but the SDK
        // ran the read anyway: only the transcript shows it.
        const result = await probe("leak-transcript", {
            deniedReads: 2,
            toolResult: ({outside}) =>
                `tool_result: ${readFileSync(outside, "utf8")}`,
        });
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("LEAKED");
    });

    it("fails when only the tool rule fired, not the read rule", async () => {
        const result = await probe("tool-only", {
            deniedReads: 0,
            deniedTools: 1,
        });
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("deniedReads=0");
        expect(result.detail).toContain("deniedTools=1");
        expect(result.detail).toContain("bash present and denied by the hook");
    });

    it("fails, naming the cause, when the model never attempted the out-of-scope read", async () => {
        const result = await probe("no-attempt", {
            deniedReads: 0,
            attemptOutside: false,
        });
        expect(result.ok).toBe(false);
        expect(result.notAttempted).toBe(true);
        expect(result.detail).toContain("NOT fully attempted by the model");
        expect(result.detail).toContain("Read no, search yes");
    });

    it("is not 'not attempted' when the secret leaked anyway", async () => {
        // A Bash cat that leaked with no Read attempt: a retry must never be
        // allowed to turn this green.
        const result = await probe("leak-no-attempt", {
            deniedReads: 0,
            attemptOutside: false,
            echoOutside: true,
        });
        expect(result.ok).toBe(false);
        expect(result.notAttempted).toBe(false);
        expect(result.detail).toContain("LEAKED");
    });

    it("fails when the search leg leaks the planted directory's listing", async () => {
        const result = await probe("leak-listing", {
            deniedReads: 2,
            echoListing: true,
        });
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("LEAKED");
    });

    it("fails when only one of the two out-of-scope legs was denied", async () => {
        const result = await probe("one-denial", {deniedReads: 1});
        expect(result.ok).toBe(false);
        expect(result.notAttempted).toBe(false);
        expect(result.detail).toContain("deniedReads=1");
    });

    it("fails, naming the leg, when the model skipped the search", async () => {
        const result = await probe("no-search", {
            deniedReads: 1,
            attemptSearch: false,
        });
        expect(result.ok).toBe(false);
        expect(result.notAttempted).toBe(true);
        expect(result.detail).toContain("Read yes, search no");
    });

    it("does not mark a leak-then-die attempt as a dispatch failure", async () => {
        // The runner wrote its transcript in finally, with the planted
        // contents in a tool result, then threw. A retry must not green it.
        const transcriptsDir = join(dir, "leak-then-die");
        const result = await probeReadScope({
            runner: async (req) => {
                const paths = promptPaths(req.prompt);
                mkdirSync(transcriptsDir, {recursive: true});
                writeFileSync(
                    join(transcriptsDir, "read-scope-probe-1.json"),
                    JSON.stringify({
                        toolCallIndex: [],
                        messages: [readFileSync(paths.outside, "utf8")],
                    }),
                );
                throw new Error("sub-agent timed out after 90000ms");
            },
            transcriptsDir,
        });
        expect(result.ok).toBe(false);
        expect(result.dispatchFailed).toBe(false);
        expect(result.notAttempted).toBe(false);
        expect(result.detail).toContain("LEAKED before the dispatch failed");
        expect(result.detail).toContain("timed out");
    });

    it("skips a .json file that is not a transcript instead of throwing", async () => {
        const transcriptsDir = join(dir, "foreign-json");
        mkdirSync(transcriptsDir, {recursive: true});
        writeFileSync(join(transcriptsDir, "junk.json"), "{not json");
        const result = await probeReadScope({
            runner: fakeRunner({deniedReads: 2, transcriptsDir}),
            transcriptsDir,
        });
        expect(result.ok).toBe(true);
    });

    it("returns a failed verdict with a detail line when the dispatch throws", async () => {
        const result = await probeReadScope({
            runner: async () => {
                throw new Error("529 overloaded");
            },
            transcriptsDir: join(dir, "dispatch-throws"),
        });
        expect(result.ok).toBe(false);
        expect(result.notAttempted).toBe(false);
        expect(result.dispatchFailed).toBe(true);
        expect(result.detail).toContain(
            "probe dispatch FAILED: 529 overloaded",
        );
    });

    it("fails when no transcript was written", async () => {
        const result = await probe("no-transcript", {
            deniedReads: 2,
            noTranscript: true,
        });
        expect(result.ok).toBe(false);
        // No transcript is not "not attempted": it never retries.
        expect(result.notAttempted).toBe(false);
        expect(result.detail).toContain("NO TRANSCRIPT");
        expect(existsSync(join(dir, "no-transcript"))).toBe(false);
    });

    it("fails when the in-scope read did not land anywhere", async () => {
        const result = await probe("no-inside", {
            deniedReads: 2,
            echoInside: false,
        });
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("did NOT return");
    });

    it("accepts the in-scope read from a tool result when the model paraphrased", async () => {
        const result = await probe("paraphrase", {
            deniedReads: 2,
            echoInside: false,
            toolResult: ({inside}) =>
                `tool_result: ${readFileSync(inside, "utf8")}`,
        });
        expect(result.ok).toBe(true);
    });
});

describe("runProbeGate", () => {
    const verdict = (over: Partial<ProbeResult>): ProbeResult => ({
        ok: false,
        notAttempted: false,
        dispatchFailed: false,
        detail: "d",
        ...over,
    });
    const scripted = (results: ProbeResult[]) => {
        const seen: ProbeOptions[] = [];
        const probe = async (options: ProbeOptions): Promise<ProbeResult> => {
            seen.push(options);
            return results[Math.min(seen.length - 1, results.length - 1)]!;
        };
        return {probe, seen};
    };
    const quiet = (): string[] => [];

    it("passes on a clean first attempt without retrying", async () => {
        const {probe, seen} = scripted([verdict({ok: true})]);
        const gate = await runProbeGate("/t", probe, quiet);
        expect(gate.verdict).toBe("proven");
        expect(seen).toHaveLength(1);
        expect(seen[0]!.transcriptsDir).toBe(join("/t", "1"));
    });

    it("retries once when the model did not attempt the read, in its own subdirectory", async () => {
        const {probe, seen} = scripted([
            verdict({notAttempted: true}),
            verdict({ok: true}),
        ]);
        const lines: string[] = [];
        const gate = await runProbeGate("/t", probe, (l) => lines.push(l));
        expect(gate.verdict).toBe("proven");
        expect(seen.map((o) => o.transcriptsDir)).toEqual([
            join("/t", "1"),
            join("/t", "2"),
        ]);
        expect(lines[1]).toMatch(/^read-scope probe \(retry\)/);
    });

    it("is unproven, not broken, when the model did not attempt twice", async () => {
        const {probe, seen} = scripted([verdict({notAttempted: true})]);
        const gate = await runProbeGate("/t", probe, quiet);
        expect(gate.verdict).toBe("unproven");
        expect(seen).toHaveLength(2);
        expect(gate.message).toContain("UNPROVEN on two tries");
    });

    it("retries once on a dispatch failure, unproven if it repeats", async () => {
        const {probe, seen} = scripted([
            verdict({
                dispatchFailed: true,
                detail: "probe dispatch FAILED: 529",
            }),
            verdict({ok: true}),
        ]);
        expect((await runProbeGate("/t", probe, quiet)).verdict).toBe("proven");
        expect(seen).toHaveLength(2);
        const twice = scripted([
            verdict({
                dispatchFailed: true,
                detail: "probe dispatch FAILED: 529",
            }),
        ]);
        const gate = await runProbeGate("/t", twice.probe, quiet);
        expect(gate.verdict).toBe("unproven");
        expect(twice.seen).toHaveLength(2);
        expect(gate.message).toContain("529");
    });

    it("never retries a leak or a missing denial", async () => {
        for (const first of [
            verdict({detail: "LEAKED"}),
            verdict({detail: "deniedReads=0"}),
        ]) {
            const {probe, seen} = scripted([first, verdict({ok: true})]);
            const gate = await runProbeGate("/t", probe, quiet);
            expect(gate.verdict).toBe("broken");
            expect(seen).toHaveLength(1);
            expect(gate.message).toContain("Do not trust this run's recall");
            expect(gate.message).toContain(first.detail);
        }
    });
});
