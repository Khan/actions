import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The NOTIFIED half of the Guidance for reviewers idempotency key.
 *
 * Its own file rather than another block in submission.test.ts, which sits
 * within ten lines of the 1000-line max-lines budget: these cases pushed it
 * over, and the split that relieves that file lands later in the stack.
 *
 * What these pin: the submission CLI computes the NOTIFIED signature itself
 * instead of reading `notified.json`. That file does not exist yet when this
 * CLI runs (the notified CLI runs at Step 7, long after), so a read would
 * find nothing on every real run, the `notified:` component would always drop
 * out of the key, and a `.github/NOTIFIED`-only change would stage a key
 * identical to the prior run's — leaving Step 7 to read the guidance as
 * unchanged and never mention a newly-subscribed team. Neither case below
 * injects a signature; that is the point.
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
    };
};

const staged = (
    dispatchResult: Record<string, unknown>,
    extra: Record<string, string> = {},
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify(dispatchResult),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: dispatchResult["depth"] ?? "full",
        mode: "full",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
    ...extra,
});

describe("the NOTIFIED component of the risks/patterns key", () => {
    const KEY_PATH = `${REVIEW}/risks-patterns-key.txt`;
    const triaged = {
        claims: [],
        riskFiles: [
            {path: "a.ts", risk: "High"},
            {path: "b.ts", risk: "Medium"},
        ],
        patterns: ["bump-deps"],
        excludedFiles: ["gen.ts"],
    };

    const withNotified = (rules: string) =>
        makeFakeFs(
            staged(
                {depth: "full", ...triaged},
                {
                    ".github/NOTIFIED": ["[ON PULL REQUEST]", rules].join("\n"),
                    [`${REVIEW}/files.json`]: JSON.stringify([
                        {path: "a.ts"},
                        {path: "b.ts"},
                    ]),
                    [`${REVIEW}/full.diff`]: "",
                },
            ),
        );

    it("folds the signature in from the repo, without notified.json being staged first", () => {
        const fs = withNotified("infra: a.ts  @Org/team-infra");
        runSubmissionCli(fs, ".");
        // notified.json was NOT staged by this test; the key still carries
        // the component, which is only possible if the CLI computed it.
        expect(fs.files[KEY_PATH]).toContain("notified:");
        expect(fs.files[`${REVIEW}/notified.json`]).toBeDefined();
    });

    it("moves the key when only the NOTIFIED rules change", () => {
        // The assertion that fails when the signature is read from an
        // unstaged file: both keys come out identical and the re-post that
        // mentions the new team never fires.
        const before = withNotified("infra: a.ts  @Org/team-infra");
        runSubmissionCli(before, ".");
        const after = withNotified("infra: a.ts  @Org/team-platform");
        runSubmissionCli(after, ".");
        expect(after.files[KEY_PATH]).not.toBe(before.files[KEY_PATH]);
    });

    it("stages the pre-feature key when the repo has no .github/NOTIFIED", () => {
        const fs = makeFakeFs(
            staged(
                {depth: "full", ...triaged},
                {
                    [`${REVIEW}/files.json`]: JSON.stringify([{path: "a.ts"}]),
                    [`${REVIEW}/full.diff`]: "",
                },
            ),
        );
        runSubmissionCli(fs, ".");
        expect(fs.files[KEY_PATH]).not.toContain("notified:");
    });
});
