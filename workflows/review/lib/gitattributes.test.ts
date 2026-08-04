import {describe, it, expect} from "vitest";

import {isGenerated, parseGitattributesGenerated} from "./router.ts";

/**
 * `.gitattributes` generated-file classification, split from router.test.ts by
 * concern and its max-lines budget (as credit-cap and lens-payloads are).
 *
 * What these pin is one semantic: git resolves an attribute per path by the LAST
 * matching line, so `linguist-generated` is not a set of "generated globs" but an
 * ordered list of verdicts. Reading it as any-match-wins silently skipped review
 * of paths a repo had deliberately un-marked, which is why the ordering cases
 * below are the point of the file rather than edge cases in it.
 */

describe("parseGitattributesGenerated", () => {
    it("keeps every rule that mentions the attribute, in file order", () => {
        const content = [
            "# comment",
            "",
            "dist/** linguist-generated=true",
            "vendor/** linguist-generated",
            "generated/keep.ts -linguist-generated",
            "src/*.ts text",
            "other/*.js linguist-generated=false",
            "third/*.js !linguist-generated",
        ].join("\n");
        // Negations are retained rather than dropped: isGenerated resolves per
        // path by last match, so a later `=false` has to be able to win. A line
        // that never mentions the attribute (`src/*.ts text`) is not a rule.
        expect(parseGitattributesGenerated(content)).toEqual([
            {pattern: "dist/**", generated: true},
            {pattern: "vendor/**", generated: true},
            {pattern: "generated/keep.ts", generated: false},
            {pattern: "other/*.js", generated: false},
            {pattern: "third/*.js", generated: false},
        ]);
    });
});

describe("isGenerated", () => {
    // Git resolves an attribute per path by LAST matching line. The reviewer read
    // it as "any matching =true line wins", which silently skipped review of paths
    // a repo had deliberately un-marked (observed in Khan/agent-settings, whose
    // .gitattributes marks `.claude/**` generated and then un-marks
    // `.claude/skills/**` so its skills stay visible and reviewable).
    const rules = parseGitattributesGenerated(
        [
            ".claude/** linguist-generated=true",
            ".claude/skills/** linguist-generated=false",
        ].join("\n"),
    );

    it("lets a later negation un-mark an earlier broad glob", () => {
        expect(isGenerated(".claude/hooks/git-filter.mjs", rules)).toBe(true);
        expect(isGenerated(".claude/skills/foo/SKILL.md", rules)).toBe(false);
    });

    it("keeps ordering load-bearing: reversing the lines reverses the answer", () => {
        const reversed = parseGitattributesGenerated(
            [
                ".claude/skills/** linguist-generated=false",
                ".claude/** linguist-generated=true",
            ].join("\n"),
        );
        expect(isGenerated(".claude/skills/foo/SKILL.md", reversed)).toBe(true);
    });

    it("treats a path no rule matches as source", () => {
        expect(isGenerated("src/index.ts", rules)).toBe(false);
    });

    // Git has three ways to spell "stop being generated", and each one shadows an
    // earlier `=true` by last match; verified against `git check-attr`, which
    // reports `.claude/skills/foo/SKILL.md` as unset / false / unspecified for
    // these three respectively, and `.claude/**` as true in all three. A form the
    // parser fails to recognise is not treated as a negation at all: its line is
    // dropped, the broad glob still wins, and the path is silently skipped. That
    // is the same failure this file exists to pin, so all three are covered.
    it.each([
        ["-linguist-generated", "unset"],
        ["linguist-generated=false", "false"],
        ["!linguist-generated", "unspecified"],
    ])("lets `%s` (git: %s) shadow an earlier =true glob", (negation) => {
        const withNegation = parseGitattributesGenerated(
            [
                ".claude/** linguist-generated=true",
                `.claude/skills/** ${negation}`,
            ].join("\n"),
        );
        expect(isGenerated(".claude/skills/foo/SKILL.md", withNegation)).toBe(
            false,
        );
        expect(isGenerated(".claude/hooks/git-filter.mjs", withNegation)).toBe(
            true,
        );
    });
});
