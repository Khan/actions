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
});
