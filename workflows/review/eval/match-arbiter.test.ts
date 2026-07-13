import {describe, it, expect} from "vitest";

import {
    buildArbiterPrompt,
    parseArbiterAnswer,
    PINNED_ARBITER_MODEL,
} from "./match-arbiter";
import type {LiveDefectSpec} from "./corpus/loader";
import type {RunCandidate} from "./runner";

const candidate: RunCandidate = {
    id: "cand-1",
    source: "correctness",
    lens: "correctness",
    label: "issue (blocking)",
    blocking: true,
    anchor: {type: "line", path: "src/a.ts", line: 15, side: "RIGHT"},
    path: "src/a.ts",
    line: 15,
    body: "**issue (blocking):** no index",
    finding: {
        schema_version: 2,
        id: "cand-1",
        lens: "correctness",
        anchor: {type: "line", path: "src/a.ts", line: 15, side: "RIGHT"},
        severity: "blocking",
        confidence: 0.8,
        evidence_trace: ["e"],
        failure_scenario: "the hot query scans the whole table.",
        producing_hunt: "h",
        model_authored_prose: "Add an index or this will table-scan.",
    },
};

const spec: LiveDefectSpec = {
    key: "dm-1",
    path: "db/migration.sql",
    lineStart: 1,
    lineEnd: 5,
    mechanism: ["index", "table scan"],
    lens: "data-migrations",
};

describe("buildArbiterPrompt", () => {
    it("carries the spec location, mechanism, and the finding's own words", () => {
        const prompt = buildArbiterPrompt(candidate, spec);
        expect(prompt).toContain("db/migration.sql (lines 1-5)");
        expect(prompt).toContain("lens data-migrations");
        expect(prompt).toContain("index | table scan");
        expect(prompt).toContain("anchored at src/a.ts:15");
        expect(prompt).toContain("the hot query scans the whole table.");
        expect(prompt).toContain("Add an index or this will table-scan.");
        // The conservative bias is part of the contract: a false yes
        // inflates recall, the load-bearing metric.
        expect(prompt).toContain("If uncertain, answer false");
    });

    it("renders windowless specs and PR-level anchors without artifacts", () => {
        const prompt = buildArbiterPrompt(
            {
                ...candidate,
                anchor: {type: "pr"},
                path: undefined,
                line: undefined,
            },
            {key: "k", path: "src/a.ts", mechanism: ["m"]},
        );
        expect(prompt).toContain("in file src/a.ts.");
        expect(prompt).not.toContain("lines");
        expect(prompt).toContain("anchored at the PR");
    });
});

describe("parseArbiterAnswer", () => {
    it("accepts only an explicit true, everything else is a no", () => {
        expect(parseArbiterAnswer('{"match": true}')).toBe(true);
        expect(parseArbiterAnswer('Sure: {"match": true}; same defect.')).toBe(
            true,
        );
        expect(parseArbiterAnswer('{"match": false}')).toBe(false);
        expect(parseArbiterAnswer('{"match": "true"}')).toBe(false);
        expect(parseArbiterAnswer("yes")).toBe(false);
        expect(parseArbiterAnswer("")).toBe(false);
        expect(parseArbiterAnswer("{broken json")).toBe(false);
    });
});

describe("PINNED_ARBITER_MODEL", () => {
    it("stays on the pinned Haiku snapshot (operator direction)", () => {
        expect(PINNED_ARBITER_MODEL).toBe("claude-haiku-4-5-20251001");
    });
});
