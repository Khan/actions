import {describe, it, expect} from "vitest";

import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
    isBlockingLabel,
    labelForFinding,
    renderComment,
    renderReviewBody,
    type ReviewBodyInput,
} from "./render-comment.ts";
import {assertFinding, type Finding, type Lens} from "./finding-schema.ts";

/**
 * Rendering tests for R8(c) (TASK-2-4). The renderer sits on the determinism
 * boundary: CODE owns the label taxonomy + templated wrapping; MODELS own every
 * human-read sentence. These tests pin the deterministic label mapping and
 * snapshot the templated output so any drift in code-owned wrapping is caught,
 * while verifying model-authored prose/patches pass through verbatim.
 */

// Fixtures are run through the real schema validator so a rendering test can
// never pass against a finding the rest of the pipeline would reject.
const makeFinding = (overrides: Record<string, unknown> = {}): Finding =>
    assertFinding({
        schema_version: 1,
        id: "finding-1",
        lens: "security-auth",
        anchor: {type: "line", path: "src/app.ts", line: 42},
        severity: "blocking",
        confidence: 0.9,
        evidence_trace: ["src/app.ts:42 flows unsanitized input into exec()"],
        producing_hunt: "security-auth/command-injection",
        model_authored_prose:
            "User input flows unsanitized into a shell command.",
        ...overrides,
    });

describe("isBlockingLabel", () => {
    it.each([...BLOCKING_LABELS])("treats %s as blocking", (label) => {
        expect(isBlockingLabel(label)).toBe(true);
    });

    it.each([...NON_BLOCKING_LABELS])("treats %s as non-blocking", (label) => {
        expect(isBlockingLabel(label)).toBe(false);
    });

    it("treats an unknown label as non-blocking (safe default)", () => {
        expect(isBlockingLabel("praise (non-blocking)")).toBe(false);
        expect(isBlockingLabel("")).toBe(false);
    });
});

describe("labelForFinding — deterministic from severity + lens", () => {
    it("blocking + correctness lens -> issue (blocking)", () => {
        expect(labelForFinding(makeFinding({lens: "correctness"}))).toBe(
            "issue (blocking)",
        );
    });

    it("blocking + conventions (best-practice) lens -> issue (blocking, best-practice)", () => {
        expect(labelForFinding(makeFinding({lens: "conventions"}))).toBe(
            "issue (blocking, best-practice)",
        );
    });

    it("advisory + correctness lens -> suggestion (non-blocking)", () => {
        expect(
            labelForFinding(
                makeFinding({severity: "advisory", lens: "correctness"}),
            ),
        ).toBe("suggestion (non-blocking)");
    });

    it("advisory + conventions lens -> suggestion (non-blocking, best-practice)", () => {
        expect(
            labelForFinding(
                makeFinding({severity: "advisory", lens: "conventions"}),
            ),
        ).toBe("suggestion (non-blocking, best-practice)");
    });

    it("maps every specialist correctness lens to a plain (non-best-practice) label", () => {
        const specialist: Lens[] = [
            "security-auth",
            "money-payments",
            "concurrency-async",
            "data-migrations",
        ];
        for (const lens of specialist) {
            expect(labelForFinding(makeFinding({lens}))).toBe(
                "issue (blocking)",
            );
        }
    });
});

describe("renderComment — templated Conventional Comment", () => {
    it("renders a blocking finding with no suggested patch", () => {
        expect(renderComment(makeFinding())).toMatchInlineSnapshot(
            `"**issue (blocking):** User input flows unsanitized into a shell command."`,
        );
    });

    it("appends a verbatim ```suggestion block when a patch is present", () => {
        const finding = makeFinding({
            severity: "advisory",
            lens: "conventions",
            suggested_patch: "-  const x = 1\n+  const x = 2",
        });
        expect(renderComment(finding)).toMatchInlineSnapshot(`
          "**suggestion (non-blocking, best-practice):** User input flows unsanitized into a shell command.

          \`\`\`suggestion
          -  const x = 1
          +  const x = 2
          \`\`\`"
        `);
    });

    it("copies model-authored prose through verbatim (no synthesis/paraphrase)", () => {
        const prose =
            "This exact sentence — with an em-dash, `code`, and\na newline — must survive untouched.";
        const rendered = renderComment(
            makeFinding({model_authored_prose: prose}),
        );
        expect(rendered).toContain(prose);
    });

    it("copies a suggested patch through verbatim", () => {
        const patch = "-old line\n+new line";
        const rendered = renderComment(makeFinding({suggested_patch: patch}));
        expect(rendered).toContain(patch);
    });
});

describe("renderReviewBody — one non-empty line per verdict (+ notes)", () => {
    const body = (overrides: Partial<ReviewBodyInput>): string =>
        renderReviewBody({
            event: "APPROVE",
            hasInlineComments: false,
            ...overrides,
        });

    it("APPROVE without inline comments", () => {
        expect(
            body({event: "APPROVE", hasInlineComments: false}),
        ).toMatchInlineSnapshot(`"Approved — no blocking issues found."`);
    });

    it("APPROVE with inline comments", () => {
        expect(
            body({event: "APPROVE", hasInlineComments: true}),
        ).toMatchInlineSnapshot(`"Approved — see inline comments."`);
    });

    it("REQUEST_CHANGES", () => {
        expect(
            body({event: "REQUEST_CHANGES", hasInlineComments: true}),
        ).toMatchInlineSnapshot(`"Changes requested — see inline comments."`);
    });

    it("HOLD_FOR_HUMAN without inline comments", () => {
        expect(
            body({event: "HOLD_FOR_HUMAN", hasInlineComments: false}),
        ).toMatchInlineSnapshot(
            `"Holding for human review — automated review could not complete this run."`,
        );
    });

    it("HOLD_FOR_HUMAN with inline comments", () => {
        expect(
            body({event: "HOLD_FOR_HUMAN", hasInlineComments: true}),
        ).toMatchInlineSnapshot(
            `"Holding for human review — see inline comments."`,
        );
    });

    it("every branch returns a non-empty first line (safe-output contract)", () => {
        const events: ReviewBodyInput["event"][] = [
            "APPROVE",
            "REQUEST_CHANGES",
            "HOLD_FOR_HUMAN",
        ];
        for (const event of events) {
            for (const hasInlineComments of [true, false]) {
                const first = renderReviewBody({
                    event,
                    hasInlineComments,
                }).split("\n")[0];
                expect(first.length).toBeGreaterThan(0);
            }
        }
    });

    it("appends one skipped-dimension note line per entry", () => {
        expect(
            body({
                event: "APPROVE",
                hasInlineComments: false,
                skippedDimensions: [
                    {
                        dimension: "correctness",
                        subAgent: "correctness-reviewer",
                    },
                    {
                        dimension: "claim validation",
                        subAgent: "claim-validator",
                    },
                ],
            }),
        ).toMatchInlineSnapshot(`
          "Approved — no blocking issues found.
          Note: correctness not assessed this run (correctness-reviewer output unavailable).
          Note: claim validation not assessed this run (claim-validator output unavailable)."
        `);
    });
});
