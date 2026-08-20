import {describe, expect, it} from "vitest";

import {
    buildBounceMessage,
    buildJudgePrompt,
    buildProseJudgeArtifact,
    createProseGate,
    extractProseUnits,
    LABEL_RUBRIC_EXTRA,
    MAX_PROSE_BOUNCES,
    parseJudgeVerdict,
    PLAIN_PROSE_RUBRIC,
    type ProseRunner,
} from "./judge-prose";
import {FIXTURES_41609} from "./judge-prose-fixtures";

/**
 * The prose gate's mechanics, pinned with a stubbed runner: the model's
 * actual judgment lives in eval/judge-prose-live.ts (real calls over the
 * 41609 fixtures); everything here is the bounce contract — the author is
 * asked to rewrite, never more than MAX_PROSE_BOUNCES times, judge errors
 * accept immediately, and the records carry the four-state accounting. The
 * fixture payloads are the real Khan/webapp#41609 comments so the prompts
 * under test are the prompts production sends.
 */

/** A schema-finding payload (finder contract shape) from the fixtures. */
const finderPayload = (): Record<string, unknown> => ({
    findings: FIXTURES_41609.map((fixture, index) => ({
        id: `f-${index}`,
        severity: "advisory",
        model_authored_prose: fixture.discussion,
    })),
});

/** A label-shape payload (lens contract shape). */
const lensPayload = (): Record<string, unknown> => ({
    findings: [
        {
            label: FIXTURES_41609[2].label,
            subject: "Graduation removes the runtime control.",
            discussion: FIXTURES_41609[2].discussion,
        },
    ],
});

const passRunner: ProseRunner = () =>
    Promise.resolve('{"pass": true, "problems": []}');

const failRunner: ProseRunner = () =>
    Promise.resolve('{"pass": false, "problems": ["judge: metaphor"]}');

describe("buildJudgePrompt", () => {
    it("carries the verbatim rubric, the extra, the label line, and the posting view", () => {
        const prompt = buildJudgePrompt(
            FIXTURES_41609[2].discussion,
            "thought (non-blocking)",
        );
        expect(prompt).toContain(PLAIN_PROSE_RUBRIC);
        expect(prompt).toContain(LABEL_RUBRIC_EXTRA);
        expect(prompt).toContain("LABEL: thought (non-blocking)");
        expect(prompt).toContain(
            "**thought (non-blocking):** Graduation removes the last runtime lever",
        );
    });
});

describe("parseJudgeVerdict", () => {
    it("tolerates stray text around the JSON", () => {
        expect(
            parseJudgeVerdict(
                'Verdict:\n{"pass": false, "problems": ["judge: x"]}\nDone.',
            ),
        ).toEqual({pass: false, problems: ["judge: x"]});
    });

    it("returns null (the error state) on non-JSON or non-boolean pass", () => {
        expect(parseJudgeVerdict("looks fine")).toBeNull();
        expect(parseJudgeVerdict('{"pass": "yes"}')).toBeNull();
        expect(parseJudgeVerdict("{not json}")).toBeNull();
    });

    it("drops non-string problem entries rather than crashing", () => {
        expect(
            parseJudgeVerdict('{"pass": false, "problems": ["a", 3, null]}'),
        ).toEqual({pass: false, problems: ["a"]});
    });
});

describe("extractProseUnits", () => {
    it("reads schema findings (model_authored_prose + severity label)", () => {
        const units = extractProseUnits(finderPayload());
        expect(units).toHaveLength(3);
        expect(units[0]).toMatchObject({
            key: "f-0",
            label: "suggestion (non-blocking)",
        });
    });

    it("maps blocking severity to the blocking label", () => {
        const units = extractProseUnits({
            findings: [
                {id: "b", severity: "blocking", model_authored_prose: "text"},
            ],
        });
        expect(units[0]?.label).toBe("issue (blocking)");
    });

    it("reads label-shape findings (subject + discussion joined)", () => {
        const units = extractProseUnits(lensPayload());
        expect(units).toHaveLength(1);
        expect(units[0]?.label).toBe("thought (non-blocking)");
        expect(units[0]?.prose).toContain(
            "Graduation removes the runtime control.",
        );
        expect(units[0]?.prose).toContain("last runtime lever");
    });

    it("yields nothing for prose-free payloads (triage, reconciler, junk)", () => {
        expect(extractProseUnits({})).toEqual([]);
        expect(extractProseUnits({findings: "nope"})).toEqual([]);
        expect(extractProseUnits({findings: [{id: "x"}, 3]})).toEqual([]);
    });
});

