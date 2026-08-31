import {describe, it, expect} from "vitest";

import {excerptOpeningComment} from "./rereview";

/**
 * The recap excerpt's quoting contract, split out of rereview.test.ts by
 * its max-lines budget (the submission-blocking-only precedent): the label
 * strip, the deterministic cap, and the structural-tag neutralization that
 * keeps a quoted `</details>` from closing the recap's collapsed block.
 */

describe("excerptOpeningComment", () => {
    it("strips the label prefix and keeps the first line", () => {
        expect(
            excerptOpeningComment(
                "**issue (blocking):** First line.\nSecond line.",
            ),
        ).toBe("First line.");
    });

    it("truncates deterministically past the cap", () => {
        const long = `**issue (blocking):** ${"a".repeat(300)}`;
        const excerpt = excerptOpeningComment(long);
        expect(excerpt.endsWith("...")).toBe(true);
        expect(excerpt.length).toBeLessThanOrEqual(123);
    });

    it("passes a label-less body through verbatim", () => {
        expect(excerptOpeningComment("No label here.")).toBe("No label here.");
    });

    it("strips the markdown-stripped plain label form too", () => {
        expect(
            excerptOpeningComment(
                "thought (non-blocking): The trim loop now counts.",
            ),
        ).toBe("The trim loop now counts.");
    });

    it("neutralizes a bare details tag, keeping a backticked one", () => {
        // The excerpt renders inside the recap's collapsed block, so a bare
        // </details> quoted from an old comment would close it early.
        expect(
            excerptOpeningComment(
                "**suggestion (non-blocking):** A bare </details> breaks out, a quoted `</details>` is safe.",
            ),
        ).toBe("A bare (/details) breaks out, a quoted `</details>` is safe.");
    });

    it("re-neutralizes when the cap severs a preserved code span", () => {
        // The full first line keeps the span (markdown surface), but the
        // cap cuts its closing backtick off: the sliced text has no span
        // anymore, so the tag must be rewritten, not left live.
        const severedSpan = `${"x".repeat(105)} \`</details> and\` tail`;
        const excerpt = excerptOpeningComment(severedSpan);
        expect(excerpt).toContain("(/details)");
        expect(excerpt).not.toContain("</details>");
        expect(excerpt.endsWith("...")).toBe(true);
    });

    it("drops a tag fragment when the cap severs the tag itself", () => {
        // A sliced "</detai" has no ">", so the tag regex cannot rewrite
        // it, and posted as-is the sanitizer's tag fold would match from
        // the fragment through the recap's own closing tag.
        const severedTag = `${"x".repeat(112)} \`</details>\` tail`;
        const excerpt = excerptOpeningComment(severedTag);
        expect(excerpt).not.toMatch(/<\/?[A-Za-z]/);
        expect(excerpt.endsWith("...")).toBe(true);
    });
});
