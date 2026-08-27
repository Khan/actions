import {describe, it, expect} from "vitest";

import {
    computeHunkSignature,
    computeUnreviewedChangedRuns,
    decideReReviewDepth,
    isRespondToReviewPush,
    renderRereviewStamp,
    RESPOND_TO_REVIEW_SLACK,
    runRereviewPlanCli,
    STAMP_SCHEMA_VERSION,
} from "./rereview-mode";
import type {
    HunkSignature,
    ReReviewStamp,
    ThreadAnchors,
} from "./rereview-mode";

/**
 * The respond-to-review drop: a scoped/flip-gated re-review whose every
 * unreviewed changed run answers an open thread runs at fast depth instead
 * (reconcile-only dispatch), the per-push counterpart of the mode dial.
 * Split from rereview-mode.test.ts for the shared eslint config's
 * 1000-line file cap.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Three one-line hunks in one file; new-side extents 1-3, 11-13, 22-24. */
const THREE_HUNK_DIFF = [
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
    "@@ -20,2 +22,3 @@",
    " e",
    "+third hunk line",
    " f",
].join("\n");

const FULL_SIGNATURE = computeHunkSignature(THREE_HUNK_DIFF);

/** The first two hunks reviewed; the third (extent 22-24) is new. */
const REVIEWED_FIRST_TWO: HunkSignature = {
    "src/handler.ts": FULL_SIGNATURE["src/handler.ts"].slice(0, 2),
};

const stampOf = (anchorHunks: HunkSignature): ReReviewStamp => ({
    schemaVersion: STAMP_SCHEMA_VERSION,
    depth: "full",
    verdict: "REQUEST_CHANGES",
    anchorDraft: false,
    anchorHunks,
});

/* -------------------------------------------------------------------------- */
/* computeUnreviewedChangedRuns                                               */
/* -------------------------------------------------------------------------- */

describe("computeUnreviewedChangedRuns", () => {
    it("returns the exact changed runs of the unreviewed hunks, no context", () => {
        expect(
            computeUnreviewedChangedRuns(THREE_HUNK_DIFF, REVIEWED_FIRST_TWO),
        ).toEqual([{path: "src/handler.ts", start: 23, end: 23}]);
        // Everything reviewed: nothing unreviewed.
        expect(
            computeUnreviewedChangedRuns(THREE_HUNK_DIFF, FULL_SIGNATURE),
        ).toEqual([]);
        // Nothing reviewed: one run per added line (never the hunks'
        // context-spanning extents 1-3, 11-13, 22-24).
        expect(computeUnreviewedChangedRuns(THREE_HUNK_DIFF, {})).toEqual([
            {path: "src/handler.ts", start: 2, end: 2},
            {path: "src/handler.ts", start: 12, end: 12},
            {path: "src/handler.ts", start: 23, end: 23},
        ]);
    });

    it("a hunk mixing two separate edits yields one run per edit", () => {
        // One hunk, a fix at new line 2 and fresh code at new line 9; the
        // hunk header's extent (1-10) would have merged them.
        const mixed = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,8 +1,10 @@",
            " a",
            "+fix line",
            " b",
            " c",
            " d",
            " e",
            " f",
            " g",
            "+fresh line",
            " h",
        ].join("\n");
        expect(computeUnreviewedChangedRuns(mixed, {})).toEqual([
            {path: "a.ts", start: 2, end: 2},
            {path: "a.ts", start: 9, end: 9},
        ]);
    });

    it("gives a deletion-only hunk its bracketing RIGHT-side lines", () => {
        const deletion = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -5,1 +4,0 @@",
            "-gone",
        ].join("\n");
        expect(computeUnreviewedChangedRuns(deletion, {})).toEqual([
            {path: "a.ts", start: 3, end: 4},
        ]);
    });

    it("merges a replacement's added and deletion-adjacent lines into one run", () => {
        const single = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -7 +7 @@",
            "-x",
            "+y",
        ].join("\n");
        expect(computeUnreviewedChangedRuns(single, {})).toEqual([
            {path: "a.ts", start: 6, end: 7},
        ]);
    });
});

