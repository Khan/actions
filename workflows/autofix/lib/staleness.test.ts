import {describe, expect, it} from "vitest";

import {
    assessReviewCurrency,
    DEGRADED_NOTES,
    REFUSAL_REASONS,
} from "./staleness.ts";
import {
    computeHunkSignature,
    renderRereviewStamp,
    STAMP_SCHEMA_VERSION,
} from "../../review/lib/rereview-mode.ts";
import type {HunkSignature} from "../../review/lib/rereview-mode.ts";

const diffFor = (files: Record<string, string[]>): string =>
    Object.entries(files)
        .map(
            ([path, added]) =>
                `diff --git a/${path} b/${path}\n` +
                `--- a/${path}\n+++ b/${path}\n` +
                `@@ -1,1 +1,${added.length + 1} @@\n` +
                ` context\n` +
                added.map((line) => `+${line}`).join("\n") +
                `\n`,
        )
        .join("");

const stampedReview = (anchorHunks: HunkSignature | "overflow") => ({
    body:
        "Approved.\n\n" +
        renderRereviewStamp({
            schemaVersion: STAMP_SCHEMA_VERSION,
            depth: "full",
            verdict: "APPROVE",
            anchorDraft: false,
            anchorHunks,
        }),
    submittedAt: "2026-07-01T00:00:00Z",
});

describe("assessReviewCurrency", () => {
    it("refuses when no review has ever stamped the PR", () => {
        expect(assessReviewCurrency([], diffFor({"a.ts": ["x"]}))).toEqual({
            status: "no-review",
        });
    });

    it("degrades, not refuses, when a review carries no readable stamp", () => {
        // Khan/webapp#41130: the reviewer posted a correct blocking finding
        // under a body of exactly "Changes requested — see inline comments."
        // and no stamp. Reporting that as "no review" was wrong twice over:
        // wrong message, and a refusal on a PR that had real feedback.
        const result = assessReviewCurrency(
            [
                {
                    body: "Changes requested — see inline comments.",
                    submittedAt: "2026-07-01T00:00:00Z",
                },
            ],
            diffFor({"a.ts": ["x"]}),
        );
        expect(result).toEqual({status: "unverifiable", why: "unstamped"});
    });

    it("degrades when the fingerprint overflowed", () => {
        const result = assessReviewCurrency(
            [stampedReview("overflow")],
            diffFor({"a.ts": ["x"]}),
        );
        expect(result).toEqual({status: "unverifiable", why: "overflow"});
    });

    it("distinguishes no reviews at all from unstamped reviews", () => {
        expect(assessReviewCurrency([], diffFor({"a.ts": ["x"]})).status).toBe(
            "no-review",
        );
        expect(
            assessReviewCurrency(
                [{body: "anything", submittedAt: "2026-07-01T00:00:00Z"}],
                diffFor({"a.ts": ["x"]}),
            ).status,
        ).toBe("unverifiable");
    });

    it("reports current with no stale paths when the head matches the review", () => {
        const diff = diffFor({"a.ts": ["x"], "b.ts": ["y"]});
        const result = assessReviewCurrency(
            [stampedReview(computeHunkSignature(diff))],
            diff,
        );
        expect(result.status).toBe("current");
        if (result.status !== "current") {
            return;
        }
        expect(result.stalePaths).toEqual([]);
        expect(result.divergence.unreviewedHunks).toBe(0);
    });

    it("marks only the files that changed after the review", () => {
        // The common case the per-path guard exists for: the author pushed one
        // unrelated fix after the review, and findings in other files are
        // still perfectly actionable.
        const reviewed = diffFor({"a.ts": ["x"], "b.ts": ["y"]});
        const now = diffFor({"a.ts": ["x"], "b.ts": ["y CHANGED"]});
        const result = assessReviewCurrency(
            [stampedReview(computeHunkSignature(reviewed))],
            now,
        );
        expect(result.status).toBe("current");
        if (result.status !== "current") {
            return;
        }
        expect(result.stalePaths).toEqual(["b.ts"]);
        expect(result.divergence.unreviewedHunks).toBe(1);
    });

    it("marks a file the review never saw at all as stale", () => {
        const reviewed = diffFor({"a.ts": ["x"]});
        const now = diffFor({"a.ts": ["x"], "new.ts": ["z"]});
        const result = assessReviewCurrency(
            [stampedReview(computeHunkSignature(reviewed))],
            now,
        );
        if (result.status !== "current") {
            throw new Error("expected current");
        }
        expect(result.stalePaths).toEqual(["new.ts"]);
    });

    it("reads the most recent stamp when several reviews exist", () => {
        const older = diffFor({"a.ts": ["old"]});
        const current = diffFor({"a.ts": ["new"]});
        const result = assessReviewCurrency(
            [
                {...stampedReview(computeHunkSignature(older))},
                {
                    ...stampedReview(computeHunkSignature(current)),
                    submittedAt: "2026-07-02T00:00:00Z",
                },
            ],
            current,
        );
        if (result.status !== "current") {
            throw new Error("expected current");
        }
        expect(result.stalePaths).toEqual([]);
    });

    it("sorts stale paths so the plan artifact is stable", () => {
        const reviewed = diffFor({"a.ts": ["x"]});
        const now = diffFor({"z.ts": ["1"], "b.ts": ["2"], "a.ts": ["x"]});
        const result = assessReviewCurrency(
            [stampedReview(computeHunkSignature(reviewed))],
            now,
        );
        if (result.status !== "current") {
            throw new Error("expected current");
        }
        expect(result.stalePaths).toEqual(["b.ts", "z.ts"]);
    });

    it("is unaffected by a rebase that only moves the code", () => {
        // The signature hashes added-line content, so identical content at a
        // different offset is still "reviewed".
        const reviewed =
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n" +
            "@@ -1,1 +1,2 @@\n context\n+added line\n";
        const rebased =
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n" +
            "@@ -40,1 +40,2 @@\n context\n+added line\n";
        const result = assessReviewCurrency(
            [stampedReview(computeHunkSignature(reviewed))],
            rebased,
        );
        if (result.status !== "current") {
            throw new Error("expected current");
        }
        expect(result.stalePaths).toEqual([]);
    });
});

