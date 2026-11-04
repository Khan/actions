import {describe, expect, it} from "vitest";

import type {SafeOutputItem} from "./dispatch-gate";
import {
    describeFirstKeyDifference,
    submissionPlanViolations,
} from "./dispatch-gate-plan";

/**
 * Rule 7's inline-comment comparison, exercised directly. The Khan/mobile#4164
 * incident (run 40552518034) queued three comments byte-identical to the plan
 * except for the sanitizer's `<domain>` -> `(domain)` rewrite; the gate's
 * report said only "(3) do not match ... (3)".
 */

const PATH = "e2e/tests/onboarding.spec.ts";
const planBody =
    '**thought (non-blocking):** "See all <domain>" navigation is coupled to expanding an arbitrary unrelated subject group.';

const commentItem = (line: number, body: string): SafeOutputItem => ({
    type: "create_pull_request_review_comment",
    path: PATH,
    line,
    body,
});

const inlineViolations = (queued: SafeOutputItem[]) => {
    const submit: SafeOutputItem = {
        type: "submit_pull_request_review",
        event: "APPROVE",
        body: "Approved.",
    };
    return submissionPlanViolations({
        items: [submit, ...queued],
        submit,
        verdictEvent: "APPROVE",
        body: "Approved.",
        commentCount: queued.length,
        submissionPlan: {
            event: "APPROVE",
            body: "Approved.",
            comments: [
                {path: PATH, line: 12, body: "First note."},
                {path: PATH, line: 40, body: planBody},
            ],
        },
    }).filter((v) => v.dimension === "inline comments");
};

describe("rule 7 inline comments", () => {
    it("passes a sanitizer-converted `<domain>` placeholder", () => {
        expect(
            inlineViolations([
                commentItem(12, "First note."),
                commentItem(40, planBody.replace("<domain>", "(domain)")),
            ]),
        ).toEqual([]);
    });

    it("still blocks a real splice and names where it differs", () => {
        const spliced = planBody.replace(
            "arbitrary unrelated",
            "SPLICED orchestrator prose",
        );
        const violations = inlineViolations([
            commentItem(12, "First note."),
            commentItem(40, spliced),
        ]);
        expect(violations).toHaveLength(1);
        expect(violations[0].detail).toContain(`at ${PATH}:40:`);
        expect(violations[0].detail).toContain("arbitrary unrelated");
        expect(violations[0].detail).toContain("spliced orchestrator");
    });
});

describe("describeFirstKeyDifference", () => {
    it("names a missing queued entry as (none)", () => {
        expect(
            describeFirstKeyDifference(["a.ts:1:x", "b.ts:2:y"], ["a.ts:1:x"]),
        ).toBe('first difference at b.ts:2: plan "b.ts:2:y" vs queued (none)');
    });

    it("names an extra queued entry", () => {
        expect(describeFirstKeyDifference([], ["a.ts:1:x"])).toBe(
            'first difference at a.ts:1: plan (none) vs queued "a.ts:1:x"',
        );
    });

    it("elides context far from the first differing character", () => {
        const shared = "x".repeat(100);
        expect(
            describeFirstKeyDifference(
                [`a.ts:1:${shared}plan${shared}`],
                [`a.ts:1:${shared}queue${shared}`],
            ),
        ).toBe(
            `first difference at a.ts:1: plan "…${"x".repeat(
                40,
            )}plan${"x".repeat(36)}…" vs queued "…${"x".repeat(
                40,
            )}queue${"x".repeat(35)}…"`,
        );
    });
});