/* -------------------------------------------------------------------------- */
/* isRespondToReviewPush                                                      */
/* -------------------------------------------------------------------------- */

describe("isRespondToReviewPush", () => {
    const range = {path: "a.ts", start: 10, end: 12};

    it("requires at least one anchor, then every run within slack of one", () => {
        expect(isRespondToReviewPush([range], {})).toBe(false);
        expect(isRespondToReviewPush([range], {"a.ts": [11]})).toBe(true);
        // Zero unreviewed runs with open threads: nothing new to review.
        expect(isRespondToReviewPush([], {"a.ts": [11]})).toBe(true);
    });

    it("matches within the slack window and not beyond it", () => {
        expect(
            isRespondToReviewPush([range], {
                "a.ts": [10 - RESPOND_TO_REVIEW_SLACK],
            }),
        ).toBe(true);
        expect(
            isRespondToReviewPush([range], {
                "a.ts": [12 + RESPOND_TO_REVIEW_SLACK],
            }),
        ).toBe(true);
        expect(
            isRespondToReviewPush([range], {
                "a.ts": [10 - RESPOND_TO_REVIEW_SLACK - 1],
            }),
        ).toBe(false);
        expect(
            isRespondToReviewPush([range], {
                "a.ts": [12 + RESPOND_TO_REVIEW_SLACK + 1],
            }),
        ).toBe(false);
    });

    it("never matches across files, and one unmatched run disqualifies the push", () => {
        expect(isRespondToReviewPush([range], {"b.ts": [11]})).toBe(false);
        expect(
            isRespondToReviewPush([range, {path: "a.ts", start: 90, end: 95}], {
                "a.ts": [11],
            }),
        ).toBe(false);
    });
});

/* -------------------------------------------------------------------------- */
/* decideReReviewDepth                                                        */
/* -------------------------------------------------------------------------- */

describe("decideReReviewDepth respond-to-review drop", () => {
    const anchors: ThreadAnchors = {"src/handler.ts": [23]};
    const base = {
        isDraft: false,
        priorStamp: stampOf(REVIEWED_FIRST_TWO),
        currentSignature: FULL_SIGNATURE,
        unreviewedChangedRuns: computeUnreviewedChangedRuns(
            THREE_HUNK_DIFF,
            REVIEWED_FIRST_TWO,
        ),
        openThreadAnchors: anchors,
    } as const;

    it("drops a scoped round to fast when every unreviewed run answers a thread", () => {
        const plan = decideReReviewDepth({...base, mode: "scoped"});
        expect(plan.depth).toBe("fast");
        expect(plan.dispatch).toBe("reconcile-only");
        expect(plan.staging).toBe("none");
        expect(plan.reasons).toEqual(["respond-to-review", "mode-scoped"]);
        // The anchor is carried forward verbatim, exactly like mode fast: a
        // reconcile-only round refreshes no fingerprint.
        expect(plan.stampHunks).toEqual(REVIEWED_FIRST_TWO);
        expect(plan.mode).toBe("scoped");
    });

    it("drops flip-gated the same way, and never touches full or fast modes", () => {
        expect(decideReReviewDepth({...base, mode: "flip-gated"}).depth).toBe(
            "fast",
        );
        const full = decideReReviewDepth({...base, mode: "full"});
        expect(full.depth).toBe("full");
        expect(full.reasons).toEqual(["mode-full"]);
        const fast = decideReReviewDepth({...base, mode: "fast"});
        expect(fast.depth).toBe("fast");
        expect(fast.reasons).toEqual(["mode-fast"]);
    });

    it("stays at the configured mode when a run matches no thread", () => {
        const plan = decideReReviewDepth({
            ...base,
            mode: "scoped",
            openThreadAnchors: {"src/handler.ts": [80]},
        });
        expect(plan.depth).toBe("scoped");
        expect(plan.reasons).toEqual(["mode-scoped"]);
    });

    it("stays at the configured mode when the inputs are not staged (older callers)", () => {
        const {unreviewedChangedRuns, openThreadAnchors, ...withoutInputs} =
            base;
        expect(unreviewedChangedRuns).toBeDefined();
        expect(openThreadAnchors).toBeDefined();
        const plan = decideReReviewDepth({...withoutInputs, mode: "scoped"});
        expect(plan.depth).toBe("scoped");
    });

    it("carries the anchor's draft flag forward on a drop, not the current one", () => {
        // The fixture's anchor has anchorDraft: false; making the current
        // push a draft distinguishes the carry-forward from taking the
        // run's own flag (a full plan stamps input.isDraft).
        const plan = decideReReviewDepth({
            ...base,
            mode: "scoped",
            isDraft: true,
        });
        expect(plan.depth).toBe("fast");
        expect(plan.stampAnchorDraft).toBe(false);
    });

    it("the divergence tripwire outranks the drop", () => {
        // Only one of three hunks reviewed: unreviewed share 2/3 re-arms
        // full even though both new hunks sit on thread lines. A divergent
        // push gets the whole roster, thread-shaped or not.
        const reviewedFirstOnly: HunkSignature = {
            "src/handler.ts": FULL_SIGNATURE["src/handler.ts"].slice(0, 1),
        };
        const plan = decideReReviewDepth({
            mode: "scoped",
            isDraft: false,
            priorStamp: stampOf(reviewedFirstOnly),
            currentSignature: FULL_SIGNATURE,
            unreviewedChangedRuns: computeUnreviewedChangedRuns(
                THREE_HUNK_DIFF,
                reviewedFirstOnly,
            ),
            openThreadAnchors: {"src/handler.ts": [12, 23]},
        });
        expect(plan.depth).toBe("full");
        expect(plan.tripwireRearmed).toBe(true);
    });
});

