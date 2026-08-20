import {describe, expect, it} from "vitest";

import type {Claim} from "./dispatch-contracts";
import {
    buildJudgePrompt,
    buildRewritePrompt,
    judgeClaim,
    LABEL_RUBRIC_EXTRA,
    parseJudgeVerdict,
    PLAIN_PROSE_RUBRIC,
    runJudgeProseCli,
    VERDICTS_PATH,
    type JudgeFs,
    type ProseRunner,
} from "./judge-prose";
import {FIXTURES_41609} from "./judge-prose-fixtures";
import {renderClaimComment} from "./submission";

/**
 * The prose judge's mechanics, pinned with a stubbed runner: the model's
 * actual judgment lives in eval/judge-prose-live.ts (real calls over the
 * 41609 fixtures); everything here is the pipeline contract — four states,
 * rewrite-never-drop, fail-open on every error path, and the staged-file
 * round trip. The fixtures are the real Khan/webapp#41609 claims so the
 * prompts under test are the prompts production sends.
 */

const claimFromFixture = (index: number): Claim => {
    const fixture = FIXTURES_41609[index];
    return {
        id: `claim-${fixture.commentId}`,
        source: "correctness-reviewer",
        path: fixture.path,
        line: 7,
        label: fixture.label,
        subject: fixture.discussion.split(/(?<=[.!?])\s/, 1)[0] ?? "",
        discussion: fixture.discussion,
        failure_scenario: "n/a for a style fixture",
        confidence: 0.7,
    };
};

const passRunner: ProseRunner = () =>
    Promise.resolve('{"pass": true, "problems": []}');

const failThenRewriteRunner = (rewrite: string): ProseRunner => {
    let calls = 0;
    return () => {
        calls += 1;
        return Promise.resolve(
            calls === 1
                ? '{"pass": false, "problems": ["judge: metaphor, \\"last runtime lever\\""]}'
                : rewrite,
        );
    };
};

const memoryFs = (
    files: Record<string, string>,
): JudgeFs & {files: Record<string, string>} => ({
    files,
    existsSync: (path) => files[path] !== undefined,
    readFileSync: (path) => {
        const content = files[path];
        if (content === undefined) {
            throw new Error(`ENOENT: ${path}`);
        }
        return content;
    },
    writeFileSync: (path, data) => {
        files[path] = data;
    },
});

const DISPATCH_PATH = "/tmp/gh-aw/review/dispatch-result.json";

describe("buildJudgePrompt", () => {
    it("carries the verbatim rubric, the label extra, the label, and the rendered body", () => {
        const claim = claimFromFixture(2);
        const prompt = buildJudgePrompt(renderClaimComment(claim), claim.label);
        expect(prompt).toContain(PLAIN_PROSE_RUBRIC);
        expect(prompt).toContain(LABEL_RUBRIC_EXTRA);
        expect(prompt).toContain("LABEL: thought (non-blocking)");
        // The rendered view, not the bare field: the label wrapper is part
        // of what posts.
        expect(prompt).toContain(
            "**thought (non-blocking):** Graduation removes the last runtime lever",
        );
    });
});

describe("parseJudgeVerdict", () => {
    it("tolerates stray text around the JSON", () => {
        expect(
            parseJudgeVerdict(
                'Sure, here is my verdict:\n{"pass": false, "problems": ["judge: x"]}\nHope that helps!',
            ),
        ).toEqual({pass: false, problems: ["judge: x"]});
    });

    it("returns null (the error state) on non-JSON, non-boolean pass, or no braces", () => {
        expect(parseJudgeVerdict("I think it passes")).toBeNull();
        expect(parseJudgeVerdict('{"pass": "yes"}')).toBeNull();
        expect(parseJudgeVerdict("{not json}")).toBeNull();
    });

    it("drops non-string problem entries rather than crashing", () => {
        expect(
            parseJudgeVerdict('{"pass": false, "problems": ["a", 3, null]}'),
        ).toEqual({pass: false, problems: ["a"]});
    });
});

