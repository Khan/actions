import {describe, it, expect} from "vitest";

import {
    neutralizeStructuralTags,
    neutralizeThenEscape,
    renderAttributionFooter,
    renderCollapsedFooter,
    stripFooters,
} from "./attribution";

describe("neutralizeStructuralTags", () => {
    it("leaves a real code span verbatim", () => {
        expect(neutralizeStructuralTags("a `</details>` b")).toBe(
            "a `</details>` b",
        );
    });

    it("neutralizes a tag inside mismatched backtick runs", () => {
        // GFM forms a code span only when the opening and closing backtick
        // runs are the same length, so neither of these tags sits in one
        // and both must be rewritten (a naive backtick pairing would pass
        // them through live).
        expect(neutralizeStructuralTags("a `</details>`` b")).toBe(
            "a `(/details)`` b",
        );
        expect(neutralizeStructuralTags("``</details>` mismatched")).toBe(
            "``(/details)` mismatched",
        );
    });

    it("neutralizes open tags and attribute-carrying forms", () => {
        expect(neutralizeStructuralTags("<details open> and </summary>")).toBe(
            "(details open) and (/summary)",
        );
    });

    it("neutralizes entity-spelled tags, single or double encoded", () => {
        // The ingest sanitizer decodes `&lt;` AND `&amp;lt;` straight to
        // `<` in one pass, so both spellings post as live tags if left.
        expect(neutralizeStructuralTags("a &lt;/details&gt; b")).toBe(
            "a (/details) b",
        );
        expect(neutralizeStructuralTags("a &amp;lt;/details&amp;gt; b")).toBe(
            "a (/details) b",
        );
    });

    it("neutralizes numeric character references, decimal and hex", () => {
        // The sanitizer's decode covers `&#60;` and `&#x3c;` too, so a
        // numerically-spelled tag posts just as live as a named one.
        expect(neutralizeStructuralTags("a &#60;/details&#62; b")).toBe(
            "a (/details) b",
        );
        expect(neutralizeStructuralTags("a &#x3c;/details&#x3E; b")).toBe(
            "a (/details) b",
        );
        // A bare comparison stays untouched.
        expect(neutralizeStructuralTags("a<b")).toBe("a<b");
    });
});

describe("neutralizeThenEscape", () => {
    it("drops a non-details tag the cap severed", () => {
        // The pre-slice rewrite only touches details/summary, so another
        // tag straddling maxChars would leave a live `<x` fragment after
        // the sanitizer's decode; the fragment drop removes it.
        const capped = neutralizeThenEscape(
            `${"y".repeat(115)} <blockquote>tail`,
            120,
        );
        expect(capped).toBe(`${"y".repeat(115)}...`);
    });
});

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

    it("neutralizes structural tags in a merged copy's model-authored subject", () => {
        const footer = renderAttributionFooter("correctness-reviewer", [
            {
                source: "conventions",
                subject: "Unbalanced </details> & a <sub> tag.",
            },
        ]);
        expect(footer).not.toContain("Unbalanced </details>");
        // The details tag is parenthesised, not escaped: the ingest
        // sanitizer decodes entities, so `&lt;/details&gt;` would post as
        // the live tag and close the footer block early anyway. `<sub>`
        // only mis-styles text, so it keeps the escape-only treatment.
        expect(footer).toContain(
            "Unbalanced (/details) &amp; a &lt;sub&gt; tag.",
        );
        // The block still strips cleanly: the subject cannot close it early.
        expect(stripFooters(`prose\n${footer}`)).toBe("prose\n");
    });

    it("neutralizes a backticked tag in a merged copy's subject too", () => {
        const footer = renderAttributionFooter("correctness-reviewer", [
            {
                source: "conventions",
                subject: "The `</details>` guard skips the sketch.",
            },
        ]);
        // The footer's <sub> line is raw HTML (no preceding blank line),
        // so backticks render literally and form no code span: a
        // backticked tag there is live HTML and gets rewritten anyway.
        expect(footer).toContain("The `(/details)` guard");
        expect(footer).not.toContain("</details> guard");
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
