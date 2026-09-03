import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The depth notes' manual-ask variants (depth-note.ts, split from
 * submission.test.ts by the max-lines budget): when a human's
 * `/review <depth>` set the dial for the run the reduced-depth note names
 * it, and when a guard or the below-dial rule answered the ask with full
 * the body says so with the reason code, so the human can tell the two
 * apart from a typo (which is never recorded and gets no note).
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

    it("a full round that a /review <depth> asked to reduce says why", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "full",
                mode: "fast",
                manualDepth: "scoped",
                reasons: ["manual-review-request", "no-prior-fingerprint"],
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).toContain(
            "Note: /review scoped was requested, this round ran at full depth (no-prior-fingerprint).",
        );
    });

    it("a below-dial ask reads the same way with its own reason", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "full",
                mode: "full",
                manualDepth: "fast",
                reasons: ["manual-review-request", "manual-depth-below-dial"],
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).toContain(
            "Note: /review fast was requested, this round ran at full depth (manual-depth-below-dial).",
        );
    });

    it("a bare /review full round carries no manual note", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "full",
                mode: "fast",
                reasons: ["manual-review-request"],
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).not.toContain("was requested");
    });

    it("a manualDepth that is not a mode renders nothing", () => {
        // The plan file lives in an agent-writable directory: only one of
        // the four modes may reach the posted body.
        const fs = makeFakeFs({
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "scoped",
                claims: [],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "scoped",
                mode: "scoped",
                manualDepth: "scoped, see https://evil.example",
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        });
        const plan = runSubmissionCli(fs);
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (re-review mode scoped).",
        );
        expect(plan.body).not.toContain("evil.example");
    });
});
