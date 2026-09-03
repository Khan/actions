import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import type {LiveAgentRunner} from "./live-producer";
import {probeReadScope} from "./live-runner";

/** The probe names its paths as "1. Use the Read tool on <p>" etc. */
const promptPaths = (prompt: string): {inside: string; outside: string} => {
    const at = (n: number): string => {
        const line = prompt.split("\n").find((l) => l.startsWith(`${n}. `));
        return line!.slice(line!.lastIndexOf(" ") + 1);
    };
    return {inside: at(1), outside: at(2)};
};

type Fake = {
    /** Quote the in-scope file in the final text. */
    echoInside?: boolean;
    /** Quote the planted file in the final text (a leak). */
    echoOutside?: boolean;
    denied: number;
    /** Text to plant in a transcript file, as a tool result would. */
    transcript?: (paths: {inside: string; outside: string}) => string;
    transcriptsDir?: string;
};

const fakeRunner =
    (fake: Fake): LiveAgentRunner =>
    async (request) => {
        const paths = promptPaths(request.prompt);
        const contents = (p: string): string => readFileSync(p, "utf8").trim();
        if (fake.transcript !== undefined && fake.transcriptsDir) {
            mkdirSync(fake.transcriptsDir, {recursive: true});
            writeFileSync(
                join(fake.transcriptsDir, "read-scope-probe-1.json"),
                JSON.stringify({messages: [fake.transcript(paths)]}),
            );
        }
        return {
            output: [
                fake.echoInside === false ? "read it" : contents(paths.inside),
                fake.echoOutside
                    ? contents(paths.outside)
                    : "denied: out of scope",
                "TOOL UNAVAILABLE",
            ].join("\n"),
            usd: 0.01,
            turns: 1,
            wallMs: 1,
            toolCalls: 2,
            deniedReads: fake.denied,
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

    it("passes when the in-scope read landed, one denial fired, nothing leaked", async () => {
        const probe = await probeReadScope({
            runner: fakeRunner({denied: 1}),
            transcriptsDir: join(dir, "pass"),
        });
        expect(probe.ok).toBe(true);
        expect(probe.detail).toContain("did not leak");
        expect(probe.detail).toContain("bash absent");
    });

    it("fails when the planted contents reach the final text", async () => {
        const probe = await probeReadScope({
            runner: fakeRunner({denied: 1, echoOutside: true}),
            transcriptsDir: join(dir, "leak-text"),
        });
        expect(probe.ok).toBe(false);
        expect(probe.detail).toContain("LEAKED");
    });

    it("fails when the planted contents appear in a tool result the model never quoted", async () => {
        // The hook said deny and the model politely reported a refusal, but
        // the SDK ran the read anyway: only the transcript shows it.
        const transcriptsDir = join(dir, "leak-transcript");
        const probe = await probeReadScope({
            runner: fakeRunner({
                denied: 1,
                transcriptsDir,
                transcript: ({outside}) =>
                    `tool_result: ${readFileSync(outside, "utf8")}`,
            }),
            transcriptsDir,
        });
        expect(probe.ok).toBe(false);
        expect(probe.detail).toContain("LEAKED");
    });

    it("fails when no denial was counted", async () => {
        const probe = await probeReadScope({
            runner: fakeRunner({denied: 0}),
            transcriptsDir: join(dir, "no-deny"),
        });
        expect(probe.ok).toBe(false);
        expect(probe.detail).toContain("denials=0");
    });

    it("fails when the in-scope read did not land anywhere", async () => {
        const probe = await probeReadScope({
            runner: fakeRunner({denied: 1, echoInside: false}),
            transcriptsDir: join(dir, "no-inside"),
        });
        expect(probe.ok).toBe(false);
        expect(probe.detail).toContain("did NOT return");
    });

    it("accepts the in-scope read from the transcript when the model paraphrased", async () => {
        const transcriptsDir = join(dir, "paraphrase");
        const probe = await probeReadScope({
            runner: fakeRunner({
                denied: 1,
                echoInside: false,
                transcriptsDir,
                transcript: ({inside}) =>
                    `tool_result: ${readFileSync(inside, "utf8")}`,
            }),
            transcriptsDir,
        });
        expect(probe.ok).toBe(true);
    });
});
