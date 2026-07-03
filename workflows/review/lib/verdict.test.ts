import {describe, it, expect} from "vitest";

import {
    computeVerdict,
    DEFAULT_BLOCKING_THRESHOLD,
    type DimensionReport,
    type PolicyConflict,
    type VerdictInput,
} from "./verdict.ts";
import {BLOCKING_LABELS, NON_BLOCKING_LABELS} from "./render-comment.ts";

/**
 * Truth-table tests for the R8(b)/R2 computed verdict (TASK-2-4).
 *
 * `computeVerdict` is a pure function of (posted labels, dimension availability,
 * policy conflicts) with a documented precedence HOLD_FOR_HUMAN >
 * REQUEST_CHANGES > APPROVE. These tests pin every cell of that table, the
 * threshold clamping, the structured (prose-free) reasons, and purity.
 */

// All dimensions present — the common "nothing skipped" case. Tests clone +
// override this so a single axis is the only thing under test.
const allAssessed: DimensionReport = {
    correctness: "assessed",
    skillSeverity: "assessed",
    patternTriage: "assessed",
};

const BLOCKING = BLOCKING_LABELS[0]; // "issue (blocking)"
const NON_BLOCKING = NON_BLOCKING_LABELS[0]; // "suggestion (non-blocking)"

const makeInput = (overrides: Partial<VerdictInput> = {}): VerdictInput => ({
    postedLabels: [],
    dimensions: allAssessed,
    ...overrides,
});

describe("computeVerdict — APPROVE", () => {
    it("approves an empty, fully-assessed run", () => {
        const verdict = computeVerdict(makeInput());
        expect(verdict.event).toBe("APPROVE");
        expect(verdict.reasons).toEqual([]);
    });

    it("approves when only non-blocking labels are posted", () => {
        const verdict = computeVerdict(
            makeInput({postedLabels: [...NON_BLOCKING_LABELS]}),
        );
        expect(verdict.event).toBe("APPROVE");
        // No blocking labels -> no reasons recorded for a clean approve.
        expect(verdict.reasons).toEqual([]);
    });

    it("treats an unrecognised label as non-blocking (never blocks alone)", () => {
        const verdict = computeVerdict(
            makeInput({
                postedLabels: ["praise (non-blocking)", "totally-made-up"],
            }),
        );
        expect(verdict.event).toBe("APPROVE");
        expect(verdict.reasons).toEqual([]);
    });
});

describe("computeVerdict — REQUEST_CHANGES", () => {
    it("requests changes on a single blocking label (default threshold = 1)", () => {
        const verdict = computeVerdict(makeInput({postedLabels: [BLOCKING]}));
        expect(verdict.event).toBe("REQUEST_CHANGES");
        expect(verdict.reasons).toEqual([
            {code: "blocking-label", label: BLOCKING},
        ]);
    });

    it("records one blocking-label reason per blocking label", () => {
        const labels = [...BLOCKING_LABELS];
        const verdict = computeVerdict(makeInput({postedLabels: labels}));
        expect(verdict.event).toBe("REQUEST_CHANGES");
        expect(verdict.reasons).toEqual(
            labels.map((label) => ({code: "blocking-label", label})),
        );
    });

    it("counts only blocking labels amid a mixed set", () => {
        const verdict = computeVerdict(
            makeInput({postedLabels: [NON_BLOCKING, BLOCKING, NON_BLOCKING]}),
        );
        expect(verdict.event).toBe("REQUEST_CHANGES");
        expect(verdict.reasons).toEqual([
            {code: "blocking-label", label: BLOCKING},
        ]);
    });
});

