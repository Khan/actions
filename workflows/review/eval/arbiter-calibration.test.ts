import {describe, expect, it} from "vitest";

import {
    distinctDecisionPoints,
    loadCalibrationSet,
    parseCalibrationSet,
    summarize,
    toCandidate,
    toSpec,
} from "./arbiter-calibration";
import {matchesSpec} from "./live-match";
import {buildArbiterPrompt} from "./match-arbiter";

describe("arbiter calibration set", () => {
    const set = loadCalibrationSet();

    it("carries the recorded drift-run accepts with their hand labels", () => {
        expect(set.sourceRun).toBe("29724668102");
        expect(set.pairs.length).toBe(10);
        // The triage found 4 of the 10 recorded accepts were wrong: three
        // off-by-one findings accepted for the dedup-window spec, one
        // unreachable-quotaExceeded finding accepted for the shared-key
        // spec. If this count changes, the labels changed; re-audit.
        const mismatches = set.pairs.filter((p) => p.label === "mismatch");
        expect(mismatches.length).toBe(4);
        expect(
            mismatches.filter((p) =>
                p.id.startsWith(
                    "golden-retention-lifecycle-2:retention-dedup-window-untested",
                ),
            ).length,
        ).toBe(3);
    });

    it("holds the fallback invariant: no pair matches deterministically", () => {
        // A pair the deterministic matcher already resolves never reaches
        // the arbiter, so it cannot calibrate the arbiter. NOTE: the
        // dedup-window pairs pin the spec AS RECORDED in the drift run
        // (pre-altLocations fix); the calibration set is a snapshot of what
        // the arbiter was actually asked, not a view of the live corpus.
        for (const pair of set.pairs) {
            expect(
                matchesSpec(toCandidate(pair), toSpec(pair)),
                `${pair.id} must not match deterministically`,
            ).toBe(false);
        }
    });

    it("feeds the real prompt builder (mechanism and finding text present)", () => {
        const pair = set.pairs[0]!;
        const prompt = buildArbiterPrompt(toCandidate(pair), toSpec(pair));
        expect(prompt).toContain(pair.spec.mechanism[0]!);
        expect(prompt).toContain(pair.candidate.failure_scenario);
        expect(prompt).toContain("If uncertain, answer false");
    });

    it("rejects malformed sets before any model spend", () => {
        expect(() => parseCalibrationSet({})).toThrow("missing pairs");
        expect(() => parseCalibrationSet({pairs: [{label: "maybe"}]})).toThrow(
            'must be "match" or "mismatch"',
        );
        // The guards protecting the paid live run from malformed recorded
        // data: a spec without mechanism alternates and a candidate without
        // its finding text.
        expect(() =>
            parseCalibrationSet({pairs: [{label: "match", spec: {}}]}),
        ).toThrow("missing mechanism alternates");
        expect(() =>
            parseCalibrationSet({
                pairs: [{label: "match", spec: {mechanism: []}, candidate: {}}],
            }),
        ).toThrow("missing finding text");
    });

    it("pools to 5 distinct decision points, not 10 independent pairs", () => {
        // The composite-key match repeats 4x and the dedup-window mismatch
        // 3x (same spec, same defect, re-sampled prose), so the effective N
        // behind the pooled rates is 2 mismatch and 3 match points; the CLI
        // prints these next to the rates so a reader weighs them correctly.
        const distinct = distinctDecisionPoints(loadCalibrationSet().pairs);
        expect(distinct).toEqual({match: 3, mismatch: 2});
    });
});

describe("summarize", () => {
    it("computes false-accept and false-reject rates from votes", () => {
        const summary = summarize([
            {id: "a", label: "mismatch", yes: 2, samples: 3},
            {id: "b", label: "mismatch", yes: 0, samples: 3},
            {id: "c", label: "match", yes: 3, samples: 3},
            {id: "d", label: "match", yes: 1, samples: 3},
        ]);
        expect(summary.falseAcceptRate).toBeCloseTo(2 / 6);
        expect(summary.falseRejectRate).toBeCloseTo(2 / 6);
        expect(summary.votes).toEqual({
            matchYes: 4,
            matchNo: 2,
            mismatchYes: 2,
            mismatchNo: 4,
        });
    });

    it("returns zero rates on an empty side rather than dividing by zero", () => {
        expect(summarize([]).falseAcceptRate).toBe(0);
        expect(summarize([]).falseRejectRate).toBe(0);
    });
});
