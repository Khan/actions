import {describe, it, expect} from "vitest";

import {renderCollapsedFooter, stripFooters} from "./attribution";
import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The review body's single tail fold. Split from
 * submission.test.ts by its max-lines budget; the fixtures are small local
 * copies of that file's helpers.
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (
    files: Record<string, string> = {},
): SubmissionFs & {files: Record<string, string>} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) =>
            p in state || Object.keys(state).some((f) => f.startsWith(`${p}/`)),
        mkdirSync: () => {},
        rmSync: (p: string) => {
            delete state[p];
        },
    };
};

const claim = (overrides: Record<string, unknown> = {}) => ({
    id: "c1",
    source: "correctness-reviewer",
    path: "a.ts",
    line: 2,
    label: "issue (blocking)",
    subject: "s",
    discussion: "The guard was removed.",
    failure_scenario: "f",
    confidence: 0.9,
    ...overrides,
});

const staged = (
    dispatchResult: Record<string, unknown>,
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify(dispatchResult),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: dispatchResult["depth"] ?? "full",
        mode: "full",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
});

/**
 * A prior APPROVE via the cache-memory carrier (posted bodies never keep
 * their stamp), which is what makes a redundant-approval skip legitimate.
 */
const priorApprove = (): Record<string, string> => ({
    [`${REVIEW}/pr-context.json`]: JSON.stringify({number: 41007}),
    "/tmp/gh-aw/cache-memory/pr-41007.json": JSON.stringify({
        verdict: "APPROVE",
        stampHunks: {"a.ts": ["deadbeef00000000"]},
        wasDraft: false,
    }),
});

/** A claim weak enough that the confidence floor collapses it into the fold. */
const weak = (overrides: Record<string, unknown> = {}) =>
    claim({
        id: "weak",
        label: "thought (non-blocking)",
        subject: "a hunch",
        confidence: 0.3,
        ...overrides,
    });

describe("the fold's content blocks the submission skips", () => {
    // Both skips compare the CORE body, which the observations list left
    // when the tail moved into the fold. Without the two
    // `!hasCollapsedSection` guards a body whose only content is the list
    // reads as empty, and the run withholds the observations on this push
    // and every later one.

    it("refuses the redundant-approval skip when only the fold carries content", () => {
        // Pins `bareApproveBody`: no inline comments, no notes, so the core
        // body IS the bare approve line and the guard is the only thing
        // standing between a real observation and a silent skip.
        const plan = runSubmissionCli(
            makeFakeFs({
                ...staged({depth: "full", claims: [weak()]}),
                ...priorApprove(),
            }),
        );
        expect(plan.event).toBe("APPROVE");
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain("**Lower-confidence observations (1):**");
        expect(plan.body).toContain("`a.ts:2` thought (non-blocking): a hunch");
        expect(plan.skipSubmission).toBe(false);
    });

    it("refuses the demoted-COMMENT skip when the fold carries observations", () => {
        // Pins `bodyCarriesOnlyDepthNote`: a fast round demotes its
        // would-be APPROVE, so the core body is head plus depth note and
        // can never equal the bare approve line — the emptiness signal is
        // this field alone, and the collapsed list is content it must see.
        const plan = runSubmissionCli(
            makeFakeFs({
                ...staged({depth: "fast", claims: [weak()]}),
                ...priorApprove(),
            }),
        );
        expect(plan.event).toBe("COMMENT");
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain("Note: ");
        expect(plan.body).toContain("**Lower-confidence observations (1):**");
        expect(plan.skipSubmission).toBe(false);
    });
});

