import {describe, it, expect} from "vitest";

import {extractJsonObject, extractJsonValue} from "./agent-json";

const PAYLOAD = {findings: [], hunts: [{hunt: "h1", state: "ran"}]};

describe("extractJsonValue", () => {
    it("parses a bare JSON object", () => {
        expect(extractJsonValue(JSON.stringify(PAYLOAD))).toEqual(PAYLOAD);
    });

    it("parses a bare JSON array", () => {
        expect(extractJsonValue('[{"a": 1}]')).toEqual([{a: 1}]);
    });

    it("tolerates surrounding whitespace", () => {
        expect(
            extractJsonValue(`\n\n  ${JSON.stringify(PAYLOAD)}  \n`),
        ).toEqual(PAYLOAD);
    });

    it("extracts the payload from prose followed by a json fence (the production correctness-reviewer shape)", () => {
        const text = [
            "Investigation complete. The wrapper batches at 500, so the",
            "commit-limit concern is refuted.",
            "",
            "```json",
            JSON.stringify(PAYLOAD, null, 2),
            "```",
        ].join("\n");
        expect(extractJsonValue(text)).toEqual(PAYLOAD);
    });

    it("extracts unfenced trailing JSON after prose (the production claim-validator shape)", () => {
        const text = [
            "All four claims are factually accurate and non-blocking:",
            "- **test-adequacy-1**: Confirmed.",
            "",
            JSON.stringify({claims: [{id: "x", verification: "confirmed"}]}),
        ].join("\n");
        expect(extractJsonValue(text)).toEqual({
            claims: [{id: "x", verification: "confirmed"}],
        });
    });

    it("prefers the last fence over an earlier quoted example", () => {
        const text = [
            "Per the contract:",
            "```json",
            '{"example": true}',
            "```",
            "Here is my actual result:",
            "```json",
            JSON.stringify(PAYLOAD),
            "```",
        ].join("\n");
        expect(extractJsonValue(text)).toEqual(PAYLOAD);
    });

    it("survives prose braces before the payload", () => {
        const text = `The {} literal and {"tiny": 1} appear in prose. ${JSON.stringify(
            PAYLOAD,
        )}`;
        // The longest parseable span wins, not the first.
        expect(extractJsonValue(text)).toEqual(PAYLOAD);
    });

    it("handles braces inside JSON strings", () => {
        const tricky = {note: 'a "}" inside a string { should not confuse'};
        expect(extractJsonValue(`prose ${JSON.stringify(tricky)}`)).toEqual(
            tricky,
        );
    });

    it("returns undefined on pure prose", () => {
        expect(extractJsonValue("no JSON here, just words")).toBeUndefined();
    });

    it("returns undefined on a bare primitive (no contract is a primitive)", () => {
        expect(extractJsonValue("42")).toBeUndefined();
        expect(extractJsonValue('"ok"')).toBeUndefined();
    });

    it("returns undefined on an unbalanced fragment", () => {
        expect(extractJsonValue('{"findings": [')).toBeUndefined();
    });
});

describe("extractJsonObject", () => {
    it("narrows to a plain object", () => {
        expect(extractJsonObject(JSON.stringify(PAYLOAD))).toEqual(PAYLOAD);
    });

    it("rejects a top-level array", () => {
        expect(extractJsonObject('[{"a": 1}]')).toBeUndefined();
    });

    it("finds the object when prose precedes it", () => {
        expect(
            extractJsonObject(`Result follows. ${JSON.stringify(PAYLOAD)}`),
        ).toEqual(PAYLOAD);
    });
});