/* -------------------------------------------------------------------------- */
/* runRereviewPlanCli wiring                                                  */
/* -------------------------------------------------------------------------- */

type FakeFs = {
    files: Map<string, string>;
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

const fakeFs = (initial: Record<string, string>): FakeFs => {
    const files = new Map(Object.entries(initial));
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

const stagedRespond = (over: Record<string, string> = {}) => ({
    [`${REVIEW_DIR}/full.diff`]: THREE_HUNK_DIFF,
    [`${REVIEW_DIR}/routing.json`]: JSON.stringify({reReviewMode: "scoped"}),
    [`${REVIEW_DIR}/pr-context.json`]: JSON.stringify({isDraft: false}),
    [`${REVIEW_DIR}/prior-reviews.json`]: JSON.stringify([
        {body: renderRereviewStamp(stampOf(REVIEWED_FIRST_TWO))},
    ]),
    [`${REVIEW_DIR}/threads.json`]: JSON.stringify([
        {
            thread_id: "t1",
            path: "src/handler.ts",
            line: 23,
            comments: [{author: "github-actions[bot]", body: "b"}],
        },
    ]),
    [`${REVIEW_DIR}/human-threads.json`]: JSON.stringify([]),
    ...over,
});

describe("runRereviewPlanCli respond-to-review wiring", () => {
    it("stages a fast plan (no scoped.diff) when the new hunk answers a bot thread", () => {
        const fs = fakeFs(stagedRespond());
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("fast");
        expect(plan.reasons).toEqual(["respond-to-review", "mode-scoped"]);
        expect(fs.files.has(`${REVIEW_DIR}/scoped.diff`)).toBe(false);
        expect(
            JSON.parse(fs.files.get(`${REVIEW_DIR}/rereview-plan.json`) ?? "")
                .reasons,
        ).toEqual(["respond-to-review", "mode-scoped"]);
    });

    it("a human anchor counts for matching when a bot thread also exists", () => {
        // The bot thread anchors nothing near the new run; only the human
        // anchor (line 24) matches it. The drop still fires: the bot thread
        // gives the fast roster's reconciler its work.
        const fs = fakeFs(
            stagedRespond({
                [`${REVIEW_DIR}/threads.json`]: JSON.stringify([
                    {
                        thread_id: "t1",
                        path: "src/handler.ts",
                        line: 80,
                        comments: [],
                    },
                ]),
                [`${REVIEW_DIR}/human-threads.json`]: JSON.stringify([
                    {path: "src/handler.ts", line: 24},
                ]),
            }),
        );
        expect(runRereviewPlanCli(fs).plan.depth).toBe("fast");
    });

    it("human-only threads never drop: fast would dispatch an empty roster", () => {
        // dispatch.ts derives hasThreads from threads.json (bot threads)
        // alone, so a drop carried only by human anchors would dispatch no
        // finders and give the reconciler nothing to reconcile.
        const fs = fakeFs(
            stagedRespond({
                [`${REVIEW_DIR}/threads.json`]: JSON.stringify([]),
                [`${REVIEW_DIR}/human-threads.json`]: JSON.stringify([
                    {path: "src/handler.ts", line: 24},
                ]),
            }),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("scoped");
        expect(plan.reasons).toEqual(["mode-scoped"]);
    });

    it("fresh code in the same hunk as a thread fix keeps the mode", () => {
        // Three hunks, two reviewed (divergence 1/3, under the tripwire).
        // The unreviewed hunk's header extent (22-31) spans both edits: the
        // fix (new line 23) sits on the thread, the fresh code (new line
        // 30) is beyond slack. Extent-based matching would have dropped
        // this push to fast on the fix alone.
        const mixed = [
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
            "@@ -20,8 +22,10 @@",
            " e",
            "+fix line",
            " f",
            " g",
            " h",
            " i",
            " j",
            " k",
            "+fresh line",
            " l",
        ].join("\n");
        const mixedSignature = computeHunkSignature(mixed);
        const reviewedFirstTwo: HunkSignature = {
            "src/handler.ts": mixedSignature["src/handler.ts"].slice(0, 2),
        };
        const fs = fakeFs(
            stagedRespond({
                [`${REVIEW_DIR}/full.diff`]: mixed,
                [`${REVIEW_DIR}/prior-reviews.json`]: JSON.stringify([
                    {body: renderRereviewStamp(stampOf(reviewedFirstTwo))},
                ]),
                [`${REVIEW_DIR}/threads.json`]: JSON.stringify([
                    {
                        thread_id: "t1",
                        path: "src/handler.ts",
                        line: 23,
                        comments: [],
                    },
                ]),
            }),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("scoped");
        expect(plan.reasons).toEqual(["mode-scoped"]);
    });

    it("a line-less (outdated/file-level) thread anchors nothing", () => {
        const fs = fakeFs(
            stagedRespond({
                [`${REVIEW_DIR}/threads.json`]: JSON.stringify([
                    {
                        thread_id: "t1",
                        path: "src/handler.ts",
                        line: null,
                        comments: [],
                    },
                ]),
            }),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("scoped");
        expect(plan.reasons).toEqual(["mode-scoped"]);
    });

    it("stays scoped when no thread files are staged", () => {
        const files = stagedRespond();
        delete files[`${REVIEW_DIR}/threads.json`];
        delete files[`${REVIEW_DIR}/human-threads.json`];
        const {plan} = runRereviewPlanCli(fakeFs(files));
        expect(plan.depth).toBe("scoped");
    });

    it("stays scoped when the new hunk is away from every thread", () => {
        const fs = fakeFs(
            stagedRespond({
                [`${REVIEW_DIR}/threads.json`]: JSON.stringify([
                    {
                        thread_id: "t1",
                        path: "src/handler.ts",
                        line: 2,
                        comments: [],
                    },
                ]),
            }),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("scoped");
        // The scoped path still stages its diff.
        expect(fs.files.has(`${REVIEW_DIR}/scoped.diff`)).toBe(true);
    });
});