describe("the review body's review-details fold", () => {
    it("carries exactly one top-level fold when observations, config, and fingerprint all render", () => {
        // The one-fold shape: the body used to end in three stacked
        // <details> blocks (observations, config footer, fingerprint), two
        // of them machine bookkeeping. Anything above the fold is review
        // content a human reads without clicking.
        const shed = (id: string, line: number) => ({
            id,
            source: "documentation",
            path: "lib/a.ts",
            line,
            label: "suggestion (non-blocking, documentation)",
            subject: `Observation ${line}.`,
            discussion: `Observation ${line}.`,
            failure_scenario: "f",
            confidence: 0.2,
        });
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [claim(), shed("s1", 11), shed("s2", 12)],
            }),
        );
        const body = runSubmissionCli(fs).body;
        expect(body.split("<details>").length - 1).toBe(1);
        expect(body.split("</details>").length - 1).toBe(1);
        const lines = body.split("\n");
        const foldAt = lines.indexOf(
            "<details><summary><sub>review details</sub></summary>",
        );
        expect(foldAt).toBeGreaterThan(0);
        // Order inside the fold: observations, config, fingerprint.
        const inside = lines.slice(foldAt + 1);
        expect(inside.filter((line) => line !== "")).toEqual([
            "**Lower-confidence observations (2):**",
            expect.stringContaining("`lib/a.ts:11`"),
            expect.stringContaining("`lib/a.ts:12`"),
            expect.stringMatching(/^<sub>.*schema \d+.*<\/sub>$/),
            expect.stringMatching(/^<sub>pr-reviewer:rereview .*<\/sub>$/),
            "</details>",
        ]);
        // The verdict head and the inline-comment pointer stay ABOVE it.
        expect(lines[0]).toContain("Changes requested");
        expect(body.indexOf("review details")).toBeGreaterThan(
            body.indexOf("Changes requested"),
        );
    });

    it("keeps one fold when a pr-level claim rides the body", () => {
        // The pr-level fold's attribution used to be a `renderCollapsedFooter`
        // block, whose chip is the same `review details` chip the tail fold
        // carries: two identically-labelled expandos in one body. It is a
        // bare `<sub>` line now, the shape the context fold
        // already uses for a folded inline comment.
        const fs = makeFakeFs(
            staged({
                depth: "full",
                claims: [
                    claim(),
                    claim({
                        id: "pr",
                        source: "skill-auditor",
                        path: undefined,
                        line: undefined,
                        label: "note (non-blocking)",
                        subject: "A cross-file observation.",
                        discussion: "A cross-file observation.",
                        confidence: 0.8,
                    }),
                ],
            }),
        );
        const body = runSubmissionCli(fs).body;
        expect(body).toContain("<sub>found by skill-auditor</sub>");
        expect(body.split("review details").length - 1).toBe(1);
        expect(body.split("<details>").length - 1).toBe(1);
        // And the bare line still drops out of the text-similarity input,
        // exactly as the collapsed footer block did.
        expect(stripFooters(body)).not.toContain("found by skill-auditor");
    });

    it("stripFooters keeps the fold's observations and drops only boilerplate", () => {
        // The footer strip used to delete any `review details` block
        // wholesale. The tail fold wears that same chip now, so a wildcard
        // interior would delete the observations with it — review content
        // the similarity comparison is built on.
        const fs = makeFakeFs(staged({depth: "full", claims: [weak()]}));
        const body = runSubmissionCli(fs).body;
        const stripped = stripFooters(body);
        expect(stripped).toContain("`a.ts:2` thought (non-blocking): a hunch");
        expect(stripped).toContain("Lower-confidence observations");
        // The bookkeeping `<sub>` lines inside the fold still go...
        expect(stripped).not.toContain("pr-reviewer:rereview");
        expect(stripped).not.toMatch(/<sub>review-v/);
        // ...and the STANDALONE wrapped footer (review.md Step 7's guidance
        // comment stages exactly this shape) is still removed entire.
        expect(
            stripFooters(
                [
                    "Body.",
                    renderCollapsedFooter("review-v1.24.0 | schema 2"),
                ].join("\n"),
            ).trim(),
        ).toBe("Body.");
    });
});