describe("judgeClaim", () => {
    it("passes a clean claim through untouched", async () => {
        const claim = claimFromFixture(0);
        const before = claim.discussion;
        const record = await judgeClaim(claim, passRunner);
        expect(record.state).toBe("pass");
        expect(record.rewritten).toBe(false);
        expect(claim.discussion).toBe(before);
    });

    it("rewrites discussion on a fail and touches nothing else", async () => {
        const claim = claimFromFixture(2);
        const rewrite =
            "Graduation deletes the moderation-ordering flag, so no runtime disable remains. The sibling CGC work kept global-cgc-enabled after its experiment. Was a short-lived kill switch considered?";
        const record = await judgeClaim(claim, failThenRewriteRunner(rewrite));
        expect(record.state).toBe("fail");
        expect(record.rewritten).toBe(true);
        expect(record.problems).toHaveLength(1);
        expect(claim.discussion).toBe(rewrite);
        expect(record.finalChars).toBe(rewrite.length);
        // The claim itself survives with every other field intact.
        expect(claim.label).toBe("thought (non-blocking)");
        expect(claim.path).toBe("services/ai-guide/moderation/spec/SPEC.md");
        expect(claim.confidence).toBe(0.7);
    });

    it("strips a parroted label prefix off the rewrite", async () => {
        const claim = claimFromFixture(2);
        const record = await judgeClaim(
            claim,
            failThenRewriteRunner(
                "**thought (non-blocking):** The flag is gone; no runtime disable remains.",
            ),
        );
        expect(record.rewritten).toBe(true);
        expect(claim.discussion).toBe(
            "The flag is gone; no runtime disable remains.",
        );
    });

    it("keeps the original when the judge call throws (fail-open)", async () => {
        const claim = claimFromFixture(2);
        const before = claim.discussion;
        const record = await judgeClaim(claim, () =>
            Promise.reject(new Error("proxy unreachable")),
        );
        expect(record.state).toBe("error");
        expect(record.error).toBe("proxy unreachable");
        expect(claim.discussion).toBe(before);
    });

    it("keeps the original when the verdict is unparseable", async () => {
        const claim = claimFromFixture(2);
        const before = claim.discussion;
        const record = await judgeClaim(claim, () =>
            Promise.resolve("the comment seems fine to me"),
        );
        expect(record.state).toBe("error");
        expect(record.error).toBe("unparseable judge reply");
        expect(claim.discussion).toBe(before);
    });

    it("keeps the original when the rewrite call throws", async () => {
        const claim = claimFromFixture(2);
        const before = claim.discussion;
        let calls = 0;
        const runner: ProseRunner = () => {
            calls += 1;
            return calls === 1
                ? Promise.resolve('{"pass": false, "problems": ["judge: x"]}')
                : Promise.reject(new Error("rewrite timed out"));
        };
        const record = await judgeClaim(claim, runner);
        expect(record.state).toBe("fail");
        expect(record.rewritten).toBe(false);
        expect(record.error).toBe("rewrite timed out");
        expect(claim.discussion).toBe(before);
    });

    it("refuses an empty or ballooned rewrite", async () => {
        const empty = claimFromFixture(2);
        const emptyBefore = empty.discussion;
        const emptyRecord = await judgeClaim(
            empty,
            failThenRewriteRunner("  "),
        );
        expect(emptyRecord.rewritten).toBe(false);
        expect(emptyRecord.error).toBe("empty rewrite reply");
        expect(empty.discussion).toBe(emptyBefore);

        const balloon = claimFromFixture(2);
        const balloonBefore = balloon.discussion;
        const balloonRecord = await judgeClaim(
            balloon,
            failThenRewriteRunner("x".repeat(balloonBefore.length * 2)),
        );
        expect(balloonRecord.rewritten).toBe(false);
        expect(balloonRecord.error).toBe(
            "rewrite longer than the original allows",
        );
        expect(balloon.discussion).toBe(balloonBefore);
    });

    it("skips an empty discussion without a model call", async () => {
        const claim = {...claimFromFixture(0), discussion: "  "};
        const record = await judgeClaim(claim, () =>
            Promise.reject(new Error("must not be called")),
        );
        expect(record.state).toBe("skipped");
    });
});

