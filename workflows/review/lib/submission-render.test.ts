import {describe, it, expect} from "vitest";

import {
    isDropInSuggestion,
    labelAdmitsSketch,
    renderClaimComment,
} from "./submission";
import {COLLAPSED_ENTRY_RE, renderCollapsedLine} from "./submission-render";

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

    it("renders a drop-in suggestion as a committable fence even under a non-fix label", () => {
        // The label gate covers the sketch form only. A drop-in fence is the
        // fix itself, not restated prose, so it posts under any label (the
        // dispute-cap relabel to `question (non-blocking)` keeps it too).
        const body = renderClaimComment(
            claim({
                label: "question (non-blocking)",
                suggestion: "fixed()",
            }) as never,
        );
        expect(body).toContain("```suggestion\nfixed()\n```");
        expect(body).not.toContain("A sketch");
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

describe("renderClaimComment context fold", () => {
    // Long enough to clear CONTEXT_FOLD_MIN_CHARS, with a distinct subject.
    const longDiscussion =
        "The enrichment tool computes the offensive-terms signal on the " +
        "last user message only, so the baked metadata cannot reproduce " +
        "the packaged-summary behavior the loop cases exercised. The " +
        "validation arm therefore lands at the same rate either way.";
    const folded = (overrides: Record<string, unknown> = {}) =>
        claim({
            label: "thought (non-blocking)",
            subject: "The baked-metadata arm cannot reach the modeled rate.",
            discussion: longDiscussion,
            ...overrides,
        });

    it("posts the subject visible and the discussion collapsed", () => {
        const body = renderClaimComment(folded() as never);
        expect(body).toBe(
            [
                "**thought (non-blocking):** The baked-metadata arm cannot reach the modeled rate.",
                "",
                "<details><summary><sub>context</sub></summary>",
                "",
                longDiscussion,
                "",
                "</details>",
            ].join("\n"),
        );
    });

    it("keeps short discussions in today's shape (no fold under the bar)", () => {
        const body = renderClaimComment(
            claim({
                subject: "Short.",
                discussion: "Short but different.",
            }) as never,
        );
        expect(body).toBe("**issue (blocking):** Short but different.");
    });

    it("never folds when the discussion IS the subject", () => {
        const text = longDiscussion;
        const body = renderClaimComment(
            claim({subject: text, discussion: text}) as never,
        );
        expect(body).toBe(`**issue (blocking):** ${text}`);
    });

    it("keeps the committable fence outside the block, the sketch inside", () => {
        const withFence = renderClaimComment(
            folded({
                label: "suggestion (non-blocking)",
                suggestion: "fixed()",
            }) as never,
        );
        // Below the block (threadProse truncates at the first fence, so a
        // fence above it would hide the discussion from open-thread dedup),
        // with a blank line between so GitHub parses the fence as its own
        // markdown block rather than HTML-block continuation.
        expect(withFence).toContain("</details>\n\n```suggestion");

        const sketchSource = "if (x) {\n    guard();\n}\n".repeat(4);
        const withSketch = renderClaimComment(
            folded({
                label: "suggestion (non-blocking)",
                suggestion: sketchSource,
            }) as never,
        );
        const sketchAt = withSketch.indexOf(
            "A sketch, not a committable replacement:",
        );
        expect(sketchAt).toBeGreaterThan(withSketch.indexOf("<details>"));
        expect(sketchAt).toBeLessThan(withSketch.indexOf("</details>"));
    });

    it("separates fold blocks with blank lines (paragraphs, not soft wraps)", () => {
        const body = renderClaimComment(folded() as never, {
            source: "first-principles",
        });
        // The attribution line is its own paragraph inside the fold; a
        // single-newline join would soft-wrap it onto the prose.
        expect(body).toContain(
            `${longDiscussion}\n\n<sub>found by first-principles</sub>\n\n</details>`,
        );
    });

    it("puts the rule quote and attribution inside the fold", () => {
        const body = renderClaimComment(
            folded({rule_quote: "Always guard."}) as never,
            {source: "correctness-reviewer"},
        );
        const foldAt = body.indexOf("<details>");
        expect(body.indexOf("> **Rule:** Always guard.")).toBeGreaterThan(
            foldAt,
        );
        const attributionAt = body.indexOf(
            "<sub>found by correctness-reviewer</sub>",
        );
        expect(attributionAt).toBeGreaterThan(foldAt);
        expect(attributionAt).toBeLessThan(body.indexOf("</details>"));
        // Exactly one details block: attribution merged, not stacked.
        expect(body.match(/<details>/g)).toHaveLength(1);
    });

    it("appends the classic collapsed footer when the claim does not fold", () => {
        const body = renderClaimComment(claim() as never, {
            source: "correctness-reviewer",
        });
        expect(body).toBe(
            [
                "**issue (blocking):** The guard was removed.",
                "",
                "<details><summary><sub>review details</sub></summary>",
                "<sub>found by correctness-reviewer</sub>",
                "</details>",
            ].join("\n"),
        );
    });
});

describe("renderCollapsedLine", () => {
    it("neutralizes structural tags in the model-authored subject", () => {
        const line = renderCollapsedLine(
            claim({
                label: "suggestion (non-blocking)",
                subject:
                    "No test pins the blank line between </details> and the fence.",
            }) as never,
        );
        // A bare </details> in any entry closes the collapsed section at
        // that bullet (Khan/actions#401's re-review); the parenthesised
        // form posts inert. A backticked tag would pass through: code
        // spans are not parsed as HTML.
        expect(line).toBe(
            "- `a.ts:2` suggestion (non-blocking): No test pins the blank line between (/details) and the fence. <sub>(correctness-reviewer)</sub>",
        );
        // The neutralized entry still parses back off the posted body
        // (the autofix's body-sourced work list contract).
        const match = COLLAPSED_ENTRY_RE.exec(line.trim());
        expect(match?.[4]).toBe(
            "No test pins the blank line between (/details) and the fence.",
        );
    });
});
