import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The ROUTING `re-review <mode> blocking-only` modifier's posting surface,
 * in its own file for submission.test.ts's max-lines budget (the same split
 * submission-notified.test.ts made).
 *
 * What these pin: at a reduced executed depth with `routing.json`'s
 * `reReviewBlockingOnly` set, only blocking findings post inline; validated
 * non-blocking findings collapse to one line each in a body <details> block
 * (never riding an inline comment: the point of the dial is no non-blocking
 * noise on inline threads). The verdict counts every claim either way, and
 * the modifier never applies at full depth, so a first review, a
 * divergence-tripwire re-arm, and every degrade-to-full guard still post
 * everything. The fixtures are small local copies of submission.test.ts's.
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
    blockingOnly: boolean,
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify(dispatchResult),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: dispatchResult["depth"] ?? "full",
        mode: "scoped",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
    [`${REVIEW}/routing.json`]: JSON.stringify({
        reReviewBlockingOnly: blockingOnly,
    }),
});

describe("runSubmissionCli: re-review blocking-only", () => {
    it("collapses non-blocking claims into the body at reduced depth", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [
                        claim({
                            id: "blocking",
                            label: "issue (blocking)",
                            subject: "The guard was removed.",
                        }),
                        claim({
                            id: "nit",
                            line: 9,
                            label: "nitpick (non-blocking)",
                            confidence: 0.9,
                            subject: "Rename the helper.",
                        }),
                        claim({
                            id: "pr-note",
                            path: undefined,
                            line: undefined,
                            label: "note (non-blocking)",
                            subject: "A cross-file observation.",
                        }),
                    ],
                },
                true,
            ),
        );
        const plan = runSubmissionCli(fs);
        // Only the blocking claim posts inline, without the collapsed
        // section riding it: the section lives in the body. (The comment
        // still carries its own collapsed attribution footer.)
        expect(plan.comments).toHaveLength(1);
        expect(plan.comments[0].body).toContain("**issue (blocking):**");
        expect(plan.comments[0].body).not.toContain(
            "Non-blocking observations",
        );
        // The pr-level note outranks the nitpick for the summary slot
        // (nitpicks rank last; the collapsed list re-sorts with pr-level
        // claims included).
        expect(plan.body).toContain(
            "Non-blocking observations (2; top: note (non-blocking): A cross-file observation.)",
        );
        expect(plan.body).toContain(
            "- `a.ts:9` nitpick (non-blocking): Rename the helper. " +
                "<sub>(correctness-reviewer)</sub>",
        );
        expect(plan.body).toContain(
            "- note (non-blocking): A cross-file observation. " +
                "<sub>(correctness-reviewer)</sub>",
        );
        expect(plan.notes.join(" ")).toContain(
            "2 non-blocking claim(s) collapsed into the body (re-review blocking-only)",
        );
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (re-review mode scoped, blocking-only).",
        );
        // The blocking claim still decides the verdict.
        expect(plan.event).toBe("REQUEST_CHANGES");
    });

    it("keeps a pr-level BLOCKING claim as a body fold, not a collapse", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [
                        claim({
                            id: "pr-blocking",
                            path: undefined,
                            line: undefined,
                            label: "issue (blocking)",
                        }),
                    ],
                },
                true,
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(plan.body).toContain(
            "**issue (blocking):** The guard was removed.",
        );
        expect(plan.body).not.toContain("Non-blocking observations");
    });

    it("never applies at full depth (first review, tripwire re-arm)", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "full",
                    claims: [
                        claim({
                            id: "sug",
                            label: "suggestion (non-blocking)",
                            confidence: 0.9,
                        }),
                    ],
                },
                true,
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(1);
        expect(plan.body).not.toContain("Non-blocking observations");
    });

    it("posts non-blocking claims inline at reduced depth without the flag", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [
                        claim({
                            id: "sug",
                            label: "suggestion (non-blocking)",
                            confidence: 0.9,
                        }),
                    ],
                },
                false,
            ),
        );
        expect(runSubmissionCli(fs).comments).toHaveLength(1);
    });

    it("never labels cap-overflow blocking claims as non-blocking", () => {
        // 21 blocking claims: the 21st falls past MAX_INLINE_COMMENTS into
        // the collapse, so the section must use the neutral title, not
        // "Non-blocking observations".
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: Array.from({length: 21}, (_, i) =>
                        claim({
                            id: `blocking-${i}`,
                            line: i + 1,
                            label: "issue (blocking)",
                        }),
                    ),
                },
                true,
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(20);
        expect(plan.body).not.toContain("Non-blocking observations");
        expect(plan.body).toContain(
            "Lower-confidence observations (1; top: `a.ts:21` issue (blocking): s)",
        );
        expect(plan.body).toContain("issue (blocking)");
        expect(plan.notes.join(" ")).toContain(
            "1 claim(s) collapsed below the inline bar",
        );
        expect(plan.event).toBe("REQUEST_CHANGES");
    });

    it("an all-clear blocking-only re-review still approves with the note", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [
                        claim({
                            id: "nit",
                            label: "nitpick (non-blocking)",
                            confidence: 0.9,
                            subject: "Rename the helper.",
                        }),
                    ],
                },
                true,
            ),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("APPROVE");
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "Non-blocking observations (1; top: `a.ts:2` nitpick (non-blocking): Rename the helper.)",
        );
        // A body carrying the collapsed section is never the bare approve
        // line, so the redundant-approval skip cannot swallow it.
        expect(plan.skipSubmission).toBe(false);
    });
});

describe("the collapsed summary's pr-level arm", () => {
    it("names a pr-level top entry by label and subject (no anchor to show)", () => {
        const fs = makeFakeFs(
            staged(
                {
                    depth: "scoped",
                    claims: [
                        claim({
                            id: "pr-note",
                            path: undefined,
                            line: undefined,
                            label: "note (non-blocking)",
                            subject: "A cross-file observation.",
                        }),
                    ],
                },
                true,
            ),
        );
        expect(runSubmissionCli(fs).body).toContain(
            "Non-blocking observations (1; top: note (non-blocking): A cross-file observation.)",
        );
    });
});
