/**
 * Live calibration for the prose judge (lib/judge-prose.ts) over the
 * Khan/webapp#41609 fixtures: real model, real prompts, the verdicts the
 * done-when requires. The unit tests pin the pipeline mechanics with a
 * stubbed runner; THIS is where the model's judgment is asserted:
 *
 *   - the SPEC.md comment (3823429680, "Graduation removes the last runtime
 *     lever ... cheap insurance") MUST fail — it is the named complaint the
 *     judge exists for, and a rubric change that stops flagging it should
 *     break this script, not ship;
 *   - the other two fixtures print their verdicts unpinned (both are dense
 *     100+-word non-blocking comments, so a rule 3 fail is plausible and
 *     fine; a pass is not a defect);
 *   - every failing fixture also runs the constrained rewrite, printed for
 *     eyeball calibration of the shape contract.
 *
 * Eval-side, so a raw fetch is correct here (the sandbox-proxy constraint in
 * judge-prose-runner.ts is a production concern; this runs on a dev machine
 * with `ANTHROPIC_API_KEY`). Same API shape as judge-live-model.ts.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx workflows/review/eval/judge-prose-live.ts
 */

import type {Claim} from "../lib/dispatch-contracts";
import {
    buildJudgePrompt,
    buildRewritePrompt,
    parseJudgeVerdict,
    PINNED_PROSE_JUDGE_MODEL,
} from "../lib/judge-prose";
import {FIXTURES_41609} from "../lib/judge-prose-fixtures";
import {renderClaimComment} from "../lib/submission";

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
    let pinnedFailMissed = false;
    for (const fixture of FIXTURES_41609) {
        const claim: Claim = {
            id: `fixture-${fixture.commentId}`,
            source: "fixture",
            path: fixture.path,
            line: 1,
            label: fixture.label,
            subject: "",
            discussion: fixture.discussion,
            failure_scenario: "",
            confidence: 0.7,
        };
        const reply = await callModel(
            buildJudgePrompt(renderClaimComment(claim), claim.label),
        );
        const verdict = parseJudgeVerdict(reply);
        // eslint-disable-next-line no-console
        console.log(
            `\n=== ${fixture.commentId} (${fixture.label}, expected ${fixture.expected})`,
        );
        if (verdict === null) {
            // eslint-disable-next-line no-console
            console.log(`unparseable reply: ${reply}`);
            if (fixture.expected === "fail") {
                pinnedFailMissed = true;
            }
            continue;
        }
        // eslint-disable-next-line no-console
        console.log(
            `verdict: ${verdict.pass ? "pass" : "FAIL"}${verdict.problems
                .map((problem) => `\n  - ${problem}`)
                .join("")}`,
        );
        if (fixture.expected === "fail" && verdict.pass) {
            pinnedFailMissed = true;
        }
        if (!verdict.pass) {
            const rewrite = await callModel(
                buildRewritePrompt(
                    fixture.discussion,
                    fixture.label,
                    verdict.problems,
                ),
            );
            // eslint-disable-next-line no-console
            console.log(
                `rewrite (${rewrite.trim().length} chars):\n${rewrite.trim()}`,
            );
        }
    }
    if (pinnedFailMissed) {
        throw new Error(
            "the pinned fixture (3823429680, the named 41609 complaint) did not fail the judge",
        );
    }
};

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
