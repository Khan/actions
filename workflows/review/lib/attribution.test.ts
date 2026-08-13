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