describe("createProseGate", () => {
    it("accepts a clean submission and records a pass per finding", async () => {
        const {gate, records} = createProseGate({
            runner: passRunner,
            source: "correctness-reviewer",
        });
        expect(await gate(finderPayload())).toBeNull();
        expect(records).toHaveLength(3);
        expect(records.every((record) => record.state === "pass")).toBe(true);
    });

    it("bounces a failing submission with the problems and the shape contract", async () => {
        const {gate, records} = createProseGate({
            runner: failRunner,
            source: "correctness-reviewer",
        });
        const rejection = await gate(lensPayload());
        expect(rejection).not.toBeNull();
        expect(rejection).toContain("Result rejected");
        expect(rejection).toContain("judge: metaphor");
        expect(rejection).toContain(
            "at most one claim, one line of evidence, and at most one question",
        );
        expect(rejection).toContain("call submit_result again");
        expect(records[0]).toMatchObject({state: "fail", bounced: true});
    });

    it("accepts as-is once the bounce cap is reached, recording unbounced fails", async () => {
        const {gate, records} = createProseGate({
            runner: failRunner,
            source: "correctness-reviewer",
        });
        for (let bounce = 0; bounce < MAX_PROSE_BOUNCES; bounce += 1) {
            expect(await gate(lensPayload())).not.toBeNull();
        }
        // Attempt 3: still failing, but the cap is spent; the submission
        // posts with its original prose rather than looping.
        expect(await gate(lensPayload())).toBeNull();
        const last = records[records.length - 1];
        expect(last).toMatchObject({attempt: 3, state: "fail", bounced: false});
    });

    it("accepts immediately on a judge error and records it (fail-open)", async () => {
        const {gate, records} = createProseGate({
            runner: () => Promise.reject(new Error("proxy unreachable")),
            source: "correctness-reviewer",
        });
        expect(await gate(lensPayload())).toBeNull();
        expect(records[0]).toMatchObject({
            state: "error",
            reason: "proxy unreachable",
            bounced: false,
        });
    });

    it("treats an unparseable verdict as an error, not a fail", async () => {
        const {gate, records} = createProseGate({
            runner: () => Promise.resolve("seems fine to me"),
            source: "correctness-reviewer",
        });
        expect(await gate(lensPayload())).toBeNull();
        expect(records[0]).toMatchObject({
            state: "error",
            reason: "unparseable judge reply",
        });
    });

    it("judges each finding independently and bounces only the failures", async () => {
        let call = 0;
        const runner: ProseRunner = () => {
            call += 1;
            return Promise.resolve(
                call === 2
                    ? '{"pass": false, "problems": ["judge: verbosity"]}'
                    : '{"pass": true, "problems": []}',
            );
        };
        const {gate, records} = createProseGate({
            runner,
            source: "correctness-reviewer",
        });
        const rejection = await gate(finderPayload());
        expect(rejection).toContain("- f-1: judge: verbosity");
        expect(rejection).not.toContain("- f-0");
        expect(records.map((record) => record.state)).toEqual([
            "pass",
            "fail",
            "pass",
        ]);
    });

    it("passes a prose-free payload without a model call", async () => {
        const {gate, records} = createProseGate({
            runner: () => Promise.reject(new Error("must not be called")),
            source: "pattern-triage",
        });
        expect(await gate({risks: []})).toBeNull();
        expect(records).toHaveLength(0);
    });
});

describe("buildBounceMessage", () => {
    it("names each failing finding with its problems", () => {
        const message = buildBounceMessage([
            {key: "f-2", problems: ['judge: metaphor, "last runtime lever"']},
            {key: "f-3", problems: []},
        ]);
        expect(message).toContain(
            '- f-2: judge: metaphor, "last runtime lever"',
        );
        expect(message).toContain("- f-3: style check failed");
        expect(message).toContain(
            "Keep every fact, identifier, number, and path",
        );
    });
});

describe("buildProseJudgeArtifact", () => {
    it("counts the four states and the bounces", () => {
        const artifact = buildProseJudgeArtifact([
            {
                source: "a",
                key: "f-0",
                label: "x",
                attempt: 1,
                state: "fail",
                problems: ["p"],
                bounced: true,
            },
            {
                source: "a",
                key: "f-0",
                label: "x",
                attempt: 2,
                state: "pass",
                problems: [],
                bounced: false,
            },
            {
                source: "b",
                key: "*",
                label: "",
                attempt: 0,
                state: "skipped",
                problems: [],
                bounced: false,
                reason: "free-text fallback; findings, if any, unjudged",
            },
            {
                source: "c",
                key: "f-1",
                label: "y",
                attempt: 1,
                state: "error",
                problems: [],
                bounced: false,
                reason: "timeout",
            },
        ]);
        expect(artifact.counts).toEqual({
            total: 4,
            skipped: 1,
            pass: 1,
            fail: 1,
            error: 1,
            bounces: 1,
        });
        expect(artifact.model).toBe("claude-haiku-4-5-20251001");
    });
});
