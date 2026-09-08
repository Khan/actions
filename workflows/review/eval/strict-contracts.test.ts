import {assert, describe, expect, it} from "vitest";

import {dedupeClaims} from "../lib/dedup";
import {anchorPathLine, type Claim} from "../lib/dispatch-contracts";
import type {Anchor} from "../lib/finding-schema";
import {createProseGate, type ProseRunner} from "../lib/judge-prose";
import {toCandidate} from "./runner";

describe("optional anchor fields", () => {
    it.each<{anchor: Anchor; location: {path?: string; line?: number}}>([
        {
            anchor: {type: "line", path: "a.ts", line: 1, side: "RIGHT"},
            location: {path: "a.ts", line: 1},
        },
        {anchor: {type: "file", path: "a.ts"}, location: {path: "a.ts"}},
        {anchor: {type: "pr"}, location: {}},
    ])(
        "omits unavailable fields on a $anchor.type anchor",
        ({anchor, location}) => {
            const candidate = toCandidate({
                source: "correctness",
                finding: {
                    schema_version: 2,
                    id: "finding",
                    lens: "correctness",
                    anchor,
                    severity: "advisory",
                    confidence: 0.9,
                    evidence_trace: ["a.ts:1"],
                    failure_scenario: "Empty input throws.",
                    producing_hunt: "test:anchor",
                    model_authored_prose: "Handle empty input.",
                },
            });
            expect(anchorPathLine(anchor)).toStrictEqual(location);
            for (const key of ["path", "line"] as const) {
                if (key in location) {
                    expect(candidate).toHaveProperty(key, location[key]);
                } else {
                    expect(candidate).not.toHaveProperty(key);
                }
            }
        },
    );
});

describe("dedup index invariants", () => {
    const claim = (id: string): Claim => ({
        id,
        source: id,
        path: "a.ts",
        line: 1,
        label: "suggestion (non-blocking)",
        subject: "Handle empty input before reading the first element.",
        discussion: "An empty array has no first element.",
        failure_scenario: "Reading the first element of an empty array throws.",
        confidence: 0.9,
    });

    it("handles an empty claim array even when a proposal names unknown ids", () => {
        expect(
            dedupeClaims([], [{ids: ["a", "b"], evidence: "array"}]),
        ).toEqual({
            claims: [],
            merges: [],
            clusterRejections: [
                {id: "a", reason: "unknown-id"},
                {id: "b", reason: "unknown-id"},
            ],
        });
    });

    it("leaves a singleton unchanged", () => {
        const only = claim("only");
        expect(dedupeClaims([only])).toEqual({
            claims: [only],
            merges: [],
            clusterRejections: [],
        });
    });

    it("keeps dispatch order as the tiebreak for a group spanning the whole array", () => {
        const claims = [claim("first"), claim("middle"), claim("last")];
        const result = dedupeClaims(claims);
        expect(result.claims.map((entry) => entry.id)).toEqual(["first"]);
        expect(result.merges).toMatchObject([
            {survivor: "first", merged: [{id: "middle"}, {id: "last"}]},
        ]);
        expect(result.clusterRejections).toEqual([]);
    });
});

describe("parallel prose verdicts", () => {
    it("keeps each verdict with its finding when calls finish in reverse order", async () => {
        const pending: ((reply: string) => void)[] = [];
        const runner: ProseRunner = () =>
            new Promise((resolve) => pending.push(resolve));
        const {gate, records} = createProseGate({
            runner,
            source: "correctness",
        });
        const result = gate({
            findings: ["first", "second"].map((id) => ({
                id,
                severity: "advisory",
                model_authored_prose: `${id} finding.`,
            })),
        });
        const [first, second] = pending;
        assert.isDefined(first);
        assert.isDefined(second);
        second('{"pass": false, "problems": ["too vague"]}');
        first('{"pass": true, "problems": []}');
        expect(await result).toContain("- second: too vague");
        expect(records.map(({key, state}) => ({key, state}))).toEqual([
            {key: "first", state: "pass"},
            {key: "second", state: "fail"},
        ]);
    });
});
