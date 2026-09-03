import {describe, it, expect} from "vitest";

import {
    computeHunkSignature,
    decideReReviewDepth,
    renderRereviewStamp,
    runRereviewPlanCli,
    STAMP_SCHEMA_VERSION,
} from "./rereview-mode";
import type {ReReviewStamp} from "./rereview-mode";

/**
 * A human's `/review <depth>` as a one-run dial position (split from
 * rereview-mode.test.ts by the max-lines budget). Under `re-review fast`
 * the bare `/review` is the only way to get anything reviewed on a re-push
 * and it always plans full; `/review scoped` asks for the whole roster over
 * the unseen hunks without paying for a full round. The token never skips
 * a guard, never shallows the configured dial (`flip-gated` and `fast`
 * license the reduced-depth dismissal of a standing block, so a repo that
 * did not configure them must not reach it by comment), and
 * automation-posted comments never carry one.
 */

const TWO_HUNK_DIFF = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " a",
    "+first hunk line",
    " b",
    "@@ -10,2 +11,3 @@",
    " c",
    "+second hunk line",
    " d",
].join("\n");

const CURRENT = computeHunkSignature(TWO_HUNK_DIFF);

const stampOf = (over: Partial<ReReviewStamp> = {}): ReReviewStamp => ({
    schemaVersion: STAMP_SCHEMA_VERSION,
    depth: "full",
    verdict: "APPROVE",
    anchorDraft: false,
    anchorHunks: CURRENT,
    ...over,
});

describe("decideReReviewDepth with a manual depth", () => {
    it("a manual request naming scoped plans scoped over a fast dial", () => {
        // `/review scoped`: the human wants the new hunks reviewed by the
        // whole roster without paying for a full round; the configured
        // mode stays fast for the pushes around it.
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: CURRENT}),
            currentSignature: CURRENT,
            manualRequest: true,
            manualDepth: "scoped",
        });
        expect(plan.depth).toBe("scoped");
        expect(plan.mode).toBe("fast");
        expect(plan.manualDepth).toBe("scoped");
        expect(plan.reasons).toEqual([
            "manual-review-request",
            "manual-depth-scoped",
        ]);
        expect(plan.dispatch).toBe("all");
        expect(plan.staging).toBe("new-hunks");
        // A scoped round advances the fingerprint like a dial-scoped one.
        expect(plan.stampHunks).toEqual(CURRENT);
    });

    it("a manual request naming full is the bare /review", () => {
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: CURRENT}),
            currentSignature: CURRENT,
            manualRequest: true,
            manualDepth: "full",
        });
        expect(plan.depth).toBe("full");
        expect(plan.reasons).toEqual(["manual-review-request"]);
        expect(plan.manualDepth).toBeUndefined();
    });

    it("a manual reduced depth still runs every guard", () => {
        const base = {
            mode: "fast" as const,
            isDraft: false,
            currentSignature: CURRENT,
            manualRequest: true,
            manualDepth: "scoped" as const,
        };
        // No anchor: nothing to scope against.
        expect(
            decideReReviewDepth({...base, priorStamp: null}).reasons,
        ).toEqual(["manual-review-request", "no-prior-fingerprint"]);
        // Draft-taken anchor on a ready PR.
        expect(
            decideReReviewDepth({
                ...base,
                priorStamp: stampOf({anchorDraft: true, anchorHunks: CURRENT}),
            }).reasons,
        ).toEqual(["manual-review-request", "ready-for-review-anchor"]);
        // Overflowed fingerprint.
        expect(
            decideReReviewDepth({
                ...base,
                priorStamp: stampOf({anchorHunks: "overflow"}),
            }).reasons,
        ).toEqual(["manual-review-request", "fingerprint-overflow"]);
        // Tripwire: nothing in the anchor matches the current diff.
        const tripped = decideReReviewDepth({
            ...base,
            priorStamp: stampOf({anchorHunks: {"other.ts": ["deadbeef"]}}),
        });
        expect(tripped.depth).toBe("full");
        expect(tripped.reasons).toEqual([
            "manual-review-request",
            "tripwire-divergence",
        ]);
        expect(tripped.tripwireRearmed).toBe(true);
        // The fallback still records the ask, so the artifact shows a human
        // asked for scoped and a guard answered with full.
        expect(tripped.manualDepth).toBe("scoped");
    });

    it("a manual depth below the configured dial plans the bare-/review full round", () => {
        // `/review fast` on a full-dial repo would otherwise run
        // reconcile-only over nothing and, with every blocking thread
        // resolved, clear a standing REQUEST_CHANGES by dismissal without
        // any pass over the new code. Anyone who can comment could do it.
        const anchored = stampOf({anchorHunks: CURRENT});
        for (const [mode, asked] of [
            ["full", "fast"],
            ["full", "flip-gated"],
            ["full", "scoped"],
            ["scoped", "fast"],
            ["scoped", "flip-gated"],
            ["flip-gated", "fast"],
        ] as const) {
            const plan = decideReReviewDepth({
                mode,
                isDraft: false,
                priorStamp: anchored,
                currentSignature: CURRENT,
                manualRequest: true,
                manualDepth: asked,
            });
            expect(plan.depth, `${asked} under ${mode}`).toBe("full");
            expect(plan.dispatch, `${asked} under ${mode}`).toBe("all");
            expect(plan.reasons, `${asked} under ${mode}`).toEqual([
                "manual-review-request",
                "manual-depth-below-dial",
            ]);
            // The ask is still recorded so the body can say what happened.
            expect(plan.manualDepth, `${asked} under ${mode}`).toBe(asked);
        }
    });

    it("a manual depth at or above the dial is honored", () => {
        const anchored = stampOf({anchorHunks: CURRENT});
        for (const [mode, asked] of [
            ["fast", "fast"],
            ["fast", "flip-gated"],
            ["fast", "scoped"],
            ["flip-gated", "flip-gated"],
            ["flip-gated", "scoped"],
            ["scoped", "scoped"],
        ] as const) {
            const plan = decideReReviewDepth({
                mode,
                isDraft: false,
                priorStamp: anchored,
                currentSignature: CURRENT,
                manualRequest: true,
                manualDepth: asked,
            });
            expect(plan.depth, `${asked} under ${mode}`).toBe(asked);
            expect(plan.reasons, `${asked} under ${mode}`).toEqual([
                "manual-review-request",
                `manual-depth-${asked}`,
            ]);
        }
    });

    it("a manual depth is ignored without a manual request", () => {
        // Automation-posted `/review scoped` (the CLI never sets manualDepth
        // in that case, but the decision must not depend on it).
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: CURRENT}),
            currentSignature: CURRENT,
            manualRequest: false,
            manualDepth: "scoped",
        });
        expect(plan.depth).toBe("fast");
        expect(plan.reasons).toEqual(["mode-fast"]);
        expect(plan.manualDepth).toBeUndefined();
    });
});

