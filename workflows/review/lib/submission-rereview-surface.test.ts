import {describe, it, expect} from "vitest";

import {runSubmissionCli, type SubmissionFs} from "./submission";

/**
 * The re-review posting surface after PRA-53: reduced-depth repeat reviews
 * post the FULL surface, same as a first review. The `blocking-only` and
 * `blocking-medium` modifiers are retired (scoped staging already bounds a
 * repeat round to new hunks; the budget, the nitpick ban, and the
 * confidence floor are the posting filters), so these cases replace
 * submission-blocking-only.test.ts: they pin that reduced depth changes
 * NOTHING about what posts, and that a leftover routing flag is inert.
 * The fixtures are small local copies of submission.test.ts's.
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
    routing: Record<string, unknown> = {},
): Record<string, string> => ({
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify(dispatchResult),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: dispatchResult["depth"] ?? "full",
        mode: "scoped",
        stampAnchorDraft: false,
        stampHunks: {},
    }),
    [`${REVIEW}/routing.json`]: JSON.stringify(routing),
});

describe("runSubmissionCli: the re-review posting surface (full, PRA-53)", () => {
    it("posts the full surface at reduced depth", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({
                        id: "blocking",
                        label: "issue (blocking)",
                        subject: "The guard was removed.",
                    }),
                    claim({
                        id: "sug",
                        line: 5,
                        label: "suggestion (non-blocking)",
                        confidence: 0.9,
                        subject: "Extract the helper.",
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
            }),
        );
        const plan = runSubmissionCli(fs);
        // Blocking and the budgeted non-blocking suggestion post inline;
        // the nitpick never posts inline (its own ban, not a re-review
        // rule) and collapses instead.
        expect(plan.comments).toHaveLength(2);
        expect(plan.comments.map((c) => c.body.split(":**")[0])).toEqual([
            "**issue (blocking)",
            "**suggestion (non-blocking)",
        ]);
        // The pr-level note folds into the body verbatim, exactly as on a
        // first review (the reduced-surface collapse bucket is gone).
        expect(plan.body).toContain(
            "**note (non-blocking):** The guard was removed.",
        );
        expect(plan.notes.join(" ")).toContain(
            "pr-level claim pr-note folded into the review body",
        );
        // The depth note names the depth and mode, no modifier suffix.
        expect(plan.body).toContain(
            "Note: re-review ran at scoped depth (re-review mode scoped).",
        );
        expect(plan.event).toBe("REQUEST_CHANGES");
    });

    it("a leftover reReviewBlockingOnly routing flag is inert", () => {
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
                {reReviewBlockingOnly: true, reReviewBlockingMedium: true},
            ),
        );
        expect(runSubmissionCli(fs).comments).toHaveLength(1);
    });

    it("keeps a pr-level BLOCKING claim as a body fold", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({
                        id: "pr-blocking",
                        path: undefined,
                        line: undefined,
                        label: "issue (blocking)",
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("REQUEST_CHANGES");
        expect(plan.body).toContain(
            "**issue (blocking):** The guard was removed.",
        );
    });

    it("caps inline comments at 20 and titles the overflow neutrally", () => {
        // 21 blocking claims: the 21st falls past MAX_INLINE_COMMENTS into
        // the collapse under the one remaining (neutral) section title.
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: Array.from({length: 21}, (_, i) =>
                    claim({
                        id: `blocking-${i}`,
                        line: i + 1,
                        label: "issue (blocking)",
                    }),
                ),
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.comments).toHaveLength(20);
        expect(plan.body).not.toContain("Non-blocking observations");
        expect(plan.body).toContain(
            "Lower-confidence observations (1; top: `a.ts:21` issue (blocking): s)",
        );
        expect(plan.notes.join(" ")).toContain(
            "1 claim(s) collapsed below the inline bar",
        );
        expect(plan.event).toBe("REQUEST_CHANGES");
    });

    it("a nitpick-only re-review approves with the nitpick collapsed", () => {
        const fs = makeFakeFs(
            staged({
                depth: "scoped",
                claims: [
                    claim({
                        id: "nit",
                        label: "nitpick (non-blocking)",
                        confidence: 0.9,
                        subject: "Rename the helper.",
                    }),
                ],
            }),
        );
        const plan = runSubmissionCli(fs);
        expect(plan.event).toBe("APPROVE");
        expect(plan.comments).toEqual([]);
        expect(plan.body).toContain(
            "Lower-confidence observations (1; top: `a.ts:2` nitpick (non-blocking): Rename the helper.)",
        );
        // A body carrying the collapsed section is never the bare approve
        // line, so the redundant-approval skip cannot swallow it.
        expect(plan.skipSubmission).toBe(false);
    });
});
