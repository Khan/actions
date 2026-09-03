import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The depth note's manual-ask variant (split from submission.test.ts by the
 * max-lines budget): when a human's `/review <depth>` set the dial for the
 * run, the note names it, since the configured mode alone would not explain
 * a scoped round under `fast`.
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

describe("the depth note under a manual /review <depth>", () => {
    it("names the /review depth in the depth note when a human set it", () => {
        // `/review scoped` under a fast dial: the configured mode alone
        // would not explain why this round ran scoped.
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "scoped",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "scoped",
                mode: "fast",
                manualDepth: "scoped",
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (requested by /review scoped, re-review mode fast).",
        );
    });

    it("omits the ask when the configured mode set the depth", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "scoped",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "scoped",
                mode: "scoped",
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (re-review mode scoped).",
        );
        expect(plan.body).not.toContain("requested by");
    });
});
