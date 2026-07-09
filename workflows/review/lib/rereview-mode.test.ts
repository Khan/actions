import {describe, it, expect} from "vitest";

import {
    buildScopedDiff,
    computeDivergence,
    computeHunkSignature,
    decideReReviewDepth,
    DEFAULT_TRIPWIRE_THRESHOLD,
    findLatestStamp,
    MAX_STAMP_HUNKS_B64_CHARS,
    parseRereviewStamp,
    renderRereviewStamp,
    runRereviewPlanCli,
    runRereviewStampCli,
    STAMP_SCHEMA_VERSION,
} from "./rereview-mode";
import type {HunkSignature, ReReviewStamp} from "./rereview-mode";

/* -------------------------------------------------------------------------- */
/* Diff fixtures                                                              */
/* -------------------------------------------------------------------------- */

/** A one-file, one-hunk diff with the given added line, at the given offset. */
const diffFor = (
    path: string,
    addedLine: string,
    startLine = 1,
): string =>
    [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -${startLine},2 +${startLine},3 @@`,
        " context",
        `+${addedLine}`,
        " more",
    ].join("\n");

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

/* -------------------------------------------------------------------------- */
/* Hunk signatures                                                            */
/* -------------------------------------------------------------------------- */

describe("computeHunkSignature", () => {
    it("hashes one entry per hunk, per file", () => {
        const signature = computeHunkSignature(TWO_HUNK_DIFF);
        expect(Object.keys(signature)).toEqual(["src/handler.ts"]);
        expect(signature["src/handler.ts"]).toHaveLength(2);
        expect(signature["src/handler.ts"][0]).not.toBe(
            signature["src/handler.ts"][1],
        );
    });

    it("is stable across rebases: shifted line numbers and context do not move the hash", () => {
        const before = diffFor("src/a.ts", "the same added line", 1);
        const rebased = [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -41,2 +41,3 @@",
            " completely different context",
            "+the same added line",
            " other surroundings",
        ].join("\n");
        expect(computeHunkSignature(before)).toEqual(
            computeHunkSignature(rebased),
        );
    });

    it("moves when added content changes", () => {
        expect(computeHunkSignature(diffFor("src/a.ts", "one"))).not.toEqual(
            computeHunkSignature(diffFor("src/a.ts", "two")),
        );
    });

    it("moves on a deletion-only change (removed lines are hashed too)", () => {
        const removalA = [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,3 +1,2 @@",
            " keep",
            "-drop the auth guard",
            " keep too",
        ].join("\n");
        const removalB = removalA.replace(
            "-drop the auth guard",
            "-drop a comment",
        );
        expect(computeHunkSignature(removalA)).not.toEqual(
            computeHunkSignature(removalB),
        );
    });

    it("trims trailing whitespace so CRLF or trailing-space churn does not move the hash", () => {
        const withTrailing = diffFor("src/a.ts", "line\t ");
        const clean = diffFor("src/a.ts", "line");
        expect(computeHunkSignature(withTrailing)).toEqual(
            computeHunkSignature(clean),
        );
    });
});

/* -------------------------------------------------------------------------- */
/* Divergence                                                                 */
/* -------------------------------------------------------------------------- */

describe("computeDivergence", () => {
    const current = computeHunkSignature(TWO_HUNK_DIFF);

    it("reports zero unreviewed when the fingerprint matches", () => {
        const d = computeDivergence(current, current);
        expect(d).toEqual({
            totalHunks: 2,
            unreviewedHunks: 0,
            unreviewedShare: 0,
        });
    });

    it("counts a path absent from the fingerprint as entirely unreviewed", () => {
        const d = computeDivergence(current, {});
        expect(d.unreviewedHunks).toBe(2);
        expect(d.unreviewedShare).toBe(1);
    });

    it("ignores fingerprint hunks that are gone from the current diff", () => {
        const reviewed: HunkSignature = {
            "src/handler.ts": [...current["src/handler.ts"], "deadbeef00000000"],
            "src/deleted.ts": ["cafecafe00000000"],
        };
        const d = computeDivergence(current, reviewed);
        expect(d).toEqual({
            totalHunks: 2,
            unreviewedHunks: 0,
            unreviewedShare: 0,
        });
    });

    it("returns share 0 for an empty current diff", () => {
        expect(computeDivergence({}, current).unreviewedShare).toBe(0);
    });
});

/* -------------------------------------------------------------------------- */
/* The stamp                                                                  */
/* -------------------------------------------------------------------------- */

const stampOf = (over: Partial<ReReviewStamp> = {}): ReReviewStamp => ({
    schemaVersion: STAMP_SCHEMA_VERSION,
    depth: "full",
    verdict: "APPROVE",
    anchorDraft: false,
    anchorHunks: computeHunkSignature(TWO_HUNK_DIFF),
    ...over,
});

describe("stamp render/parse", () => {
    it("round-trips through a review body", () => {
        const stamp = stampOf();
        const body = `Approved — no blocking issues found.\n\n${renderRereviewStamp(stamp)}`;
        expect(parseRereviewStamp(body)).toEqual(stamp);
    });

    it("round-trips a REQUEST_CHANGES verdict and a draft anchor", () => {
        const stamp = stampOf({
            depth: "scoped",
            verdict: "REQUEST_CHANGES",
            anchorDraft: true,
        });
        expect(parseRereviewStamp(renderRereviewStamp(stamp))).toEqual(stamp);
    });

    it("returns null on a body with no stamp", () => {
        expect(parseRereviewStamp("just an ordinary review body")).toBeNull();
    });

    it("returns null on an unknown schema version (future writer)", () => {
        const body = renderRereviewStamp(stampOf()).replace(" v=1 ", " v=2 ");
        expect(parseRereviewStamp(body)).toBeNull();
    });

    it("returns null when the fingerprint payload does not decode", () => {
        const body = renderRereviewStamp(stampOf()).replace(
            /hunks=\S+/,
            "hunks=!!!not-base64!!!",
        );
        expect(parseRereviewStamp(body)).toBeNull();
    });

    it("renders overflow when the signature exceeds the cap, and parses it back", () => {
        const huge: HunkSignature = {};
        for (let i = 0; i < 3000; i++) {
            huge[`src/file-${i}.ts`] = ["0123456789abcdef"];
        }
        const rendered = renderRereviewStamp(stampOf({anchorHunks: huge}));
        expect(rendered).toContain("hunks=overflow");
        expect(rendered.length).toBeLessThan(MAX_STAMP_HUNKS_B64_CHARS);
        expect(parseRereviewStamp(rendered)?.anchorHunks).toBe("overflow");
    });

    it("takes the last stamp when a body carries more than one", () => {
        const first = renderRereviewStamp(stampOf({depth: "full"}));
        const second = renderRereviewStamp(stampOf({depth: "fast"}));
        expect(parseRereviewStamp(`${first}\n${second}`)?.depth).toBe("fast");
    });
});

describe("findLatestStamp", () => {
    it("prefers the newest stamped review by submittedAt", () => {
        const older = renderRereviewStamp(stampOf({verdict: "REQUEST_CHANGES"}));
        const newer = renderRereviewStamp(stampOf({verdict: "APPROVE"}));
        const found = findLatestStamp([
            {body: newer, submittedAt: "2026-07-09T10:00:00Z"},
            {body: older, submittedAt: "2026-07-01T10:00:00Z"},
        ]);
        expect(found?.verdict).toBe("APPROVE");
    });

    it("skips stampless reviews (pre-dial history) and unstamped chatter", () => {
        const stamped = renderRereviewStamp(stampOf());
        const found = findLatestStamp([
            {body: stamped, submittedAt: "2026-07-01T10:00:00Z"},
            {body: "LGTM from a human", submittedAt: "2026-07-09T10:00:00Z"},
        ]);
        expect(found).not.toBeNull();
    });

    it("returns null when no review carries a stamp", () => {
        expect(findLatestStamp([{body: "Approved."}])).toBeNull();
    });
});

/* -------------------------------------------------------------------------- */
/* The depth decision                                                         */
/* -------------------------------------------------------------------------- */

const CURRENT = computeHunkSignature(TWO_HUNK_DIFF);

describe("decideReReviewDepth", () => {
    it("mode full always runs full", () => {
        const plan = decideReReviewDepth({
            mode: "full",
            isDraft: false,
            priorStamp: stampOf(),
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("full");
        expect(plan.reasons).toEqual(["mode-full"]);
        expect(plan.dispatch).toBe("all");
        expect(plan.staging).toBe("whole-diff");
    });

    it("no prior fingerprint runs full (first review, or pre-dial history)", () => {
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: null,
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("full");
        expect(plan.reasons).toEqual(["no-prior-fingerprint"]);
        expect(plan.stampHunks).toEqual(CURRENT);
    });

    it("a stamped COMMENTED review anchors normally; no full-forever loop", () => {
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({verdict: "COMMENT", anchorHunks: CURRENT}),
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("fast");
    });

    it("ready-for-review anchor: a draft-taken fingerprint forces one full ready review", () => {
        const plan = decideReReviewDepth({
            mode: "scoped",
            isDraft: false,
            priorStamp: stampOf({anchorDraft: true, anchorHunks: CURRENT}),
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("full");
        expect(plan.reasons).toEqual(["ready-for-review-anchor"]);
        // The fresh stamp anchors on the ready PR.
        expect(plan.stampAnchorDraft).toBe(false);
    });

    it("draft pushes may stay cheap against a draft-taken fingerprint", () => {
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: true,
            priorStamp: stampOf({anchorDraft: true, anchorHunks: CURRENT}),
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("fast");
        expect(plan.stampAnchorDraft).toBe(true);
    });

    it("an overflowed fingerprint forces full", () => {
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: "overflow"}),
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("full");
        expect(plan.reasons).toEqual(["fingerprint-overflow"]);
    });

    it("re-arms full when the unreviewed share crosses the threshold", () => {
        const plan = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: {}}),
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("full");
        expect(plan.tripwireRearmed).toBe(true);
        expect(plan.divergence?.unreviewedShare).toBe(1);
        // The tripped run stamps the current signature: the loop re-converges.
        expect(plan.stampHunks).toEqual(CURRENT);
    });

    it("stays cheap under the threshold and maps each mode to its shape", () => {
        const anchored = stampOf({anchorHunks: CURRENT});
        const base = {
            isDraft: false,
            priorStamp: anchored,
            currentSignature: CURRENT,
        } as const;

        const scoped = decideReReviewDepth({...base, mode: "scoped"});
        expect(scoped.depth).toBe("scoped");
        expect(scoped.dispatch).toBe("all");
        expect(scoped.staging).toBe("new-hunks");
        expect(scoped.flipGate).toBe(false);
        expect(scoped.stampHunks).toEqual(CURRENT);

        const flipGated = decideReReviewDepth({...base, mode: "flip-gated"});
        expect(flipGated.depth).toBe("flip-gated");
        expect(flipGated.dispatch).toBe("reconcile+correctness");
        expect(flipGated.staging).toBe("new-hunks");
        expect(flipGated.flipGate).toBe(true);

        const fast = decideReReviewDepth({...base, mode: "fast"});
        expect(fast.depth).toBe("fast");
        expect(fast.dispatch).toBe("reconcile-only");
        expect(fast.staging).toBe("none");
        expect(fast.flipGate).toBe(false);
    });

    it("fast and flip-gated carry the anchor fingerprint forward, so drift accumulates", () => {
        // Push 2: one of the two reviewed hunks still present, one new hunk.
        const drifted: HunkSignature = {
            "src/handler.ts": [
                CURRENT["src/handler.ts"][0],
                "aaaaaaaaaaaaaaaa",
            ],
        };
        const push2 = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: CURRENT}),
            currentSignature: drifted,
        });
        expect(push2.divergence?.unreviewedShare).toBe(0.5);
        expect(push2.depth).toBe("full"); // 0.5 >= 0.4: already re-armed
        expect(DEFAULT_TRIPWIRE_THRESHOLD).toBeLessThanOrEqual(0.5);

        // With a higher threshold the fast path carries the OLD anchor
        // forward; it does not launder the drifted push into the fingerprint.
        const carried = decideReReviewDepth({
            mode: "fast",
            isDraft: false,
            priorStamp: stampOf({anchorHunks: CURRENT}),
            currentSignature: drifted,
            tripwireThreshold: 0.9,
        });
        expect(carried.depth).toBe("fast");
        expect(carried.stampHunks).toEqual(CURRENT);
    });

    it("a dismissed approval's stamp still anchors (verdict lives in the stamp, not the state)", () => {
        // dismiss-stale-approvals rewrites state to DISMISSED; the reader
        // never sees state, only the body, so the fingerprint and the prior
        // verdict both survive.
        const dismissedBody = `Approved — no blocking issues found.\n${renderRereviewStamp(
            stampOf({verdict: "APPROVE", anchorHunks: CURRENT}),
        )}`;
        const stamp = findLatestStamp([{body: dismissedBody}]);
        expect(stamp?.verdict).toBe("APPROVE");
        const plan = decideReReviewDepth({
            mode: "flip-gated",
            isDraft: false,
            priorStamp: stamp,
            currentSignature: CURRENT,
        });
        expect(plan.depth).toBe("flip-gated");
    });
});

/* -------------------------------------------------------------------------- */
/* Scoped-diff staging                                                        */
/* -------------------------------------------------------------------------- */

describe("buildScopedDiff", () => {
    it("keeps only the hunks the fingerprint has not seen", () => {
        const reviewed: HunkSignature = {
            "src/handler.ts": [CURRENT["src/handler.ts"][0]],
        };
        const scoped = buildScopedDiff(TWO_HUNK_DIFF, reviewed);
        expect(scoped).toContain("second hunk line");
        expect(scoped).not.toContain("first hunk line");
        expect(scoped).toContain("diff --git a/src/handler.ts b/src/handler.ts");
    });

    it("drops files that are fully reviewed", () => {
        expect(buildScopedDiff(TWO_HUNK_DIFF, CURRENT)).toBe("");
    });

    it("keeps whole new files", () => {
        const scoped = buildScopedDiff(TWO_HUNK_DIFF, {});
        expect(scoped).toBe(TWO_HUNK_DIFF);
    });
});

/* -------------------------------------------------------------------------- */
/* CLI staging                                                                */
/* -------------------------------------------------------------------------- */

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

const stagedInputs = (over: Record<string, string> = {}): Record<string, string> => ({
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

describe("runRereviewPlanCli", () => {
    it("stages a fast plan when the fingerprint matches", () => {
        const fs = fakeFs(stagedInputs());
        const {plan, warnings} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("fast");
        expect(warnings).toEqual([]);
        expect(fs.files.has(`${REVIEW_DIR}/rereview-plan.json`)).toBe(true);
        expect(fs.files.has(`${REVIEW_DIR}/scoped.diff`)).toBe(false);
    });

    it("writes scoped.diff for a new-hunks plan", () => {
        // Three hunks, one of them new since the fingerprint: share 1/3 stays
        // under the tripwire threshold, so the scoped path actually runs.
        const threeHunkDiff = [
            TWO_HUNK_DIFF,
            "@@ -20,2 +22,3 @@",
            " e",
            "+third hunk line",
            " f",
        ].join("\n");
        const reviewedFirstTwo: HunkSignature = {
            "src/handler.ts": CURRENT["src/handler.ts"],
        };
        const fs = fakeFs(
            stagedInputs({
                [`${REVIEW_DIR}/full.diff`]: threeHunkDiff,
                [`${REVIEW_DIR}/routing.json`]: JSON.stringify({
                    reReviewMode: "scoped",
                }),
                [`${REVIEW_DIR}/prior-reviews.json`]: JSON.stringify([
                    {
                        body: renderRereviewStamp(
                            stampOf({anchorHunks: reviewedFirstTwo}),
                        ),
                    },
                ]),
            }),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("scoped");
        expect(plan.divergence?.unreviewedShare).toBeCloseTo(1 / 3);
        const scoped = fs.files.get(`${REVIEW_DIR}/scoped.diff`);
        expect(scoped).toContain("third hunk line");
        expect(scoped).not.toContain("first hunk line");
        expect(scoped).not.toContain("second hunk line");
    });

    it("prefers the generated-stripped diff so lockfile churn never counts as divergence", () => {
        // full.diff carries an extra (generated) file's hunk; the stripped
        // diff does not. The fingerprint must come from the stripped diff:
        // against an anchor over the same two source hunks, divergence is 0.
        const lockfileHunk = [
            "diff --git a/package-lock.json b/package-lock.json",
            "--- a/package-lock.json",
            "+++ b/package-lock.json",
            "@@ -1,2 +1,3 @@",
            ' "packages": {',
            '+  "left-pad": "2.0.0",',
            " }",
        ].join("\n");
        const fs = fakeFs(
            stagedInputs({
                [`${REVIEW_DIR}/full.diff`]: `${TWO_HUNK_DIFF}\n${lockfileHunk}`,
                [`${REVIEW_DIR}/full-stripped.diff`]: TWO_HUNK_DIFF,
            }),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.divergence?.unreviewedShare).toBe(0);
        expect(plan.depth).toBe("fast");
    });

    it("degrades every missing input to a full plan with a warning, never a crash", () => {
        const fs = fakeFs({});
        const {plan, warnings} = runRereviewPlanCli(fs);
        expect(plan.depth).toBe("full");
        expect(warnings.length).toBeGreaterThan(0);
    });

    it("degrades an unparseable routing.json to full", () => {
        const fs = fakeFs(
            stagedInputs({[`${REVIEW_DIR}/routing.json`]: "{not json"}),
        );
        const {plan} = runRereviewPlanCli(fs);
        expect(plan.mode).toBe("full");
    });
});

describe("runRereviewStampCli", () => {
    it("renders this run's stamp from the staged plan and the decided verdict", () => {
        const fs = fakeFs(stagedInputs());
        runRereviewPlanCli(fs);
        const stamp = runRereviewStampCli(fs, "APPROVE");
        expect(stamp).not.toBeNull();
        const parsed = parseRereviewStamp(stamp ?? "");
        expect(parsed?.depth).toBe("fast");
        expect(parsed?.verdict).toBe("APPROVE");
        // The fast run carried the anchor fingerprint forward verbatim.
        expect(parsed?.anchorHunks).toEqual(CURRENT);
    });

    it("returns null when no plan is staged", () => {
        expect(runRereviewStampCli(fakeFs({}), "APPROVE")).toBeNull();
    });
});