describe("computeVerdict — HOLD_FOR_HUMAN (R2 core-dimension gate)", () => {
    it("holds when correctness is unavailable", () => {
        const verdict = computeVerdict(
            makeInput({
                dimensions: {...allAssessed, correctness: "unavailable"},
            }),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
        expect(verdict.reasons).toContainEqual({
            code: "core-dimension-unavailable",
            dimension: "correctness",
        });
    });

    it("holds when the skill/severity pass is unavailable", () => {
        const verdict = computeVerdict(
            makeInput({
                dimensions: {...allAssessed, skillSeverity: "unavailable"},
            }),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
        expect(verdict.reasons).toContainEqual({
            code: "core-dimension-unavailable",
            dimension: "skill-severity",
        });
    });

    it("records a reason for each missing core dimension", () => {
        const verdict = computeVerdict(
            makeInput({
                dimensions: {
                    correctness: "unavailable",
                    skillSeverity: "unavailable",
                    patternTriage: "assessed",
                },
            }),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
        expect(verdict.reasons).toEqual([
            {code: "core-dimension-unavailable", dimension: "correctness"},
            {code: "core-dimension-unavailable", dimension: "skill-severity"},
        ]);
    });

    it("hold dominates a blocking label, but still records the blocking reason", () => {
        const verdict = computeVerdict(
            makeInput({
                postedLabels: [BLOCKING],
                dimensions: {...allAssessed, correctness: "unavailable"},
            }),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
        // Nothing lost: both the blocking label and the gate are surfaced.
        expect(verdict.reasons).toContainEqual({
            code: "blocking-label",
            label: BLOCKING,
        });
        expect(verdict.reasons).toContainEqual({
            code: "core-dimension-unavailable",
            dimension: "correctness",
        });
    });
});

describe("computeVerdict — pattern-triage is note-and-continue (never holds)", () => {
    it("approves (does not hold) when only pattern-triage is unavailable", () => {
        const verdict = computeVerdict(
            makeInput({
                dimensions: {...allAssessed, patternTriage: "unavailable"},
            }),
        );
        expect(verdict.event).toBe("APPROVE");
        expect(verdict.reasons).toEqual([{code: "pattern-triage-unavailable"}]);
    });

    it("still requests changes on a blocking label with pattern-triage lost", () => {
        const verdict = computeVerdict(
            makeInput({
                postedLabels: [BLOCKING],
                dimensions: {...allAssessed, patternTriage: "unavailable"},
            }),
        );
        expect(verdict.event).toBe("REQUEST_CHANGES");
        expect(verdict.reasons).toContainEqual({
            code: "pattern-triage-unavailable",
        });
        expect(verdict.reasons).toContainEqual({
            code: "blocking-label",
            label: BLOCKING,
        });
    });
});

describe("computeVerdict — policy-named conflicts", () => {
    const conflict: PolicyConflict = {
        policy: "coppa-vs-personalization",
        detail: "COPPA data-minimization conflicts with the personalization rule.",
    };

    it("holds on a policy conflict and passes detail through verbatim", () => {
        const verdict = computeVerdict(
            makeInput({policyConflicts: [conflict]}),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
        expect(verdict.reasons).toEqual([
            {
                code: "policy-conflict",
                policy: conflict.policy,
                detail: conflict.detail,
            },
        ]);
    });

    it("records every policy conflict", () => {
        const second: PolicyConflict = {policy: "b", detail: "second detail"};
        const verdict = computeVerdict(
            makeInput({policyConflicts: [conflict, second]}),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
        expect(
            verdict.reasons.filter((r) => r.code === "policy-conflict"),
        ).toHaveLength(2);
    });

    it("hold (policy conflict) dominates a blocking label", () => {
        const verdict = computeVerdict(
            makeInput({postedLabels: [BLOCKING], policyConflicts: [conflict]}),
        );
        expect(verdict.event).toBe("HOLD_FOR_HUMAN");
    });
});

describe("computeVerdict — blocking threshold", () => {
    it("exposes the documented default of 1", () => {
        expect(DEFAULT_BLOCKING_THRESHOLD).toBe(1);
    });

    it("does not request changes below a raised threshold", () => {
        const verdict = computeVerdict(
            makeInput({postedLabels: [BLOCKING], blockingThreshold: 2}),
        );
        expect(verdict.event).toBe("APPROVE");
    });

    it("requests changes once the raised threshold is met", () => {
        const verdict = computeVerdict(
            makeInput({
                postedLabels: [BLOCKING_LABELS[0], BLOCKING_LABELS[1]],
                blockingThreshold: 2,
            }),
        );
        expect(verdict.event).toBe("REQUEST_CHANGES");
    });

    it.each([0, -5, 0.5])(
        "clamps a threshold below 1 (%p) back to 1",
        (threshold) => {
            const verdict = computeVerdict(
                makeInput({
                    postedLabels: [BLOCKING],
                    blockingThreshold: threshold,
                }),
            );
            expect(verdict.event).toBe("REQUEST_CHANGES");
        },
    );

    it("never requests changes with zero blocking labels, whatever the threshold", () => {
        const verdict = computeVerdict(
            makeInput({postedLabels: [NON_BLOCKING], blockingThreshold: 1}),
        );
        expect(verdict.event).toBe("APPROVE");
    });
});

describe("computeVerdict — purity", () => {
    it("is deterministic: equal inputs yield deeply-equal verdicts", () => {
        const input = makeInput({
            postedLabels: [BLOCKING, NON_BLOCKING],
            dimensions: {...allAssessed, patternTriage: "unavailable"},
        });
        expect(computeVerdict(input)).toEqual(computeVerdict(input));
    });

    it("does not mutate its input", () => {
        const labels = [BLOCKING];
        const dimensions: DimensionReport = {...allAssessed};
        const conflicts: PolicyConflict[] = [{policy: "p", detail: "d"}];
        computeVerdict({
            postedLabels: labels,
            dimensions,
            policyConflicts: conflicts,
        });
        expect(labels).toEqual([BLOCKING]);
        expect(dimensions).toEqual(allAssessed);
        expect(conflicts).toEqual([{policy: "p", detail: "d"}]);
    });
});