describe("REFUSAL_REASONS", () => {
    it("gives the author an action for each refusal", () => {
        for (const reason of Object.values(REFUSAL_REASONS)) {
            expect(reason.length).toBeGreaterThan(40);
        }
    });

    it("no longer claims there is no feedback when there is", () => {
        // The exact wording that misreported Khan/webapp#41130.
        expect(REFUSAL_REASONS["no-review"]).not.toContain(
            "no reviewer feedback has been posted",
        );
    });
});

describe("DEGRADED_NOTES", () => {
    it("names the weaker check for each degraded cause", () => {
        for (const note of Object.values(DEGRADED_NOTES)) {
            expect(note).toContain("thread anchors only");
        }
    });
});

describe("an unreadable diff must not read as a clean check", () => {
    const stamped = [
        stampedReview(computeHunkSignature(diffFor({"a.ts": ["x"]}))),
    ];

    it("degrades on an empty diff rather than reporting current", () => {
        // Khan/actions#298 review, blocking: computeHunkSignature("") is {},
        // the stale-path loop is vacuous, and the old code returned `current`
        // with no note. The guard would report a clean full check having
        // performed none.
        expect(assessReviewCurrency(stamped, "")).toEqual({
            status: "unverifiable",
            why: "unreadable-diff",
        });
    });

    it("degrades on a patch with no file headers", () => {
        // Raw `get_files` patches carry no diff --git/---/+++ headers, so
        // splitUnifiedDiff recognises no file section in them.
        const headerless = "@@ -1,1 +1,9 @@\n context\n+totally different";
        expect(assessReviewCurrency(stamped, headerless)).toEqual({
            status: "unverifiable",
            why: "unreadable-diff",
        });
    });
});
