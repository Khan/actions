import {describe, it, expect} from "vitest";

import {
    isDropInSuggestion,
    labelAdmitsSketch,
    renderClaimComment,
} from "./submission";

/**
 * Claim-rendering tests, split out of submission.test.ts (max-lines): the
 * Conventional-Comment layout, the drop-in-vs-sketch classification, and the
 * fix-proposing-label gate on sketch blocks.
 */

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

describe("renderClaimComment", () => {
    it("renders the Conventional Comment with the post-validation label", () => {
        expect(
            renderClaimComment(
                claim({
                    label: "suggestion (non-blocking)",
                    suggestion: "fixed()",
                }) as never,
            ),
        ).toBe(
            "**suggestion (non-blocking):** The guard was removed.\n\n```suggestion\nfixed()\n```",
        );
    });

    it("keeps the rule quote as a blockquote between prose and fix", () => {
        const body = renderClaimComment(
            claim({rule_quote: "Always guard.\nEven here."}) as never,
        );
        expect(body).toContain("> **Rule:** Always guard.\n> Even here.");
    });

    it("keeps the suggestion fence for small code-shaped payloads", () => {
        // Run 29897276810's legitimate drop-ins: a one-line cutoff fix and a
        // five-line query chain.
        expect(
            isDropInSuggestion(
                "\tcutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
            ),
        ).toBe(true);
        expect(
            isDropInSuggestion(
                [
                    "\tq := datastore.NewQuery(models.AIGuideMemoryKind).",
                    '\t\tFilterField("kaid", "=", kaid).',
                    '\t\tFilterField("created_at", "<", cutoff).',
                    "\t\tKeysOnly().",
                    "\t\tLimit(500)",
                ].join("\n"),
            ),
        ).toBe(true);
    });

    it("treats prose that names code as prose (run 29901690493's fence misses)", () => {
        expect(
            isDropInSuggestion(
                "Use ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays), and add a test that writes a memory with created_at beyond the window and asserts it is deleted by the pass.",
            ),
        ).toBe(false);
        expect(
            isDropInSuggestion(
                "Filter by the retention cutoff at read time in Query; keep (or drop) the write-path delete as a storage-cost optimization only.",
            ),
        ).toBe(false);
    });

    it("renders an English-prose suggestion as a sketch, not a suggestion fence (r3628128268)", () => {
        const prose =
            "Add a created_at >= cutoff filter in Query so stale memories can never surface regardless of write activity, and consider a native Datastore TTL policy on created_at in place of (or alongside) the write-path ExpireStale pass.";
        expect(isDropInSuggestion(prose)).toBe(false);
        const body = renderClaimComment(
            claim({
                label: "suggestion (non-blocking)",
                suggestion: prose,
            }) as never,
        );
        expect(body).not.toContain("```suggestion");
        expect(body).toContain("A sketch, not a committable replacement:");
        expect(body).toContain(`\`\`\`\`\n${prose}\n\`\`\`\``);
    });

    it("renders an oversized code payload as a sketch (r3628128224's 30-line test fn)", () => {
        const testFn = [
            "func (suite *expirationSuite) TestExpirationRemovesStaleMemories() {",
            "\tctx := suite.KAContext()",
            ...Array.from(
                {length: 26},
                (_, i) => `\tsuite.Require().NoError(step${i}(ctx))`,
            ),
            "\tsuite.Require().Len(keys, 1)",
            "}",
        ].join("\n");
        expect(isDropInSuggestion(testFn)).toBe(false);
        const body = renderClaimComment(
            claim({label: "todo (blocking)", suggestion: testFn}) as never,
        );
        expect(body).not.toContain("```suggestion");
        expect(body).toContain("A sketch, not a committable replacement:");
    });

    const proseSketch =
        "Inventory the pre-flight modifiers for out-of-process side effects and either move them post-flight or gate them on the verdict.";

    it.each([
        "issue (blocking)",
        "issue (blocking, best-practice)",
        "suggestion (non-blocking)",
        "suggestion (non-blocking, best-practice)",
        "suggestion (non-blocking, documentation)",
    ])("keeps the sketch under the fix-proposing label %s", (label) => {
        const body = renderClaimComment(
            claim({label, suggestion: proseSketch}) as never,
        );
        expect(body).toContain("A sketch, not a committable replacement:");
        expect(body).toContain(proseSketch);
    });

    it.each([
        "question (non-blocking)",
        "thought (non-blocking)",
        "note (non-blocking)",
        "nitpick (non-blocking)",
    ])("drops the sketch under the non-fix label %s", (label) => {
        const body = renderClaimComment(
            claim({label, suggestion: proseSketch}) as never,
        );
        expect(body).not.toContain("A sketch");
        expect(body).not.toContain(proseSketch);
        // The prose and any rule quote are untouched; only the sketch goes.
        expect(body).toContain(`**${label}:**`);
    });

    it("renders a sketchless claim identically whatever the label", () => {
        const body = renderClaimComment(
            claim({label: "question (non-blocking)"}) as never,
        );
        expect(body).toBe(
            "**question (non-blocking):** The guard was removed.",
        );
    });

    it("matches on the base label token; an empty label stays eligible", () => {
        expect(labelAdmitsSketch("praise (non-blocking)")).toBe(false);
        expect(labelAdmitsSketch("")).toBe(true);
        expect(labelAdmitsSketch("issue")).toBe(true);
        expect(labelAdmitsSketch("Issue (blocking)")).toBe(true);
        expect(labelAdmitsSketch("todo (blocking)")).toBe(true);
    });
});
