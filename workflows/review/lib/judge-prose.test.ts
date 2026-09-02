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
    PINNED_PROSE_JUDGE_MODEL,
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

    it("survives prose braces outside the verdict (shared agent-json leniency)", () => {
        // A greedy first-brace-to-last-brace slice would grab the whole
        // line, fail to parse, and count a real fail as a judge error.
        expect(
            parseJudgeVerdict(
                'The phrase {like this} is flourish. {"pass": false, "problems": ["judge: metaphor"]}',
            ),
        ).toEqual({pass: false, problems: ["judge: metaphor"]});
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

    it("reads the validator's corrected prose (it replaces what posts)", () => {
        const units = extractProseUnits({
            claims: [
                {id: "c-1", verification: "confirmed"},
                {
                    id: "c-2",
                    verification: "confirmed",
                    corrected: {
                        label: "question (non-blocking)",
                        subject: "Corrected subject.",
                        discussion: "Corrected discussion.",
                    },
                },
                {verification: "confirmed", corrected: {discussion: "x"}},
            ],
        });
        // The unit mirrors the posting surface: corrected.discussion is
        // the body, corrected.subject the visible line, never a join the
        // renderer would not emit.
        expect(units).toEqual([
            {
                key: "c-2.corrected",
                label: "question (non-blocking)",
                prose: "Corrected discussion.",
                summary: "Corrected subject.",
            },
            {
                key: "claims[2].corrected",
                label: "suggestion (non-blocking)",
                prose: "x",
                summary: "x",
            },
        ]);
    });

    it("reads out-of-lane observations (they post as questions)", () => {
        const units = extractProseUnits({
            findings: [],
            out_of_lane_observations: [
                {observation: "The sibling test asserts the wrong constant."},
                {observation: "   "},
                "junk",
            ],
        });
        expect(units).toEqual([
            {
                key: "out_of_lane_observations[0]",
                label: "question (non-blocking)",
                prose: "The sibling test asserts the wrong constant.",
                summary: "The sibling test asserts the wrong constant.",
            },
        ]);
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
            "at most one claim and at most one question per finding",
        );
        expect(rejection).toContain(
            "evidence chain complete enough to check the claim",
        );
        expect(rejection).toContain("call submit_result again");
        expect(records[0]).toMatchObject({state: "fail", bounced: true});
        // The audit snapshot: a fail records the judged prose so the
        // artifact carries the before side of the author's rewrite.
        expect(records[0].prose).toContain("last runtime lever");
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
        // Every post-bounce attempt snapshots its prose (the after side of
        // the audit pair), capped.
        expect(last.prose).toBeDefined();
        expect(last.prose!.length).toBeLessThanOrEqual(600);
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

    it("never re-judges a finding that already passed (monotonic bounces)", async () => {
        const judged: string[] = [];
        const runner: ProseRunner = (prompt) => {
            judged.push(prompt);
            return Promise.resolve(
                prompt.includes("f-1-prose")
                    ? '{"pass": false, "problems": ["judge: verbosity"]}'
                    : '{"pass": true, "problems": []}',
            );
        };
        const {gate, records} = createProseGate({
            runner,
            source: "correctness-reviewer",
        });
        const payload = {
            findings: [
                {
                    id: "f-0",
                    severity: "advisory",
                    model_authored_prose: "f-0-prose",
                },
                {
                    id: "f-1",
                    severity: "advisory",
                    model_authored_prose: "f-1-prose",
                },
            ],
        };
        expect(await gate(payload)).not.toBeNull();
        expect(judged).toHaveLength(2);
        // The resubmission re-judges only the failing finding: the passed
        // one is unchanged, so a flickery judge cannot flip it to fail and
        // spend bounce budget the author did nothing to earn.
        judged.length = 0;
        expect(await gate(payload)).not.toBeNull();
        expect(judged).toHaveLength(1);
        expect(judged[0]).toContain("f-1-prose");
        // The untouched finding still records a pass on attempt 2.
        expect(
            records.filter((r) => r.attempt === 2).map((r) => r.state),
        ).toEqual(["pass", "fail"]);
    });

    it("records a finding the author dropped between attempts", async () => {
        const {gate, records} = createProseGate({
            runner: failRunner,
            source: "correctness-reviewer",
        });
        expect(await gate(finderPayload())).not.toBeNull();
        const shrunk = finderPayload() as {findings: unknown[]};
        shrunk.findings = shrunk.findings.slice(0, 2);
        expect(await gate(shrunk)).not.toBeNull();
        const dropped = records.filter((r) => r.state === "skipped");
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toMatchObject({
            key: "f-2",
            attempt: 2,
            reason: "finding dropped by the author between attempts",
        });
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
        expect(artifact.model).toBe(PINNED_PROSE_JUDGE_MODEL);
    });
});

describe("buildJudgePrompt context fold", () => {
    const longProse =
        "The enrichment tool computes the offensive-terms signal on the " +
        "last user message only, so the baked metadata cannot reproduce " +
        "the packaged-summary behavior the loop cases exercised. The " +
        "validation arm therefore lands at the same rate either way.";

    it("judges a folding unit in its posted shape", () => {
        const prompt = buildJudgePrompt(
            longProse,
            "thought (non-blocking)",
            "The baked-metadata arm cannot reach the modeled rate.",
        );
        // Sliced to the MESSAGE block: the rubric text itself contains the
        // fold tags verbatim, so whole-prompt toContain proves nothing
        // (PR #401 round 3 caught exactly that).
        const message = prompt.slice(prompt.indexOf("MESSAGE:"));
        expect(message).toContain(
            "**thought (non-blocking):** The baked-metadata arm cannot reach the modeled rate.",
        );
        expect(message).toContain(
            "<details><summary><sub>context</sub></summary>",
        );
        expect(message).toContain(`${longProse}\n\n</details>`);
    });

    it("shows the judge the renderer's normalized visible line", () => {
        // renderContextFold appends the missing period, so the judge must
        // see the punctuated line: judging the raw subject would report a
        // shape that never posts.
        const prompt = buildJudgePrompt(
            longProse,
            "thought (non-blocking)",
            "The baked-metadata arm cannot reach the modeled rate",
        );
        const message = prompt.slice(prompt.indexOf("MESSAGE:"));
        expect(message).toContain(
            "**thought (non-blocking):** The baked-metadata arm cannot reach the modeled rate.",
        );
    });

    it("judges a short unit in the flat shape (no fold under the bar)", () => {
        const prompt = buildJudgePrompt(
            "Short claim.",
            "thought (non-blocking)",
            "Short claim.",
        );
        expect(prompt).toContain("**thought (non-blocking):** Short claim.");
        // The rubric text itself names the fold tags, so scope the
        // assertion to the MESSAGE block.
        const message = prompt.slice(prompt.indexOf("MESSAGE:"));
        expect(message).not.toContain("<details>");
    });
});

describe("extractProseUnits summary derivation", () => {
    it("prefers a schema finding's authored summary, falling back for blank or multi-line", () => {
        const units = extractProseUnits({
            findings: [
                {
                    id: "f-a",
                    severity: "advisory",
                    model_authored_prose: "First sentence. Second sentence.",
                    summary: "The authored one-liner.",
                },
                {
                    id: "f-b",
                    severity: "advisory",
                    model_authored_prose: "First sentence. Second sentence.",
                    summary: "two\nlines",
                },
                {
                    id: "f-c",
                    severity: "advisory",
                    model_authored_prose: "First sentence. Second sentence.",
                },
            ],
        });
        expect(units.map((unit) => unit.summary)).toEqual([
            "The authored one-liner.",
            "First sentence.",
            "First sentence.",
        ]);
    });

    it("skips a restating label-shape subject, like the renderer does", () => {
        // The restatement drop discards this subject from the posted body
        // (buildClaims falls back to the discussion's opening), so the
        // judge must not treat it as the visible line.
        const units = extractProseUnits({
            findings: [
                {
                    id: "f-r",
                    label: "thought (non-blocking)",
                    subject: "The merger drops flagged turns.",
                    discussion:
                        "Flagged turns are dropped by the merger. The retry path never re-adds them.",
                },
                {
                    id: "f-k",
                    label: "thought (non-blocking)",
                    subject: "A distinct authored subject.",
                    discussion:
                        "The discussion opens differently and carries the mechanism detail.",
                },
            ],
        });
        expect(units[0].summary).toBe(
            "Flagged turns are dropped by the merger.",
        );
        expect(units[1].summary).toBe("A distinct authored subject.");
    });
});

describe("createProseGate summary memo", () => {
    it("re-judges a finding whose summary alone changed", async () => {
        let calls = 0;
        const countingRunner = async () => {
            calls += 1;
            return JSON.stringify({pass: true, problems: []});
        };
        const {gate} = createProseGate({
            runner: countingRunner,
            source: "correctness-reviewer",
        });
        const payload = (summary: string) => ({
            findings: [
                {
                    id: "f-1",
                    severity: "advisory",
                    model_authored_prose: "First sentence. Second sentence.",
                    summary,
                },
            ],
        });
        expect(await gate(payload("Line one."))).toBeNull();
        expect(calls).toBe(1);
        // Same prose, new visible line: the memo must not swallow it.
        expect(await gate(payload("A different line."))).toBeNull();
        expect(calls).toBe(2);
        // Fully unchanged: memoized, no third judge call.
        expect(await gate(payload("A different line."))).toBeNull();
        expect(calls).toBe(2);
    });
});

describe("buildJudgePrompt unfolded distinct summary", () => {
    it("still judges an authored line that posts without a fold", () => {
        // corrected.subject posts via the collapsed list entries even when
        // the inline body is under the fold bar, so the judge must see it.
        const prompt = buildJudgePrompt(
            "The discussion is short.",
            "question (non-blocking)",
            "A distinct corrected subject.",
        );
        const message = prompt.slice(prompt.indexOf("MESSAGE:"));
        expect(message).toContain(
            "**question (non-blocking):** A distinct corrected subject.",
        );
        expect(message).toContain("The discussion is short.");
        expect(message).not.toContain("<details>");
    });
});
