/**
 * Live calibration for the prose judge (lib/judge-prose.ts) over the
 * Khan/webapp#41609 fixtures: real model, real prompts, the verdicts the
 * done-when requires. The unit tests pin the bounce mechanics with a
 * stubbed runner; THIS is where the model's judgment is asserted:
 *
 *   - the SPEC.md comment (3823429680, "Graduation removes the last runtime
 *     lever ... cheap insurance") MUST fail — it is the named complaint the
 *     judge exists for, and a rubric change that stops flagging it should
 *     break this script, not ship;
 *   - the pinned rule-2 fixture (3754335178, from the 2026-08-20 version
 *     audit's blind-judged sample) MUST fail: rule 2 (repetition) is
 *     calibrated on a real posted body, not only the 41609 rule-1 set;
 *     3768804982 rides along unpinned (the audit called it a fail, opus
 *     reads its bracket structure as summary-then-detail; the contested
 *     boundary stays visible without gating);
 *   - the other two 41609 fixtures print their verdicts unpinned (both are
 *     dense 100+-word non-blocking comments, so a rule 3 fail is plausible
 *     and fine; a pass is not a defect);
 *   - every failing fixture also prints its bounce message, because in
 *     production that text is the entire style spec the authoring agent
 *     sees at rewrite time (there is no rewrite call to eyeball anymore;
 *     the author rewrites in-session).
 *
 * Eval-side, so a raw fetch is correct here (the sandbox-proxy constraint in
 * judge-prose-runner.ts is a production concern; this runs on a dev machine
 * with `ANTHROPIC_API_KEY`). Same API shape as judge-live-model.ts.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx workflows/review/eval/judge-prose-live.ts
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {
    buildBounceMessage,
    buildJudgePrompt,
    parseJudgeVerdict,
    PINNED_PROSE_JUDGE_MODEL,
} from "../lib/judge-prose";
import {
    CLEAN_CONTROLS,
    FIXTURES_41609,
    FIXTURES_RULE2,
} from "../lib/judge-prose-fixtures";

const API_URL = "https://api.anthropic.com/v1/messages";

const callModel = async (prompt: string): Promise<string> => {
    const response = await fetch(API_URL, {
        method: "POST",
        headers: {
            "x-api-key": process.env["ANTHROPIC_API_KEY"] ?? "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: PINNED_PROSE_JUDGE_MODEL,
            max_tokens: 1024,
            messages: [{role: "user", content: prompt}],
        }),
    });
    if (!response.ok) {
        throw new Error(`API ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
        content?: {type?: string; text?: string}[];
    };
    return (payload.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
};

const main = async (): Promise<void> => {
    if ((process.env["ANTHROPIC_API_KEY"] ?? "") === "") {
        throw new Error("ANTHROPIC_API_KEY is required");
    }
    const missedPins: number[] = [];
    for (const fixture of [...FIXTURES_41609, ...FIXTURES_RULE2]) {
        const reply = await callModel(
            buildJudgePrompt(fixture.discussion, fixture.label),
        );
        const verdict = parseJudgeVerdict(reply);
        console.log(
            `\n=== ${fixture.commentId} (${fixture.label}, expected ${fixture.expected})`,
        );
        if (verdict === null) {
            console.log(`unparseable reply: ${reply}`);
            if (fixture.expected === "fail") {
                missedPins.push(fixture.commentId);
            }
            continue;
        }
        console.log(
            `verdict: ${verdict.pass ? "pass" : "FAIL"}${verdict.problems
                .map((problem) => `\n  - ${problem}`)
                .join("")}`,
        );
        if (fixture.expected === "fail" && verdict.pass) {
            missedPins.push(fixture.commentId);
        }
        if (!verdict.pass) {
            console.log(
                `bounce message the author would see:\n${buildBounceMessage([
                    {
                        key: `comment-${fixture.commentId}`,
                        problems: verdict.problems,
                    },
                ])}`,
            );
        }
    }
    // The clean controls: prose that should pass, printed as a canary for
    // over-flagging (a warning, never an exit code; a style judgment call
    // should not block a merge).
    for (const control of CLEAN_CONTROLS) {
        const verdict = parseJudgeVerdict(
            await callModel(
                buildJudgePrompt(control.discussion, control.label),
            ),
        );
        console.log(`\n=== clean control (${control.label})`);
        if (verdict === null) {
            console.log("unparseable reply");
        } else if (verdict.pass) {
            console.log("verdict: pass (as expected)");
        } else {
            console.log(
                `WARNING, over-flagging canary tripped: FAIL${verdict.problems
                    .map((problem) => `\n  - ${problem}`)
                    .join("")}`,
            );
        }
    }
    if (missedPins.length > 0) {
        throw new Error(
            `pinned fail fixtures passed the judge: ${missedPins.join(", ")} ` +
                "(3823429680 is the named 41609 complaint, rule 1; " +
                "3754335178 is the version audit's clean rule-2 fail)",
        );
    }
};

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
