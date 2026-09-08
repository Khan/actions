import {describe, expect, it} from "vitest";

import {outsideCodeRegions} from "./sanitizer-code-regions";

const replace = (text: string): string =>
    outsideCodeRegions(text, (prose) => prose.replaceAll("x", "p"));

describe("sanitizer code-region boundaries", () => {
    it("transforms prose around exact-length inline delimiters", () => {
        expect(replace("x `x` x ``x `x` x`` x")).toBe("p `x` p ``x `x` x`` p");
    });

    it("treats unmatched inline ticks as prose and supports multiline spans", () => {
        expect(replace("x `x")).toBe("p `p");
        expect(replace("x `x\nx` x")).toBe("p `x\nx` p");
        expect(replace("`x ``x`` x")).toBe("`p ``x`` p");
    });

    it.each(["```", "~~~~"])(
        "preserves %s fences and transforms adjacent prose",
        (fence) => {
            expect(replace(`x\n  ${fence}js\nx\n${fence}${fence[0]}\nx`)).toBe(
                `p\n  ${fence}js\nx\n${fence}${fence[0]}\np`,
            );
        },
    );

    it("only closes a fence with matching characters, sufficient length, and no suffix", () => {
        const text = "x\n````js\nx\n~~~\nx\n```\nx\n```` suffix\nx\n````\nx";
        expect(replace(text)).toBe("p" + text.slice(1, -1) + "p");
    });

    it("preserves the rest of an unclosed fenced block", () => {
        expect(replace("x\n~~~\nx")).toBe("p\n~~~\nx");
    });
});