type FakeFs = {
    files: Map<string, string>;
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

const fakeFs = (seed: Record<string, string>): FakeFs => {
    const files = new Map(Object.entries(seed));
    return {
        files,
        readFileSync: (p) => {
            const content = files.get(p);
            if (content === undefined) {
                throw new Error(`ENOENT: ${p}`);
            }
            return content;
        },
        writeFileSync: (p, data) => void files.set(p, data),
        existsSync: (p) => files.has(p),
        mkdirSync: () => undefined,
    };
};

const REVIEW_DIR = "/tmp/gh-aw/review";
const EVENT_PATH = "/tmp/fake-event.json";

const stagedInputs = (
    over: Record<string, string> = {},
): Record<string, string> => ({
    [`${REVIEW_DIR}/full.diff`]: TWO_HUNK_DIFF,
    [`${REVIEW_DIR}/routing.json`]: JSON.stringify({reReviewMode: "fast"}),
    [`${REVIEW_DIR}/pr-context.json`]: JSON.stringify({isDraft: false}),
    [`${REVIEW_DIR}/prior-reviews.json`]: JSON.stringify([
        {
            body: renderRereviewStamp(stampOf({anchorHunks: CURRENT})),
            submittedAt: "2026-07-01T00:00:00Z",
        },
    ]),
    ...over,
});

/** The CLI under a pinned trigger (never the test runner's own event env). */
const planCli = (fs: FakeFs, eventName = "pull_request", eventPath?: string) =>
    runRereviewPlanCli(fs, eventName, eventPath);

/** An issue_comment event payload with the given author and body. */
const commentEvent = (login: string, type: string, body: string): string =>
    JSON.stringify({comment: {body, user: {login, type}}});

describe("runRereviewPlanCli with a /review <depth> comment", () => {
    it("plans scoped on a human /review scoped over a fast dial", () => {
        // Three hunks, one new since the anchor, same shape as the
        // dial-scoped staging test below: the manual ask must stage
        // scoped.diff the same way.
        const threeHunkDiff = [
            TWO_HUNK_DIFF,
            "@@ -20,2 +22,3 @@",
            " e",
            "+third hunk line",
            " f",
        ].join("\n");
        const fs = fakeFs({
            ...stagedInputs({
                [`${REVIEW_DIR}/full.diff`]: threeHunkDiff,
            }),
            [EVENT_PATH]: commentEvent("a-human", "User", "/review scoped\r\n"),
        });
        const {plan} = planCli(fs, "issue_comment", EVENT_PATH);
        expect(plan.mode).toBe("fast");
        expect(plan.depth).toBe("scoped");
        expect(plan.manualDepth).toBe("scoped");
        expect(plan.reasons).toEqual([
            "manual-review-request",
            "manual-depth-scoped",
        ]);
        const scoped = fs.files.get(`${REVIEW_DIR}/scoped.diff`);
        expect(scoped).toContain("third hunk line");
        expect(scoped).not.toContain("first hunk line");
        const written = JSON.parse(
            fs.files.get(`${REVIEW_DIR}/rereview-plan.json`) ?? "{}",
        );
        expect(written.manualDepth).toBe("scoped");
    });

    it("the scoped synonyms plan scoped too", () => {
        for (const word of ["delta", "diff", "diff-only"]) {
            const fs = fakeFs({
                ...stagedInputs(),
                [EVENT_PATH]: commentEvent(
                    "a-human",
                    "User",
                    `/review ${word}`,
                ),
            });
            const {plan} = planCli(fs, "issue_comment", EVENT_PATH);
            expect(plan.depth, word).toBe("scoped");
            expect(plan.manualDepth, word).toBe("scoped");
        }
    });

    it("a human /review fast on a full-dial repo plans full, ask recorded", () => {
        const fs = fakeFs({
            ...stagedInputs({
                [`${REVIEW_DIR}/routing.json`]: JSON.stringify({
                    reReviewMode: "full",
                }),
            }),
            [EVENT_PATH]: commentEvent("a-human", "User", "/review fast"),
        });
        const {plan} = planCli(fs, "issue_comment", EVENT_PATH);
        expect(plan.depth).toBe("full");
        expect(plan.dispatch).toBe("all");
        expect(plan.reasons).toEqual([
            "manual-review-request",
            "manual-depth-below-dial",
        ]);
        expect(plan.manualDepth).toBe("fast");
        expect(fs.files.has(`${REVIEW_DIR}/scoped.diff`)).toBe(false);
    });

    it("an unrecognized token after /review plans full", () => {
        const fs = fakeFs({
            ...stagedInputs(),
            [EVENT_PATH]: commentEvent("a-human", "User", "/review scope pls"),
        });
        const {plan} = planCli(fs, "issue_comment", EVENT_PATH);
        expect(plan.depth).toBe("full");
        expect(plan.reasons).toEqual(["manual-review-request"]);
    });

    it("a human /review scoped with a missing staging input plans full", () => {
        // The configured mode degrades to full when an input is missing;
        // the manual depth is held to the same rule rather than scoping a
        // round over an unstaged diff.
        const inputs = stagedInputs();
        delete inputs[`${REVIEW_DIR}/full.diff`];
        const fs = fakeFs({
            ...inputs,
            [EVENT_PATH]: commentEvent("a-human", "User", "/review scoped"),
        });
        const {plan, warnings} = planCli(fs, "issue_comment", EVENT_PATH);
        expect(warnings.length).toBeGreaterThan(0);
        expect(plan.depth).toBe("full");
        expect(plan.manualDepth).toBeUndefined();
    });

    it("an automation /review scoped follows the mode dial, token ignored", () => {
        const fs = fakeFs({
            ...stagedInputs(),
            [EVENT_PATH]: commentEvent(
                "khan-actions-bot",
                "User",
                "/review scoped",
            ),
        });
        const {plan} = planCli(fs, "issue_comment", EVENT_PATH);
        expect(plan.depth).toBe("fast");
        expect(plan.reasons).toEqual(["mode-fast"]);
        expect(plan.manualDepth).toBeUndefined();
    });
});
