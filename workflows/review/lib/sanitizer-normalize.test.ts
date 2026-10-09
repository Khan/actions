import {describe, expect, it} from "vitest";

import {createBodyNormalization} from "./sanitizer-normalize";

const normalizePlanned = (text: string): string =>
    createBodyNormalization().planned(text);
const normalizeQueued = (text: string): string =>
    createBodyNormalization().queued(text);

/**
 * Rule 7 compares the planned and queued roles separately, where
 * the queued side has been rewritten by gh-aw's ingest sanitizer and the plan
 * side has not. Each absorbed transform therefore gets a pair-style test:
 * the pre-sanitizer plan text and the post-sanitizer queued text must fold to
 * the same comparison form, while a genuine splice must not.
 */
describe("normalizeBody XML tag conversion", () => {
    it("folds an unknown tag the sanitizer parenthesised (incident shape)", () => {
        // kore-marketplace run 31609578203: the reviewer wrote a path
        // template in prose; the sanitizer rewrote the unknown `<skill>` to
        // `(skill)` and preserved the allowed `<p>`, and the gate blocked a
        // fully conforming review.
        const plan = "one level deep (plugins/<p>/skills/<skill>/SKILL.md)";
        const queued = "one level deep (plugins/<p>/skills/(skill)/SKILL.md)";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("folds closing and self-closing unknown tags", () => {
        expect(normalizePlanned("a <thing>x</thing> b <thing/> c")).toBe(
            normalizeQueued("a (thing)x(/thing) b (thing/) c"),
        );
    });

    it("folds unknown tags carrying attributes", () => {
        expect(normalizePlanned('see <custom attr="v"> here')).toBe(
            normalizeQueued('see (custom attr="v") here'),
        );
    });

    it("preserves allowed GFM tags on both sides", () => {
        const body = "wrap in <details><summary>more</summary></details>";
        expect(normalizePlanned(body)).toContain("<details>");
    });

    it("preserves an allowed tag carrying a safe attribute (`<details open>`)", () => {
        // The N=1 collapsed section is the first renderer output whose tag
        // carries an attribute. The real sanitizer preserves it verbatim:
        // its stripDangerousAttributes removes only on*/style/title/data-*
        // from allowed tags (sanitize_content_core.cjs v0.85.4, verified at
        // gh-aw-actions 2709137e), and `open` is none of those. The comparison
        // must agree, or rule 7 would red-flag every N=1 body.
        expect(
            normalizePlanned("x <details open><summary>1</summary> y"),
        ).toContain("<details open>");
    });

    it("still catches a splice that parenthesises a preserved allowed tag", () => {
        // The sanitizer preserves `<p>`, so a queued `(p)` cannot be the
        // sanitizer's work; the fold must not absorb it.
        expect(normalizePlanned("a <p> b")).not.toBe(
            normalizeQueued("a (p) b"),
        );
    });

    it("still catches a genuine content splice inside a folded tag", () => {
        expect(normalizePlanned("path <skill> end")).not.toBe(
            normalizeQueued("path (other) end"),
        );
    });

    it("folds a full-width tag the sanitizer NFKC-hardened before converting", () => {
        // hardenUnicodeText runs BEFORE convertXmlTags, so the sanitizer
        // only ever converts post-NFKC text; the comparison has to fold in the
        // same order or a compatibility-form tag mismatches.
        const plan = "path \uff1cskill\uff1e end"; // full-width < and >
        const queued = "path (skill) end";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("does not rewrite the URL folds' own placeholders", () => {
        // The URL folds rewrite links to `<url:host>` AFTER the tag fold
        // runs; a plan link and its host-redacted queued form must still
        // agree.
        const plan = "see https://example.com/deep/page for details";
        const queued = "see (example.com/redacted) for details";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
        expect(normalizePlanned(plan)).toContain("(example.com/redacted)");
    });
});

describe("normalizeBody URL folds (run 31616001094 incident shapes)", () => {
    it("folds a redacted https autolink without orphaning the angle brackets", () => {
        // The sanitizer's autolink pass consumes `<https://...>` as a unit;
        // comment-0 of the incident run staged the autolink and queued the
        // bracket-less redaction, and rule 7 blocked on the leftover `<`.
        const plan =
            'const body = "see <https://example.com/path> for details";';
        const queued = 'const body = "see (example.com/redacted) for details";';
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("preserves an allowed-domain autolink to the same placeholder on both sides", () => {
        // Allowed domains keep their angle-bracket form on the queued side;
        // both sides must fold that form, not just redacted ones.
        const body = "see <https://github.com/Khan/actions/pull/341> end";
        expect(normalizePlanned(body)).toContain("(github.com/redacted)");
        expect(normalizePlanned(body)).not.toContain("<<");
    });

    it("keeps a redacted autolink's slack label", () => {
        const plan = "see <https://example.com/path|the docs> end";
        const queued = "see (example.com/redacted)|the docs end";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("folds a protocol-relative URL created by the zero-width strip", () => {
        // comment-1 of the incident run staged `.replace(/\u034f/g, "")`;
        // the sanitizer's zero-width strip produced `//g`, which its
        // protocol-relative pass then redacted to `(g/redacted)`.
        const plan = 'x.replace(/\u034f/g, "")';
        const queued = 'x.replace((g/redacted), "")';
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("stops the https path fold at a comma, like the sanitizer", () => {
        const plan = "compare https://example.com/a,then prose";
        const queued = "compare (example.com/redacted),then prose";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("keeps the host when a non-https scheme URL is redacted", () => {
        // sanitizeUrlProtocols keeps the sanitized host: http://evil.com/x
        // becomes (evil.com/redacted), not a hostless (redacted).
        const plan = "fetches http://evil.com/payload here";
        const queued = "fetches (evil.com/redacted) here";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("applies the sanitizer's domain-name fold to redacted hosts", () => {
        // sanitizeDomainName strips non-alphanumerics per label, so a dashed
        // host redacts to its stripped form.
        const plan = "see https://my-host.com/x end";
        const queued = "see (myhost.com/redacted) end";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("still catches a cross-host autolink splice", () => {
        const plan = "see <https://one.example.com/path> end";
        const spliced = "see (two.example.com/redacted) end";
        expect(normalizePlanned(plan)).not.toBe(normalizeQueued(spliced));
    });
});

describe("normalizeBody code-region URL placeholders", () => {
    it.each(["`", "``", "```\n", "~~~~\n"])(
        "matches sanitized URLs inside %s regions",
        (fence) => {
            const close = fence.trim();
            const plan = `${fence}https://collector.attacker.example/c?d=<repo text>\n${close}`;
            const queued = `${fence}(collector.attacker.example/redacted) text>\n${close}`;
            expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
            expect(normalizePlanned(plan)).not.toBe(
                normalizeQueued(
                    queued.replace(
                        "collector.attacker.example",
                        "different.example",
                    ),
                ),
            );
        },
    );

    it("does not absorb changed trailing punctuation or prose", () => {
        const plan = "`https://collector.attacker.example/c?d=<repo text>`";
        expect(normalizePlanned(plan)).not.toBe(
            normalizeQueued("`(collector.attacker.example/redacted) text)`"),
        );
        expect(normalizePlanned(plan)).not.toBe(
            normalizeQueued("`(collector.attacker.example/redacted) changed>`"),
        );
    });

    it("keeps code tags distinct from prose tags and parenthesis splices", () => {
        expect(normalizePlanned("`<thing>` and <thing>")).toBe(
            "<thing> and (thing)",
        );
        expect(normalizePlanned("`<thing>`")).not.toBe(
            normalizeQueued("`(thing)`"),
        );
    });
});

describe("normalizeBody HTML entity decoding (run 32758584548 incident shape)", () => {
    it("matches a plan-side entity-escaped quote against its decoded queued form", () => {
        // The tag conversion applies to prose. In a matched code span the
        // pinned sanitizer decodes the entity but preserves the tag.
        const plan = "adds a &lt;STOP: run the merge&gt; pseudo-tag line";
        const queued = "adds a (STOP: run the merge) pseudo-tag line";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
    });

    it("preserves decoded tags inside matched code spans", () => {
        expect(normalizePlanned("`&lt;STOP: run the merge&gt;`")).toBe(
            normalizeQueued("`<STOP: run the merge>`"),
        );
        expect(normalizePlanned("`&lt;STOP: run the merge&gt;`")).not.toBe(
            normalizeQueued("`(STOP: run the merge)`"),
        );
    });

    it("decodes decimal, hex, and double-encoded forms like the sanitizer", () => {
        expect(normalizePlanned("at &#64;user and &#x40;org")).toBe(
            normalizeQueued("at @user and @org"),
        );
        expect(normalizePlanned("a &amp;gt; b &amp;amp; c")).toBe(
            normalizeQueued("a > b & c"),
        );
    });

    it("folds entity-spelled invisible characters to nothing, matching the strip", () => {
        // &shy; decodes to U+00AD, which the very next fold deletes; the
        // ordering mirrors hardenUnicodeText (decode step 2, strip step 3).
        expect(normalizePlanned("so&shy;ft hy&zwnj;phen")).toBe(
            normalizeQueued("soft hyphen"),
        );
    });

    it("leaves an out-of-range numeric entity alone, like the sanitizer", () => {
        expect(normalizePlanned("bad &#1114112; stays")).toBe(
            normalizeQueued("bad &#1114112; stays"),
        );
    });

    it("still catches an entity-vs-literal splice that changes the text", () => {
        expect(normalizePlanned("size &lt; 10")).not.toBe(
            normalizeQueued("size 100"),
        );
    });
});

describe("post-redaction code boundaries", () => {
    it("does not reinterpret queued tags after a URL swallows a closing tick", () => {
        const plan =
            "see `https://collector.attacker.example/x` and `<repo>` here";
        const queue =
            "see `(collector.attacker.example/redacted) and `<repo>` here";
        expect(normalizePlanned(plan)).toBe(normalizeQueued(queue));
        expect(normalizePlanned(plan)).not.toBe(
            normalizeQueued(queue.replace("<repo>", "(repo)")),
        );
        expect(normalizePlanned(plan)).not.toBe(
            normalizeQueued(
                queue.replace("collector.attacker.example", "other.example"),
            ),
        );
        expect(normalizePlanned(plan)).not.toBe(
            normalizeQueued(queue + " changed"),
        );
    });

    it("uses the upstream attribute, CDATA, and markdown-title transformations", () => {
        const pairs = [
            ['<p onclick="run()">text</p>', "<p>text</p>"],
            ["<![CDATA[text]]>", "(![CDATA[text]])"],
            [
                '[docs](https://github.com/Khan/actions "title")',
                "[docs (title)](https://github.com/Khan/actions)",
            ],
        ];
        for (const [plan, queued] of pairs) {
            expect(normalizePlanned(plan)).toBe(normalizeQueued(queued));
        }
    });
});
