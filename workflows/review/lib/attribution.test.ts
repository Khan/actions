import {describe, it, expect} from "vitest";

import {
    renderAttributionFooter,
    renderCollapsedFooter,
    stripFooters,
} from "./attribution";

describe("renderCollapsedFooter", () => {
    it("wraps one <sub> line in the shared collapsed block", () => {
        expect(renderCollapsedFooter("schema 2")).toBe(
            "<details><summary><sub>review details</sub></summary>\n" +
                "<sub>schema 2</sub>\n" +
                "</details>",
        );
    });

    it("never emits an HTML comment (the sanitizer would delete it)", () => {
        expect(renderCollapsedFooter("x")).not.toContain("<!--");
    });
});

describe("renderAttributionFooter", () => {
    it("names the producing reviewer alone when nothing merged", () => {
        expect(renderAttributionFooter("correctness-reviewer")).toBe(
            renderCollapsedFooter("found by correctness-reviewer"),
        );
    });

    it("appends the merged copies with their differing anchors", () => {
        expect(
            renderAttributionFooter("correctness-reviewer", [
                {source: "completeness"},
                {source: "skill-auditor (out-of-lane)", line: 58},
            ]),
        ).toBe(
            renderCollapsedFooter(
                "found by correctness-reviewer | also flagged by " +
                    "completeness; skill-auditor (out-of-lane) (at line 58)",
            ),
        );
    });

    it("quotes a tier-2 copy's own subject (the ask the survivor may not restate)", () => {
        expect(
            renderAttributionFooter("correctness-reviewer", [
                {
                    source: "conventions",
                    subject: "Doc comment doesn't begin with the symbol name.",
                },
            ]),
        ).toBe(
            renderCollapsedFooter(
                "found by correctness-reviewer | also flagged by " +
                    "conventions: Doc comment doesn't begin with the symbol name.",
            ),
        );
    });

    it("escapes HTML in a merged copy's model-authored subject", () => {
        const footer = renderAttributionFooter("correctness-reviewer", [
            {
                source: "conventions",
                subject: "Unbalanced </details> & a <sub> tag.",
            },
        ]);
        expect(footer).not.toContain("Unbalanced </details>");
        expect(footer).toContain(
            "Unbalanced &lt;/details&gt; &amp; a &lt;sub&gt; tag.",
        );
        // The block still strips cleanly: the subject cannot close it early.
        expect(stripFooters(`prose\n${footer}`)).toBe("prose\n");
    });
});

describe("stripFooters", () => {
    it("removes the collapsed footer block from a posted body", () => {
        const body = `**issue (blocking):** The guard was removed.\n\n${renderAttributionFooter(
            "correctness-reviewer",
            [{source: "completeness"}],
        )}`;
        const stripped = stripFooters(body);
        expect(stripped).not.toContain("found by");
        expect(stripped).not.toContain("review details");
        expect(stripped).toContain("The guard was removed.");
    });

    it("tolerates round-tripped whitespace inside the block", () => {
        const body =
            "prose\n<details>\n <summary> <sub>review details</sub> </summary>\n<sub>found by x</sub>\n</details>";
        expect(stripFooters(body)).not.toContain("found by");
    });

    it("removes bare <sub> spans (version-footer lines, source tags)", () => {
        expect(
            stripFooters(
                "- `a.ts:2` issue (blocking): s <sub>(correctness-reviewer)</sub>",
            ),
        ).toBe("- `a.ts:2` issue (blocking): s ");
        expect(stripFooters("<sub>review-v1.13.0 | schema 2</sub>")).toBe("");
    });

    it("keeps a quoted <sub> span mid-prose (review content, not a footer)", () => {
        const body =
            "The strip targets <sub>spans</sub> quoted inside a sentence.";
        expect(stripFooters(body)).toBe(body);
        const backticked =
            "the footer renders `<sub>content</sub>` inside the block, then prose";
        expect(stripFooters(backticked)).toBe(backticked);
    });

    it("leaves other <details> blocks alone", () => {
        const section =
            "<details>\n<summary>Lower-confidence observations (2)</summary>\n\n- a\n\n</details>";
        expect(stripFooters(section)).toBe(section);
    });

    it("removes every footer when a body carries more than one", () => {
        const body = [
            renderAttributionFooter("a"),
            "prose",
            renderCollapsedFooter("review-v1 | schema 2"),
        ].join("\n");
        const stripped = stripFooters(body);
        expect(stripped).not.toContain("found by");
        expect(stripped).not.toContain("schema 2");
        expect(stripped).toContain("prose");
    });
});

describe("stripFooters context fold", () => {
    it("unwraps the fold's wrapper lines and keeps the prose inside", () => {
        const body = [
            "**thought (non-blocking):** The visible line.",
            "",
            "<details><summary><sub>context</sub></summary>",
            "",
            "The collapsed mechanism detail a dedup comparison must see.",
            "",
            "<sub>found by first-principles</sub>",
            "",
            "</details>",
        ].join("\n");
        const stripped = stripFooters(body);
        expect(stripped).toContain(
            "The collapsed mechanism detail a dedup comparison must see.",
        );
        expect(stripped).not.toContain("<details>");
        expect(stripped).not.toContain("</details>");
        expect(stripped).not.toContain("found by first-principles");
    });

    it("leaves the review body's observations section alone", () => {
        const section =
            "<details>\n<summary>Lower-confidence observations (2)</summary>\n\n- a\n\n</details>";
        expect(stripFooters(section)).toBe(section);
    });
});
