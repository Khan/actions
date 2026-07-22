import {describe, it, expect} from "vitest";

import {extractJsonObject} from "./extract-json";

describe("extractJsonObject", () => {
    it("parses a bare JSON object", () => {
        expect(
            extractJsonObject('{"verdict": "good", "quality": 0.9}'),
        ).toEqual({verdict: "good", quality: 0.9});
    });

    it("parses an object wrapped in prose and code fences", () => {
        const text = 'Here you go:\n```json\n{"findings": []}\n```\nDone.';
        expect(extractJsonObject(text)).toEqual({findings: []});
    });

    it("survives template-literal braces quoted before the payload (the incident-cache-missing-key failure)", () => {
        const text =
            "The key `user-profile:${tenantId}:${userId}` dropped the" +
            ' tenant. {"findings": [{"path": "src/cache/user-profile.ts"}]}';
        expect(extractJsonObject(text)).toEqual({
            findings: [{path: "src/cache/user-profile.ts"}],
        });
    });

    it("repairs an invalid string escape (the judge bad-escape failure)", () => {
        const text = '{"verdict": "bad", "rationale": "don\\\'t cache this"}';
        expect(extractJsonObject(text)).toEqual({
            verdict: "bad",
            rationale: "don't cache this",
        });
    });

    it("leaves valid escapes untouched while repairing invalid ones", () => {
        const text = '{"a": "line\\nbreak \\\\ \\"q\\" \\u0041 bad\\_one"}';
        expect(extractJsonObject(text)).toEqual({
            a: 'line\nbreak \\ "q" A bad_one',
        });
    });

    it("does not misread the second half of a valid double backslash while repairing", () => {
        // Raw slice: {"a": "\\b \'"}. The bad \' forces the repair pass,
        // which must consume \\ as one valid escape and not re-read its
        // second backslash as escaping the b (that would silently turn a
        // literal backslash-b into a backspace).
        const text = '{"a": "\\\\b \\\'"}';
        expect(extractJsonObject(text)).toEqual({a: "\\b '"});
    });

    it("prefers the last top-level object (the payload agents end with)", () => {
        const text =
            'The config {"retries": 0} disables retries entirely.' +
            ' {"findings": [], "files": []}';
        expect(extractJsonObject(text)).toEqual({findings: [], files: []});
    });

    it("returns a whole payload, not its trailing nested object", () => {
        const text = '{"findings": [{"id": "f1"}], "meta": {"n": 1}}';
        expect(extractJsonObject(text)).toEqual({
            findings: [{id: "f1"}],
            meta: {n: 1},
        });
    });

    it("handles braces inside JSON strings", () => {
        const text = 'note {bad brace} {"snippet": "if (x) { return; }"}';
        expect(extractJsonObject(text)).toEqual({
            snippet: "if (x) { return; }",
        });
    });

    it("recovers an inner object from an unparseable outer brace span", () => {
        const text = '{ prose that opens a brace {"match": true} }';
        expect(extractJsonObject(text)).toEqual({match: true});
    });

    it.each([
        ["prose only", "sorry, here is prose instead of JSON"],
        ["empty", ""],
        ["unclosed object", '{"findings": ['],
        ["only unparseable braces", "use ${tenantId} and {foo} here"],
    ])("throws on %s", (_label, text) => {
        expect(() => extractJsonObject(text)).toThrow(
            /no parseable JSON object/,
        );
    });
});
