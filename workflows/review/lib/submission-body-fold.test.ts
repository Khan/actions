import {describe, it, expect} from "vitest";

import {stripFooters} from "./attribution";
import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The review body's single tail fold (KORE-2632). Split from
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

describe("the review body's review-details fold", () => {
    it("carries exactly one top-level fold when observations, config, and fingerprint all render", () => {
        // The KORE-2632 shape: the body used to end in three stacked
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
        // bare `<sub>` line now (KORE-2632), the shape the context fold
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
});