describe("runJudgeProseCli", () => {
    const stageDispatch = (claims: Claim[]): Record<string, string> => ({
        [DISPATCH_PATH]: JSON.stringify({
            claims,
            depth: "full",
            noteLines: ["Note: kept"],
        }),
    });

    it("judges every claim, counts four states, and never drops one", async () => {
        const claims = [0, 1, 2].map(claimFromFixture);
        const fs = memoryFs(stageDispatch(claims));
        let calls = 0;
        const runner: ProseRunner = () => {
            calls += 1;
            // claim 1: pass; claim 2: judge error; claim 3: fail + rewrite.
            if (calls === 1) {
                return Promise.resolve('{"pass": true, "problems": []}');
            }
            if (calls === 2) {
                return Promise.reject(new Error("overloaded"));
            }
            if (calls === 3) {
                return Promise.resolve(
                    '{"pass": false, "problems": ["judge: metaphor"]}',
                );
            }
            return Promise.resolve(
                "The flag is gone; was a switch considered?",
            );
        };
        const result = await runJudgeProseCli(fs, runner);
        expect(result.counts).toEqual({
            total: 3,
            skipped: 0,
            pass: 1,
            fail: 1,
            error: 1,
            rewritten: 1,
        });
        const staged = JSON.parse(fs.files[DISPATCH_PATH]) as {
            claims: Claim[];
            noteLines: string[];
            depth: string;
        };
        expect(staged.claims).toHaveLength(3);
        expect(staged.claims[2].discussion).toBe(
            "The flag is gone; was a switch considered?",
        );
        // The erroring claim posts its original prose.
        expect(staged.claims[1].discussion).toBe(FIXTURES_41609[1].discussion);
        // Sibling fields of the staged file survive the round trip.
        expect(staged.noteLines).toEqual(["Note: kept"]);
        expect(staged.depth).toBe("full");
    });

    it("stages the verdict artifact even when nothing was rewritten", async () => {
        const fs = memoryFs(stageDispatch([claimFromFixture(0)]));
        const before = fs.files[DISPATCH_PATH];
        await runJudgeProseCli(fs, passRunner);
        // No rewrite: the staged claims are byte-identical (no reformat churn).
        expect(fs.files[DISPATCH_PATH]).toBe(before);
        const artifact = JSON.parse(fs.files[VERDICTS_PATH]) as {
            counts: {pass: number};
            verdicts: {id: string; state: string}[];
        };
        expect(artifact.counts.pass).toBe(1);
        expect(artifact.verdicts[0].state).toBe("pass");
    });

    it("is a recorded no-op when staging is absent or unreadable", async () => {
        const absent = memoryFs({});
        const absentResult = await runJudgeProseCli(absent, passRunner);
        expect(absentResult.counts.total).toBe(0);
        expect(absent.files[VERDICTS_PATH]).toBeDefined();

        const corrupt = memoryFs({[DISPATCH_PATH]: "{not json"});
        const corruptResult = await runJudgeProseCli(corrupt, passRunner);
        expect(corruptResult.counts.total).toBe(0);
        // The corrupt staging is left for the plan CLI to report; the judge
        // never rewrites what it could not parse.
        expect(corrupt.files[DISPATCH_PATH]).toBe("{not json");
    });
});

describe("buildRewritePrompt", () => {
    it("carries the problems, the shape contract, and the original text", () => {
        const prompt = buildRewritePrompt(
            FIXTURES_41609[2].discussion,
            "thought (non-blocking)",
            ['judge: metaphor, "last runtime lever"'],
        );
        expect(prompt).toContain('- judge: metaphor, "last runtime lever"');
        expect(prompt).toContain(
            "at most one claim, one line of evidence, and at most one question",
        );
        expect(prompt).toContain("Graduation removes the last runtime lever");
    });
});
